/**
 * esc-restore — after an ESC-interrupted turn, roll the session back to the
 * state right before that prompt was sent, instead of leaving an "Operation
 * aborted" stub in history and a separately-refilled editor.
 *
 * WHY: pi's own ESC handling only restores messages that were queued but not yet
 * sent (`restoreQueuedMessagesToEditor`). The prompt that was actually in flight
 * when ESC landed is not put back in the editor, and the aborted exchange (user
 * prompt + assistant "Operation aborted" stub, `interactive-mode.js:2649-2661`)
 * stays in history permanently — an orphan checkpoint nobody asked for.
 *
 * `ctx.navigateTree(entryId)` is pi's own primitive for exactly this. Passing the
 * aborted user message's own entry id makes `agent-session.js`'s `navigateTree`
 * (`:2471-2627`) detect `targetEntry.message.role === "user"`, set
 * `newLeafId = targetEntry.parentId`, pull `editorText = contentText(...)` from
 * it, and — since this is not a summarized jump — take the plain `else` branch:
 * `this.sessionManager.branch(newLeafId)`. `SessionManager.branch()`
 * (`session-manager.d.ts`) only moves the leaf pointer ("Existing entries are
 * not modified or deleted") — no new session file, unlike `ctx.fork()`, whose own
 * doc-comment says "creating a new session file" (it calls
 * `sessionManager.createBranchedSession()` instead). `fork` was the original
 * choice here and works the same way for our purposes, but every ESC-abort would
 * leave behind a new session file on disk — `navigateTree` rewinds the SAME file
 * in place. The caller (`interactive-mode.js:1432-1450`) applies `editorText` to
 * the editor itself and shows `"Navigated to selected point"` (not pi's own
 * "Forked to new session") — no manual setEditorText needed here, same as fork.
 * `ctx.navigateTree` only exists on `ExtensionCommandContext` (command handlers),
 * not on the plain `ExtensionContext` event handlers get ("These are only
 * available in commands because they can deadlock if called from event
 * handlers" — docs/extensions.md:1111), so this registers an internal command and
 * reaches it via `pi.sendUserMessage("/esc-rewind", { deliverAs: "followUp",
 * expandPromptTemplates: true })`. `expandPromptTemplates` is required —
 * `sendUserMessage` defaults it to `false` and docs/extensions.md:1439 says it
 * "Always triggers a turn" without it, so the command text ships as a literal
 * chat prompt to the model instead of dispatching to `registerCommand`.
 *
 * WHY message_end, not agent_end, for detection: `agent_end`'s
 * `event.messages[].stopReason === "aborted"` (the assistant message carries this
 * when the run was ESC-cancelled — `@earendil-works/pi-agent-core/dist/agent.js`'s
 * `handleRunFailure`) is enough to know a rewind is warranted, but by then the
 * "Operation aborted" stub has already rendered: `agent-session.js:384` runs
 * extension hooks (including `message_end`) BEFORE `:386`'s `this._emit(event)`,
 * which is what `interactive-mode.js`'s UI switch (`case "message_end":` ~2649)
 * subscribes to render from. `message_end` handlers may return `{ message }` to
 * replace the finalized message in place (docs/extensions.md:605-621), and
 * `_replaceMessageInPlace` (`agent-session.js:453`) mutates the SAME object the
 * UI switch later reads — so a `message_end` handler that rewrites
 * `stopReason` away from `"aborted"` runs early enough to suppress the render
 * before it ever reaches the terminal — both the live streaming update
 * (`interactive-mode.js`'s `case "message_end":` ~2649) and the later full
 * repaint `navigateTree` triggers (`chatContainer.clear()` +
 * `renderInitialMessages()` → `renderSessionItems`, which has its own
 * `"Operation aborted"` string for a re-rendered tool-call message,
 * `:3025-3038`) read a message object that, by the time either fires, already
 * went through `agent-session.js:384-392`'s `sessionManager.appendMessage
 * (event.message)` — same, already-mutated object, persisted synchronously
 * before `agent_end` even fires. So the full-screen clear+rerender
 * `navigateTree` does on every rewind is real and still visible — it is an
 * inherent repaint of any tree-navigation primitive, fork included, not a bug —
 * but its content is already correct; there is no second place left where
 * "Operation aborted" can leak through.
 *
 * This also means the rewind-worthiness gate (hasUI, nearest real user entry,
 * `PI_ESC_RESTORE_WINDOW_MS` window) now lives in `message_end`, not `agent_end`:
 * suppressing the label is only correct when we are actually about to rewind, and
 * at `message_end` time the branch already has the user entry that opened this
 * turn (it was persisted at ITS OWN `message_end`, long before the assistant
 * started streaming), so the same lookup that used to run in `agent_end` works
 * just as well here.
 *
 * WHY agent_settled, not agent_end, for the sendUserMessage trigger:
 * `navigateTree` (`agent-session.js:2465-2467`) throws "Wait for the current
 * response to finish before navigating the session tree." whenever
 * `this.isStreaming` (getter over `_isAgentRunActive`) is still true.
 * `agent_end` is emitted from deep inside `await this.agent.prompt(messages)`
 * (`_handleAgentEvent` → `_emitExtensionEvent`, `agent-session.js:386,474`) —
 * i.e. WHILE that call is still on the stack — but `_isAgentRunActive` is only
 * set back to `false` in `_runAgentPrompt`'s `finally` block, AFTER
 * `agent.prompt()` resolves and the `_handlePostAgentRun`/`agent.continue()`
 * retry-and-compaction loop finishes (`agent-session.js:773` sets it true,
 * `:348` sets it false, called from `_emitAgentSettled()` — `:346-354`).
 * So at `agent_end` time, `isStreaming` is still `true`. `pi.sendUserMessage`
 * with a `/`-prefixed command dispatches through `prompt()`'s "Handle
 * extension commands first ... even during streaming" fast path
 * (`agent-session.js:827-833`, `_tryExecuteExtensionCommand`) — it runs the
 * `/esc-rewind` command handler SYNCHRONOUSLY, immediately, regardless of
 * `isStreaming`. That handler then calls `ctx.navigateTree(entryId)`, which
 * hits the still-true `isStreaming` guard and throws — a live-tested failure
 * (`Extension "command:esc-rewind" error: Wait for the current response to
 * finish before navigating the session tree`), not hypothetical.
 * `fork()` (`agent-session-runtime.js:174`, used before the navigateTree
 * rewrite) has NO such guard, which is why this never surfaced until the
 * fork→navigateTree switch.
 * `agent_settled` (`agent-session.js:346-354`) sets `_isAgentRunActive = false`
 * BEFORE emitting — the one hook guaranteed to run after `isStreaming` is
 * false for this turn. Trigger moved there.
 *
 * RISK, and the bugs live runs already hit:
 *
 * 1. This originally called `ctx.fork(entryId, { position: "before" })`, whose
 *    core action (`interactive-mode.js:1419-1431` →
 *    `agent-session-runtime.js:174-195`) treats a bad `entryId` as fatal: if the
 *    resolved entry isn't `type === "message"` with `message.role === "user"`,
 *    it throws `"Invalid entry ID for forking"`, which `handleFatalRuntimeError`
 *    turns into `process.exit(1)` — not something an extension can catch. An
 *    early version captured `entryId` via `ctx.sessionManager.getLeafId()` inside
 *    a `message_start` handler, on the theory that the leaf at that instant *is*
 *    the new user message; live it crashed the whole process on every ESC, since
 *    the leaf pointer isn't reliably updated yet at that instant. Fixed by never
 *    trusting an id captured at `message_start`: the entry is resolved by walking
 *    `ctx.sessionManager.getBranch()` backward for the nearest `type ===
 *    "message"`, `role === "user"` entry, read only once the turn that opened it
 *    has fully landed. `navigateTree` throws a plain (non-fatal) `Error` on an
 *    unresolvable `targetId` instead of `process.exit(1)`, but the same
 *    resolve-only-after-settled discipline is kept regardless — no reason to
 *    reintroduce a race just because the failure mode got softer.
 * 2. Without `expandPromptTemplates: true`, `/esc-rewind` shipped as literal
 *    chat text instead of dispatching to `registerCommand`; the model had no
 *    idea what it meant, that bogus turn's own end could itself look aborted,
 *    and this handler fired the exact same followUp again — a live run looped
 *    through it several times before settling. `findLastUserEntry` below also
 *    skips any entry whose text is literally `/esc-rewind`, so even an injected
 *    literal turn can never become fork bait for a subsequent abort.
 * 3. Changing `stopReason` away from `"aborted"` also takes the UI switch's
 *    non-error branch, which calls `setArgsComplete()` on any still-pending tool
 *    call components (normally reserved for genuinely completed tool args) —
 *    a real if minor mismatch for the rare case where ESC lands mid-tool-call.
 *    Accepted: the rewind's repaint replaces this view moments later regardless,
 *    and it's strictly better than the guaranteed-wrong "Operation aborted"
 *    flash it replaces.
 * 4. Triggering `sendUserMessage("/esc-rewind", ...)` from `agent_end` (as the
 *    navigateTree rewrite originally did) throws "Wait for the current
 *    response to finish before navigating the session tree." on every single
 *    ESC-abort — `isStreaming` is still true at `agent_end` time (see WHY
 *    agent_settled above). Live-tested failure, not hypothetical. Fixed by
 *    moving the trigger to `agent_settled`.
 *
 * Set `PI_ESC_RESTORE_OFF=1` to fall back to pi's stock ESC behavior entirely
 * if this ever misbehaves again.
 *
 * CONFIG (env):
 *   PI_ESC_RESTORE_OFF=1              disable entirely.
 *   PI_ESC_RESTORE_WINDOW_MS=30000    how long after sending a prompt an abort still
 *                                     counts as "rewind-worthy" (default 30s).
 */

import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

const DEFAULT_WINDOW_MS = 30_000;
const REWIND_COMMAND = "esc-rewind";

function windowMs(): number {
	const raw = Number(process.env.PI_ESC_RESTORE_WINDOW_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_WINDOW_MS;
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((block) =>
				typeof block === "object" && block !== null
					? (block as { text?: unknown }).text
					: undefined,
			)
			.filter((text): text is string => typeof text === "string")
			.join("");
	}
	return "";
}

/** Nearest real user prompt walking back from the leaf, skipping our own injected rewind text. */
function findLastUserEntry(branch: readonly SessionEntry[]): SessionEntry | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		if (messageText(entry.message.content) === `/${REWIND_COMMAND}`) continue;
		return entry;
	}
	return undefined;
}

export default function escRestore(pi: ExtensionAPI) {
	if (process.env.PI_ESC_RESTORE_OFF === "1") return;

	let rewindEntryId: string | undefined;

	pi.registerCommand(REWIND_COMMAND, {
		description: "Internal: rewind to before an ESC-aborted prompt (used by esc-restore)",
		handler: async (_args, ctx) => {
			const entryId = rewindEntryId;
			rewindEntryId = undefined;
			if (!entryId) return;
			await ctx.navigateTree(entryId);
		},
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		if (event.message.stopReason !== "aborted") return;
		if (!ctx.hasUI) return;

		const entry = findLastUserEntry(ctx.sessionManager.getBranch());
		if (!entry) return;
		const sentAt = Date.parse(entry.timestamp);
		if (Number.isFinite(sentAt) && Date.now() - sentAt > windowMs()) return;

		rewindEntryId = entry.id;
		// Suppress "Operation aborted" before it ever renders — see WHY above.
		return { message: { ...event.message, stopReason: "stop" as const, errorMessage: undefined } };
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		if (!rewindEntryId) return;
		pi.sendUserMessage(`/${REWIND_COMMAND}`, {
			deliverAs: "followUp",
			expandPromptTemplates: true,
		});
	});
}
