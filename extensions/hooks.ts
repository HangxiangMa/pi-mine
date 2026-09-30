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
 * Each hook command may set its own `"timeoutMs"` (default 15000); the child
 * process tree is killed if it runs longer.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { diagnosticsText, hasErrors, validateHooksConfig } from "./config/validation.ts";

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

type HooksConfig = Partial<Record<PiHookEvent, HookGroup[]>> & {
	version?: number;
	__error?: string;
};

export type HookCapability = {
	blocking: boolean;
	canModifyInput: boolean;
	canInjectContext: boolean;
	supportsAsync: boolean;
};

export const HOOK_CAPABILITIES: Record<PiHookEvent, HookCapability> = {
	session_start: {
		blocking: false,
		canModifyInput: false,
		canInjectContext: false,
		supportsAsync: true,
	},
	before_agent_start: {
		blocking: false,
		canModifyInput: false,
		canInjectContext: true,
		supportsAsync: true,
	},
	tool_call: { blocking: true, canModifyInput: true, canInjectContext: false, supportsAsync: true },
	tool_result: {
		blocking: false,
		canModifyInput: false,
		canInjectContext: false,
		supportsAsync: true,
	},
	session_before_compact: {
		blocking: false,
		canModifyInput: false,
		canInjectContext: false,
		supportsAsync: true,
	},
	session_compact: {
		blocking: false,
		canModifyInput: false,
		canInjectContext: false,
		supportsAsync: true,
	},
	session_compact_failed: {
		blocking: false,
		canModifyInput: false,
		canInjectContext: false,
		supportsAsync: true,
	},
	notification: {
		blocking: false,
		canModifyInput: false,
		canInjectContext: false,
		supportsAsync: true,
	},
	agent_settled: {
		blocking: false,
		canModifyInput: false,
		canInjectContext: false,
		supportsAsync: true,
	},
	session_shutdown: {
		blocking: false,
		canModifyInput: false,
		canInjectContext: false,
		supportsAsync: true,
	},
};

export interface HookRun {
	id: string;
	event: PiHookEvent;
	toolName?: string;
	pluginId?: string;
	startedAt: number;
	timeoutMs: number;
	status: "pending" | "completed" | "cancelled" | "timed_out" | "failed";
	stdout?: string;
	stderr?: string;
	outcome?: string;
}

export class HookRunRegistry {
	private readonly runs = new Map<string, HookRun>();
	start(event: PiHookEvent, timeoutMs: number, toolName?: string, pluginId?: string): HookRun {
		const run: HookRun = {
			id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
			event,
			toolName,
			pluginId,
			startedAt: Date.now(),
			timeoutMs,
			status: "pending",
		};
		this.runs.set(run.id, run);
		return run;
	}
	finish(id: string, status: HookRun["status"], outcome?: string): void {
		const run = this.runs.get(id);
		if (run) {
			run.status = status;
			run.outcome = outcome;
		}
	}
	snapshot(): HookRun[] {
		return [...this.runs.values()].map((run) => ({ ...run }));
	}
	clear(): void {
		this.runs.clear();
	}
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

function loadConfig(): HooksConfig {
	try {
		const raw = readFileSync(join(getAgentDir(), "hooks.json"), "utf-8");
		const parsed: unknown = JSON.parse(raw);
		const diagnostics = validateHooksConfig(parsed);
		if (hasErrors(diagnostics)) return { __error: diagnosticsText("hooks.json", diagnostics) };
		for (const warning of diagnostics.filter((item) => item.level === "warning"))
			console.warn(diagnosticsText("hooks.json", [warning]));
		return parsed as HooksConfig;
	} catch (error: unknown) {
		if (isMissingFile(error)) return {};
		return { __error: configError(error) };
	}
}

function isMissingFile(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function configError(error: unknown): string {
	if (error instanceof SyntaxError) return `invalid JSON (${error.message})`;
	if (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof error.code === "string"
	) {
		return `unable to read configuration (${error.code})`;
	}
	return "invalid or unreadable configuration";
}

const matcherCache = new Map<string, RegExp>();
function matches(matcher: string | undefined, subject: string | undefined): boolean {
	if (!matcher || matcher === "*") return true;
	if (subject === undefined) return false;
	let regex = matcherCache.get(matcher);
	if (!regex) {
		try {
			regex = new RegExp(`^(?:${matcher})$`);
			matcherCache.set(matcher, regex);
		} catch {
			return false;
		}
	}
	return regex.test(subject);
}

interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
	timedOut?: boolean;
	outputExceeded?: boolean;
}

function killTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
	try {
		if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
		else child.kill(signal);
	} catch {
		// already gone
	}
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
			child = spawn(command, {
				shell: true,
				detached: process.platform !== "win32",
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch {
			resolve({ code: -1, stdout: "", stderr: "hook process could not start" });
			return;
		}
		let stdout = "";
		let stderr = "";
		let outputBytes = 0;
		let outputExceeded = false;
		let timedOut = false;
		let settled = false;
		const timer =
			timeoutMs > 0
				? setTimeout(() => {
						timedOut = true;
						killTree(child, "SIGTERM");
						setTimeout(() => killTree(child, "SIGKILL"), 1000).unref();
					}, timeoutMs)
				: undefined;
		const done = (r: RunResult) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve({ ...r, timedOut: r.timedOut || timedOut, outputExceeded });
		};
		const capture = (stream: "stdout" | "stderr", b: Buffer) => {
			if (outputBytes >= MAX_OUTPUT_BYTES) {
				outputExceeded = true;
				return;
			}
			const remaining = MAX_OUTPUT_BYTES - outputBytes;
			const chunk = b.subarray(0, remaining);
			outputBytes += chunk.byteLength;
			if (chunk.byteLength < b.byteLength) outputExceeded = true;
			if (stream === "stdout") stdout += chunk.toString();
			else stderr += chunk.toString();
		};
		child.stdout?.on("data", (b: Buffer) => capture("stdout", b));
		child.stderr?.on("data", (b: Buffer) => capture("stderr", b));
		child.on("error", () => done({ code: -1, stdout: "", stderr: "hook process failed" }));
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

type HookDecision = {
	behavior?: "allow" | "deny" | "ask";
	reason?: string;
	updatedInput?: Record<string, unknown>;
};

/** Parse Claude's structured permission response without treating arbitrary stdout as approval. */
function hookDecision(result: RunResult): HookDecision {
	if (result.timedOut)
		return { behavior: "ask", reason: "hook timed out; confirmation is required" };
	if (result.outputExceeded) return { behavior: "deny", reason: "hook output exceeded 64 KiB" };
	if (result.code !== 0) {
		return { behavior: "deny", reason: result.stderr.trim() || "hook failed" };
	}
	try {
		const out = JSON.parse(result.stdout)?.hookSpecificOutput;
		if (!out || typeof out !== "object") return {};
		const behavior =
			out.permissionDecision === "allow" ||
			out.permissionDecision === "deny" ||
			out.permissionDecision === "ask"
				? out.permissionDecision
				: undefined;
		const updatedInput = sanitizeInput(out.updatedInput);
		return {
			behavior,
			reason:
				typeof out.permissionDecisionReason === "string" ? out.permissionDecisionReason : undefined,
			updatedInput,
		};
	} catch {
		return result.stdout.trim() ? { behavior: "deny", reason: "hook returned malformed JSON" } : {};
	}
}

function sanitizeInput(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const clean = (item: unknown): unknown => {
		if (Array.isArray(item)) return item.map(clean);
		if (!item || typeof item !== "object") return item;
		const result: Record<string, unknown> = {};
		for (const [key, nested] of Object.entries(item)) {
			if (
				key !== "__proto__" &&
				key !== "prototype" &&
				key !== "constructor" &&
				!key.startsWith("__pi")
			)
				result[key] = clean(nested);
		}
		return result;
	};
	return clean(value) as Record<string, unknown>;
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
			if (config.__error) return { block: true, reason: `invalid hooks.json: ${config.__error}` };
			const input = "input" in event ? (event.input as Record<string, unknown>) : {};
			const results = await runGroup(config.tool_call, event.toolName, {
				hook_event_name: "tool_call",
				claude_event_name: "PreToolUse",
				equivalence: "pi_tool_lifecycle_adapter",
				session_id: sessionId(ctx),
				cwd: ctx.cwd,
				tool_name: event.toolName,
				tool_input: input,
			});
			let asked: string | undefined;
			for (const r of results) {
				const decision = hookDecision(r);
				if (decision.updatedInput) Object.assign(input, decision.updatedInput);
				if (decision.behavior === "deny")
					return { block: true, reason: decision.reason ?? "blocked by hook" };
				if (decision.behavior === "ask")
					asked ??= decision.reason ?? "confirmation required by hook";
			}
			if (asked) return { block: true, reason: asked };
		} catch (error) {
			return {
				block: true,
				reason: `hook policy error: ${error instanceof Error ? error.message : String(error)}`,
			};
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
