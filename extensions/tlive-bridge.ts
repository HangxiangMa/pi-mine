/**
 * tlive-bridge — puts a pi session on the tlive dashboard, with a working
 * remote reply channel, without patching tlive.
 *
 * WHY: tlive ships hook plugins for Claude Code and Codex only; its
 * `HookVendor` is a closed union and it has no agent-adapter interface. But its
 * ingest surface is not the plugin — it is the CLI: `tlive hook <event>` reads a
 * Claude-shaped JSON payload on stdin and talks to the daemon over its own IPC
 * socket. Anything that can spawn a process and write JSON can therefore feed
 * the same dashboard. That is what this extension does, so `pi` gains the same
 * remote status + reply capability as Claude Code with zero tlive changes and no
 * `tmux send-keys` injection layer.
 *
 * The reply protocol (tlive/dist/src/tlive-cli.mjs, runHook, `stop` branch):
 *   - `tlive hook stop` blocks until someone replies in the browser, or the
 *     continue-window expires;
 *   - a reply is written to the child's STDERR with exit code 2;
 *   - no reply means exit 0 and no output.
 * So: spawn it, and if the exit code is 2, the stderr text is the user's reply,
 * which we hand to `pi.sendUserMessage()` — pi's documented programmatic
 * user-message path. No PTY and no keystroke injection anywhere.
 *
 * HOW (pi event -> tlive hook event):
 *   session_start        -> session-start
 *   input                -> user-prompt-submit   (prompt text; non-blocking)
 *   tool_execution_end   -> post-tool-use        (keeps the card's activity live)
 *   agent_settled        -> stop                 (the reply channel; see below)
 *   session_shutdown     -> session-end
 *   tool_call            -> permission-request    (opt-in, blocks: see CONFIG)
 *
 * `agent_settled` rather than `agent_end`: pi's own docs say `agent_end` may
 * still be followed by an auto-retry, an auto-compaction, or a queued follow-up,
 * while `agent_settled` means pi will not continue on its own. That is exactly
 * Claude Code's `Stop` semantics, so the cards match across vendors.
 *
 * WHY THE STOP HOOK IS NOT AWAITED: pi awaits event handlers, and
 * `tlive hook stop` deliberately blocks for the whole continue-window (up to
 * ~30 min). Awaiting it inside the handler would freeze the local TUI for that
 * long. So the child is started and the handler returns immediately; the reply
 * is delivered whenever it arrives. If the user answers locally first, the next
 * `agent_start` kills the outstanding child so the browser card stops offering a
 * reply that would arrive out of order.
 *
 * Killing that child is not enough on its own, because two races follow from it:
 * a kill is a no-op against a child that already exited with a reply, and a
 * newly spawned child can be retired by the *previous* child's late `close`.
 * Both are settled by a generation counter rather than by the handle alone:
 * every spawn takes the next `stopGen`, every cancel burns one, and a reply is
 * dropped unless its generation is still current. Without that, a reply lands in
 * a turn the user started meanwhile.
 *
 * KNOWN GAP (tlive side, not fixable here): killing the child does not tell the
 * daemon to drop the request — `hook.continue.request` has no disconnect
 * handling, unlike the permission path's `onAbandoned`. So after you answer
 * locally the browser card keeps a live reply box until tlive's own
 * continue-window expires, and a reply typed into it is written to a dead socket
 * and silently discarded. Answer locally *or* remotely, not both.
 *
 * SCOPE: interactive parent sessions only (ctx.mode "tui" / "rpc"). In "json" /
 * "print" child sessions — the subagents that subagent-model-router dispatches —
 * everything is skipped, so the dashboard shows one card per real session
 * instead of one per subagent. Fail-open throughout: if tlive is missing, the
 * daemon is down, or any spawn fails, pi behaves exactly as if this file were
 * absent.
 *
 * BONUS, no code required: launched through `tl pgen` (see bash/aliases.sh),
 * `tlive run` owns the PTY and exports TLIVE_SESSION. Our children inherit it,
 * `runHook` forwards it as `wrappedId`, and the terminal view and the hook
 * status/reply channel collapse into ONE dashboard card for the same session.
 *
 * CONFIG (env):
 *   PI_TLIVE_OFF=1         disable entirely (subscribe to nothing).
 *   PI_TLIVE_APPROVALS=1   also route tool_call through `tlive hook
 *                          permission-request`, so tool approvals can be
 *                          answered from the browser. OFF by default because it
 *                          BLOCKS the tool until someone answers (or tlive's
 *                          approval window expires) — only useful together with
 *                          `tlive mode full`.
 *   PI_TLIVE_BIN=tlive     tlive executable to spawn.
 *   PI_TLIVE_APPROVAL_TIMEOUT_SEC=90
 *                          how long a browser approval may block one tool
 *                          before we give up and hand it to pi's own prompt.
 *                          tlive's own window is ~24 h (`windowSec ?? 86200`),
 *                          which would wedge the tool for a day, and pi cannot
 *                          release it with Esc because that path ignores the
 *                          abort signal. So we impose our own deadline.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";

const OFF = process.env.PI_TLIVE_OFF === "1";
const APPROVALS = process.env.PI_TLIVE_APPROVALS === "1";
const BIN = process.env.PI_TLIVE_BIN || "tlive";
/** Deadline for the one hook that blocks pi. 0 disables the deadline. */
const APPROVAL_TIMEOUT_MS = (() => {
	const n = Number(process.env.PI_TLIVE_APPROVAL_TIMEOUT_SEC ?? 90);
	return Number.isFinite(n) && n >= 0 ? n * 1000 : 90_000;
})();

/** Modes that are a real, user-facing session rather than a dispatched subagent. */
const INTERACTIVE_MODES = new Set(["tui", "rpc"]);

type HookResult = { code: number; stdout: string; stderr: string };

/**
 * JSON, but never throws. A tool result carrying a circular reference or a
 * BigInt would otherwise take down whichever handler is serialising it — and on
 * the `tool_call` path that means blocking the tool, since pi treats a throw
 * there as "extension failed, blocking execution".
 */
function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "null";
	} catch {
		try {
			return JSON.stringify(String(value));
		} catch {
			return '"[unserialisable]"';
		}
	}
}

/**
 * The reply is whatever tlive wrote to stderr, but stderr is shared: node's own
 * warnings from the child land there too and would be injected verbatim as part
 * of the user's message. Drop the lines that are unmistakably node's.
 */
function replyText(stderr: string): string {
	return stderr
		.split("\n")
		.filter((l) => !/^\(node:\d+\)/.test(l) && !/^\(Use `node /.test(l))
		.join("\n")
		.trim();
}

/**
 * Spawn `tlive hook <event>` and write `payload` to its stdin.
 *
 * `onChild` hands the process back to the caller so a long-lived hook (`stop`,
 * `permission-request`) can be killed if it is overtaken by local input.
 * Never rejects: a missing binary or a dead daemon resolves as code 0.
 */
function tliveHook(
	event: string,
	payload: Record<string, unknown>,
	onChild?: (child: ChildProcess) => void,
): Promise<HookResult> {
	// Serialise BEFORE spawning. Doing it after would, on a payload JSON cannot
	// represent, skip `stdin.end()` and leave the child blocked on EOF forever —
	// and this promise unsettled, which hangs whichever handler awaited it.
	const body = safeStringify(payload);
	return new Promise((resolve) => {
		let child: ChildProcess;
		try {
			child = spawn(BIN, ["hook", event], {
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch {
			resolve({ code: 0, stdout: "", stderr: "" });
			return;
		}
		let stdout = "";
		let stderr = "";
		let settled = false;
		const done = (r: HookResult) => {
			if (settled) return;
			settled = true;
			resolve(r);
		};
		child.stdout?.on("data", (b: Buffer) => {
			stdout += b.toString();
		});
		child.stderr?.on("data", (b: Buffer) => {
			stderr += b.toString();
		});
		child.on("error", () => done({ code: 0, stdout: "", stderr: "" }));
		child.on("close", (code) => done({ code: code ?? 0, stdout, stderr }));
		// A stream `error` with no listener is thrown as an uncaught exception and
		// kills pi. That is not hypothetical: tlive short-circuits some events
		// (`mode off`, and permission-request unless the mode is `full`) and
		// returns BEFORE reading stdin, so any payload larger than the pipe buffer
		// EPIPEs — measured to start biting somewhere between 70 KB and 200 KB,
		// which a single `read` of a big file clears easily.
		child.stdin?.on("error", () => {
			// Nothing to do: `close` still resolves this promise.
		});
		try {
			child.stdin?.end(body);
		} catch {
			// The child died before stdin was writable; `close`/`error` resolves.
		}
		onChild?.(child);
	});
}

/** Fields every tlive hook payload needs. `parseHookInput` reads snake_case. */
function base(ctx: ExtensionContext): Record<string, unknown> {
	let sessionId = "";
	try {
		sessionId = ctx.sessionManager.getSessionId() ?? "";
	} catch {
		// Ephemeral session: tlive keys the card on cwd alone, which is fine.
	}
	return { session_id: sessionId, cwd: ctx.cwd };
}

/** Best-effort plain text of an assistant message, for the card's preview line. */
function assistantText(message: unknown): string | undefined {
	const content = (message as { content?: unknown } | undefined)?.content;
	if (typeof content === "string") return content.trim() || undefined;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.filter((b): b is { type: string; text: string } => {
			const t = b as { type?: unknown; text?: unknown };
			return t?.type === "text" && typeof t.text === "string";
		})
		.map((b) => b.text)
		.join("\n")
		.trim();
	return text || undefined;
}

export default function (pi: ExtensionAPI) {
	if (OFF) return;

	/** Set once session_start confirms this is an interactive parent. */
	let active = false;
	/** Latest assistant text, for `last_assistant_message` on the stop hook. */
	let lastAssistant: string | undefined;
	/** The outstanding `tlive hook stop` child, if one is waiting for a reply. */
	let pendingStop: ChildProcess | undefined;
	/**
	 * Generation of the current stop hook. Bumped on every spawn and every
	 * cancel, so a reply from a child that has since been superseded or retired
	 * is recognised as stale and dropped instead of being injected into whatever
	 * turn is running by then.
	 *
	 * NOTE: there is deliberately no `stop_hook_active` mirror here. Claude Code
	 * needs that flag because its Stop hook can re-fire without a turn having
	 * run. `pi.sendUserMessage()` always triggers a turn, so the spin it guards
	 * against cannot happen — while the flag itself could wedge the channel for
	 * good: a reply delivered as `followUp` is drained inside the *same* agent
	 * run and emits no `agent_start`, so nothing would ever clear it, and every
	 * later `agent_settled` would ship `stop_hook_active: true`, which tlive
	 * answers by returning before it ever opens a reply window.
	 */
	let stopGen = 0;

	const cancelPendingStop = () => {
		stopGen++;
		if (!pendingStop) return;
		const child = pendingStop;
		pendingStop = undefined;
		try {
			child.kill();
		} catch {
			// Already gone.
		}
	};

	pi.on("session_start", async (event, ctx) => {
		active = INTERACTIVE_MODES.has(ctx.mode);
		if (!active) return;
		lastAssistant = undefined;
		await tliveHook("session-start", {
			...base(ctx),
			// pi's reasons are startup | reload | new | resume | fork; tlive passes
			// `source` through untouched, so they need no translation.
			source: (event as { reason?: string }).reason ?? "startup",
		});
	});

	pi.on("input", async (event, ctx) => {
		// Report the prompt, including replies we injected ourselves — seeing the
		// reply land is the confirmation that the remote channel worked. This hook
		// never blocks, so it cannot feed back into a loop.
		if (active) {
			const text = (event as { text?: string }).text ?? "";
			void tliveHook("user-prompt-submit", { ...base(ctx), prompt: text });
		}
		return { action: "continue" as const };
	});

	// A run has begun: any reply still being waited on in the browser would now
	// arrive out of order, so retire it. Also drop the previous turn's assistant
	// text, or a turn that produces none (aborted with Esc, errored, ended on a
	// tool) would leave the stop card advertising the turn *before* it as this
	// turn's answer — and the remote reader would answer the wrong question.
	pi.on("agent_start", async () => {
		lastAssistant = undefined;
		cancelPendingStop();
	});

	pi.on("turn_end", async (event) => {
		const text = assistantText((event as { message?: unknown }).message);
		if (text) lastAssistant = text;
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if (!active) return;
		const e = event as { toolName?: string; result?: unknown; isError?: boolean };
		const tool = e.toolName ?? "(unknown)";
		if (e.isError) {
			// A failure is an attention event on the dashboard, not activity, so
			// send it down the failure hook instead.
			void tliveHook("post-tool-use-failure", {
				...base(ctx),
				tool_name: tool,
				// safeStringify, not JSON.stringify: this call sits outside
				// tliveHook's guard, so a circular tool result would reject the
				// handler and surface an extension error in the TUI.
				error: typeof e.result === "string" ? e.result : safeStringify(e.result ?? ""),
			});
			return;
		}
		void tliveHook("post-tool-use", {
			...base(ctx),
			tool_name: tool,
			tool_response: e.result ?? {},
		});
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!active) return;
		cancelPendingStop();

		const payload: Record<string, unknown> = {
			...base(ctx),
			...(lastAssistant ? { last_assistant_message: lastAssistant } : {}),
		};

		// cancelPendingStop above already burned a generation, so this spawn takes
		// the next one and any older child's reply is now stale.
		const gen = ++stopGen;
		// Deliberately NOT awaited — see the header. The handler returns now; the
		// reply is delivered whenever the browser sends one.
		void tliveHook("stop", payload, (child) => {
			pendingStop = child;
		}).then(async ({ code, stderr }) => {
			// Only clear the handle if it is still ours. An unconditional clear
			// would let this child's late `close` orphan a NEWER pending child,
			// which no `agent_start` could then retire.
			if (stopGen === gen) pendingStop = undefined;
			// Exit 2 + stderr is tlive's "the user replied" signal. Anything else
			// (timeout, no reply, tlive absent) means there is nothing to do.
			if (code !== 2) return;
			// A kill loses to a child that had already exited with a reply, so the
			// generation, not the handle, is what decides whether this reply is
			// still wanted.
			if (stopGen !== gen) return;
			const reply = replyText(stderr);
			if (!reply) return;
			try {
				// `deliverAs` is required while streaming; if the user got there
				// first and a run is live, queue the reply behind it instead of
				// throwing. followUp waits for all tools to finish.
				const idle = ctx.isIdle();
				await pi.sendUserMessage(reply, idle ? undefined : { deliverAs: "followUp" });
			} catch {
				// pi refused the message (session gone, shutting down). Nothing to
				// retry against, and tlive has already reported it as delivered.
			}
		});
	});

	// Opt-in remote tool approval. Blocks the tool, so it is off unless asked for.
	if (APPROVALS) {
		pi.on("tool_call", async (event, ctx) => {
			if (!active) return;
			// `tool_call` is the ONE handler pi does not wrap: a throw here is
			// re-raised as "Extension failed, blocking execution", so the whole
			// body is guarded and every failure path falls through to pi's own
			// approval prompt.
			try {
				return await remoteApproval(event, ctx);
			} catch {
				return;
			}
		});

		/** Body of the tool_call handler. Returns a block, or nothing. */
		async function remoteApproval(
			event: unknown,
			ctx: ExtensionContext,
		): Promise<{ block: true; reason: string } | undefined> {
			const e = event as { toolName?: string; input?: Record<string, unknown> };
			// Bound the wait ourselves and release on abort: tlive would hold this
			// tool for ~24 h, and this path cannot otherwise be released with Esc.
			let child: ChildProcess | undefined;
			let timer: ReturnType<typeof setTimeout> | undefined;
			let escape: (() => void) | undefined;
			// Killing the child is not sufficient to end the wait: `close` fires
			// only once the stdio pipes reach EOF, and anything the child left
			// behind still holds them (a shell wrapper's own children do exactly
			// that). So the deadline RACES the hook instead of relying on the kill.
			const release = () => {
				try {
					child?.kill();
				} catch {
					// Already gone.
				}
				escape?.();
			};
			const signal = (ctx as { signal?: AbortSignal }).signal;
			signal?.addEventListener("abort", release, { once: true });
			let stdout = "";
			try {
				const hook = tliveHook(
					"permission-request",
					{
						...base(ctx),
						tool_name: e.toolName ?? "(unknown)",
						tool_input: e.input ?? {},
					},
					(c) => {
						child = c;
						if (signal?.aborted) release();
					},
				);
				// An empty stdout is exactly what "nobody answered" looks like, so
				// giving up falls through to pi's own prompt with no extra branch.
				const bail = new Promise<HookResult>((res) => {
					escape = () => res({ code: 0, stdout: "", stderr: "" });
					if (APPROVAL_TIMEOUT_MS > 0) timer = setTimeout(release, APPROVAL_TIMEOUT_MS);
				});
				({ stdout } = await Promise.race([hook, bail]));
			} finally {
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", release);
			}
			// `permissionRequestDecisionOut` writes the answer to stdout as
			// {hookSpecificOutput:{decision:{behavior:"allow"|"deny", ...}}}, and
			// writes `{}` when nobody answered. So an empty/unparseable answer, a
			// missing tlive, or a dead daemon all fall through to pi's own approval
			// prompt — this can never wedge a tool.
			let decision: { behavior?: string; message?: string; updatedInput?: unknown } = {};
			try {
				decision =
					(
						JSON.parse(stdout || "{}") as {
							hookSpecificOutput?: { decision?: typeof decision };
						}
					).hookSpecificOutput?.decision ?? {};
			} catch {
				return;
			}
			if (decision.behavior === "deny") {
				return { block: true, reason: decision.message || "Denied via tlive" };
			}
			const patch = decision.updatedInput;
			if (
				decision.behavior === "allow" &&
				e.input &&
				patch &&
				typeof patch === "object" &&
				!Array.isArray(patch)
			) {
				// `event.input` is documented as mutable and mutations reach the
				// real execution, so an edited-then-approved call is honoured.
				// REPLACE rather than merge: a browser edit that removes a key must
				// actually remove it, and pi does not re-validate what is left
				// behind. The object identity has to survive, so mutate in place.
				for (const k of Object.keys(e.input)) delete e.input[k];
				Object.assign(e.input, patch as Record<string, unknown>);
			}
			// allow / no answer: let pi proceed (allow means skip our own block).
			return undefined;
		}
	}

	pi.on("session_shutdown", async (event, ctx) => {
		if (!active) return;
		cancelPendingStop();
		// Forward pi's own reason (quit | reload | new | resume | fork) instead of
		// flattening it: tlive drops the card on session-end for a non-wrapped
		// session, and the reason is the only thing that distinguishes a real exit
		// from a reload that a fresh session-start is about to follow.
		await tliveHook("session-end", {
			...base(ctx),
			reason: (event as { reason?: string }).reason ?? "shutdown",
		});
	});
}
