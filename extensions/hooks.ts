/**
 * hooks — run external shell commands on pi lifecycle events, configured from
 * `~/.pi/agent/hooks.json` in the same shape as Claude Code's `hooks` setting,
 * so scripts like `claude/session-invariants.py` or a permission gate can be
 * pointed at pi too (subject to the tool-name caveat below).
 *
 * FILE (~/.pi/agent/hooks.json):
 *   {
 *     "tool_call": [
 *       { "matcher": "bash", "hooks": [{ "type": "command", "command": "python3 ~/.claude/read-guard.py" }] }
 *     ],
 *     "agent_settled": [
 *       { "hooks": [{ "type": "command", "command": "notify-send pi done" }] }
 *     ]
 *   }
 * Top-level keys are pi event names (see PiHookEvent below), each mapping to an
 * array of `{matcher?, hooks}` groups exactly like Claude's settings.json. A
 * missing `matcher` (or `"*"`) matches every call; otherwise it is a regex
 * tested against the event's subject (tool name for tool_call/tool_result, the
 * empty string is never a match). `hooks[].command` is a shell string, run via
 * `/bin/sh -c` with the event payload as JSON on stdin — same protocol Claude
 * Code uses, so most existing hook scripts need no changes to their stdin/stdout
 * handling, only to what they check in that JSON (see below).
 *
 * pi event -> Claude event adapter:
 *   session_start          -> SessionStart
 *   before_agent_start     -> UserPromptSubmit
 *   tool_call              -> PreToolUse   (can block: see denyReason)
 *   tool_result            -> PostToolUse
 *   session_before_compact -> PreCompact  (blocking equivalent; see below)
 *   session_compact        -> PostCompact success notification
 *   session_compact_failed -> PostCompact failure notification
 *   agent_settled          -> Stop + Notification(completed)
 *   ui_prompt_start/end    -> Notification(waiting/ready)
 *   session_shutdown       -> SessionEnd
 *
 * `session_before_compact` is the closest Pi equivalent to Claude PreCompact:
 * it runs before Pi compaction and exposes the same hook stdin protocol, but it
 * cannot replace/append Pi's compaction prompt. `notification` is a normalized
 * adapter for Pi's waiting/ready/completed lifecycle; Pi has no generic Claude
 * Notification event for arbitrary transient messages. Payloads include
 * `claude_event_name` and `equivalence` so consumers cannot mistake this
 * adapter for a one-to-one internal API mapping.
 *
 * TOOL NAMES ARE NOT TRANSLATED. `tool_name` in the payload is pi's own lowercase
 * name (`bash`, `read`, `edit`, `write`, `grep`, `find`, `ls`, or a custom tool's
 * own name like `subagent_routed`), never Claude's PascalCase (`Bash`, `Read`,
 * ...). A script like `claude/read-guard.py`, whose `verdict()` checks
 * `tool == "Read"`, will silently never fire unless its check (or this file's
 * matcher) is updated to `"read"`. Inventing a partial PascalCase table for only
 * the tools that happen to overlap was judged worse than one clear rule.
 *
 * PROTOCOL for tool_call (the one blocking event): a hook can deny either the
 * way Claude's older hooks do (exit code 2, stderr is the reason) or the way
 * `read-guard.py`/`subagent-model-router.py` do (exit 0, stdout JSON
 * `{hookSpecificOutput: {permissionDecision: "deny", permissionDecisionReason}}`).
 * Anything else (exit 0, no such JSON, `permissionDecision: "allow"`) is read as
 * no opinion, matching `tool_call`'s own no-return-means-continue contract.
 * `before_agent_start` reads the UserPromptSubmit shape
 * (`hookSpecificOutput.additionalContext`) and appends it to the system prompt —
 * pi has no separate "inject a context message" channel for this event, so a
 * script written for `additionalContext` needs no change, but the effect lands
 * as `systemPrompt` growth rather than a distinct context entry.
 *
 * WHY try/catch wraps the tool_call branch specifically: `tool_call` is the one
 * pi event the runtime does NOT wrap in try/catch (`runner.js` emitToolCall) — an
 * uncaught throw there is re-raised as a hard "Extension failed, blocking
 * execution", so this extension must fail open on its own, same discipline as
 * `permissions.ts` and `claude/read-guard.py`. Every other pi.on() branch here is
 * wrapped anyway, defensively, since a hung or crashing child process must never
 * take the session down with it.
 *
 * CONFIG (env):
 *   PI_HOOKS_OFF=1   disable entirely.
 * Each hook command may set its own `"timeoutMs"` (default 60000, matching
 * Claude's own hook default); the child is killed if it runs longer.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type PiHookEvent =
	| "session_start"
	| "before_agent_start"
	| "tool_call"
	| "tool_result"
	| "session_before_compact"
	| "session_compact"
	| "session_compact_failed"
	| "notification"
	| "agent_settled"
	| "session_shutdown";

interface HookCommand {
	type: "command";
	command: string;
	timeoutMs?: number;
}

interface HookGroup {
	matcher?: string;
	hooks: HookCommand[];
}

type HooksConfig = Partial<Record<PiHookEvent, HookGroup[]>>;

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

function loadConfig(): HooksConfig {
	try {
		const raw = readFileSync(join(getAgentDir(), "hooks.json"), "utf-8");
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? (parsed as HooksConfig) : {};
	} catch {
		return {};
	}
}

function matches(matcher: string | undefined, subject: string | undefined): boolean {
	if (!matcher || matcher === "*") return true;
	if (subject === undefined) return false;
	try {
		return new RegExp(`^(?:${matcher})$`).test(subject);
	} catch {
		return matcher === subject;
	}
}

interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "null";
	} catch {
		return "null";
	}
}

/** Spawn one shell command, feed it `payload` on stdin, cap captured output, enforce a deadline. */
function runCommand(
	command: string,
	payload: Record<string, unknown>,
	timeoutMs: number,
): Promise<RunResult> {
	const body = safeStringify(payload);
	return new Promise((resolve) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, { shell: true, stdio: ["pipe", "pipe", "pipe"] });
		} catch {
			resolve({ code: 0, stdout: "", stderr: "" });
			return;
		}
		let stdout = "";
		let stderr = "";
		let settled = false;
		const timer =
			timeoutMs > 0
				? setTimeout(() => {
						try {
							child.kill();
						} catch {
							// already gone
						}
					}, timeoutMs)
				: undefined;
		const done = (r: RunResult) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve(r);
		};
		child.stdout?.on("data", (b: Buffer) => {
			if (stdout.length < MAX_OUTPUT_BYTES) stdout += b.toString();
		});
		child.stderr?.on("data", (b: Buffer) => {
			if (stderr.length < MAX_OUTPUT_BYTES) stderr += b.toString();
		});
		child.on("error", () => done({ code: 0, stdout: "", stderr: "" }));
		child.on("close", (code) => done({ code: code ?? 0, stdout, stderr }));
		child.stdin?.on("error", () => {
			// close still resolves this promise
		});
		try {
			child.stdin?.end(body);
		} catch {
			// child died before stdin was writable; close/error resolves
		}
	});
}

/** -> the deny reason if a PreToolUse-shaped result says deny, else undefined. */
function denyReason(result: RunResult): string | undefined {
	if (result.code === 2) {
		return result.stderr.trim() || "blocked by hook (exit 2)";
	}
	try {
		const parsed = JSON.parse(result.stdout);
		const out = parsed?.hookSpecificOutput;
		if (out?.permissionDecision === "deny") {
			return typeof out.permissionDecisionReason === "string"
				? out.permissionDecisionReason
				: "blocked by hook";
		}
	} catch {
		// stdout wasn't the JSON shape - no opinion
	}
	return undefined;
}

/** -> additionalContext text from a UserPromptSubmit-shaped result, if any. */
function additionalContext(result: RunResult): string | undefined {
	try {
		const parsed = JSON.parse(result.stdout);
		const ctx = parsed?.hookSpecificOutput?.additionalContext;
		return typeof ctx === "string" && ctx ? ctx : undefined;
	} catch {
		return undefined;
	}
}

function sessionId(ctx: ExtensionContext): string {
	try {
		return ctx.sessionManager.getSessionId() ?? "";
	} catch {
		return "";
	}
}

async function runGroup(
	groups: HookGroup[] | undefined,
	subject: string | undefined,
	payload: Record<string, unknown>,
): Promise<RunResult[]> {
	if (!groups) return [];
	const results: RunResult[] = [];
	for (const group of groups) {
		if (!matches(group.matcher, subject)) continue;
		for (const cmd of group.hooks) {
			if (cmd?.type !== "command" || typeof cmd.command !== "string" || !cmd.command) continue;
			results.push(await runCommand(cmd.command, payload, cmd.timeoutMs ?? DEFAULT_TIMEOUT_MS));
		}
	}
	return results;
}

export default function hooks(pi: ExtensionAPI) {
	if (process.env.PI_HOOKS_OFF === "1") return;

	let config: HooksConfig = loadConfig();

	pi.on("session_start", async (event, ctx) => {
		config = loadConfig();
		try {
			await runGroup(config.session_start, undefined, {
				hook_event_name: "session_start",
				claude_event_name: "SessionStart",
				equivalence: "pi_lifecycle_adapter",
				session_id: sessionId(ctx),
				cwd: ctx.cwd,
				source: event.reason,
			});
		} catch {
			// fail open
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			const results = await runGroup(config.before_agent_start, undefined, {
				hook_event_name: "before_agent_start",
				claude_event_name: "UserPromptSubmit",
				equivalence: "pi_lifecycle_adapter",
				session_id: sessionId(ctx),
				cwd: ctx.cwd,
				prompt: event.prompt,
			});
			const extra = results.map(additionalContext).filter((x): x is string => !!x);
			if (extra.length) {
				return { systemPrompt: `${event.systemPrompt}\n\n${extra.join("\n\n")}` };
			}
		} catch {
			// fail open
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		try {
			const results = await runGroup(config.tool_call, event.toolName, {
				hook_event_name: "tool_call",
				claude_event_name: "PreToolUse",
				equivalence: "pi_tool_lifecycle_adapter",
				session_id: sessionId(ctx),
				cwd: ctx.cwd,
				tool_name: event.toolName,
				tool_input: "input" in event ? (event.input as Record<string, unknown>) : {},
			});
			for (const r of results) {
				const reason = denyReason(r);
				if (reason) return { block: true, reason };
			}
		} catch {
			// fail open - tool_call is the one event pi does not try/catch itself
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		try {
			await runGroup(config.tool_result, event.toolName, {
				hook_event_name: "tool_result",
				claude_event_name: "PostToolUse",
				equivalence: "pi_tool_lifecycle_adapter",
				session_id: sessionId(ctx),
				cwd: ctx.cwd,
				tool_name: event.toolName,
				tool_input: event.input,
				tool_response: { is_error: event.isError },
			});
		} catch {
			// fail open
		}
	});

	pi.on("session_before_compact", async (event, ctx) => {
		try {
			await runGroup(config.session_before_compact, undefined, {
				hook_event_name: "session_before_compact",
				claude_event_name: "PreCompact",
				equivalence: "closest_pi_lifecycle_equivalent",
				session_id: sessionId(ctx),
				cwd: ctx.cwd,
				reason: event.reason,
				will_retry: event.willRetry,
				branch_entry_count: event.branchEntries.length,
				first_kept_entry_id: event.preparation.firstKeptEntryId,
				is_split_turn: event.preparation.isSplitTurn,
				tokens_before: event.preparation.tokensBefore,
				file_operations: event.preparation.fileOps,
				custom_instructions: event.customInstructions,
			});
		} catch {
			// fail open: compaction must continue if a hook fails
		}
	});

	pi.on("session_compact", async (event, ctx) => {
		try {
			await runGroup(config.session_compact, undefined, {
				hook_event_name: "session_compact",
				claude_event_name: "PostCompact",
				equivalence: "closest_pi_lifecycle_equivalent",
				session_id: sessionId(ctx),
				cwd: ctx.cwd,
				reason: event.reason,
				will_retry: event.willRetry,
				from_extension: event.fromExtension,
				compaction_summary: event.compactionEntry.summary,
			});
		} catch {
			// fail open
		}
	});

	pi.on("session_compact_failed", async (event, ctx) => {
		try {
			await runGroup(config.session_compact_failed, undefined, {
				hook_event_name: "session_compact_failed",
				claude_event_name: "PostCompact",
				equivalence: "closest_pi_lifecycle_equivalent",
				session_id: sessionId(ctx),
				cwd: ctx.cwd,
				reason: event.reason,
				aborted: event.aborted,
				will_retry: event.willRetry,
				from_extension: event.fromExtension,
				error_message: event.errorMessage,
			});
		} catch {
			// fail open
		}
	});

	pi.on("ui_prompt_start", async (event, ctx) => {
		try {
			await runGroup(config.notification, event.kind, {
				hook_event_name: "notification",
				claude_event_name: "Notification",
				equivalence: "normalized_pi_lifecycle_adapter",
				notification_type: "waiting",
				session_id: sessionId(ctx),
				cwd: ctx.cwd,
				prompt_kind: event.kind,
				title: event.title,
			});
		} catch {
			// fail open
		}
	});

	pi.on("ui_prompt_end", async (event, ctx) => {
		try {
			await runGroup(config.notification, event.kind, {
				hook_event_name: "notification",
				claude_event_name: "Notification",
				equivalence: "normalized_pi_lifecycle_adapter",
				notification_type: "ready",
				session_id: sessionId(ctx),
				cwd: ctx.cwd,
				prompt_kind: event.kind,
				title: event.title,
			});
		} catch {
			// fail open
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		try {
			await runGroup(config.agent_settled, undefined, {
				hook_event_name: "agent_settled",
				claude_event_name: "Stop",
				equivalence: "composed_pi_lifecycle_adapter",
				session_id: sessionId(ctx),
				cwd: ctx.cwd,
			});
			await runGroup(config.notification, "completed", {
				hook_event_name: "notification",
				claude_event_name: "Notification",
				equivalence: "normalized_pi_lifecycle_adapter",
				notification_type: "completed",
				session_id: sessionId(ctx),
				cwd: ctx.cwd,
			});
		} catch {
			// fail open
		}
	});

	pi.on("session_shutdown", async (event, ctx) => {
		try {
			await runGroup(config.session_shutdown, undefined, {
				hook_event_name: "session_shutdown",
				claude_event_name: "SessionEnd",
				equivalence: "pi_lifecycle_adapter",
				session_id: sessionId(ctx),
				cwd: ctx.cwd,
				reason: event.reason,
			});
		} catch {
			// fail open
		}
	});
}
