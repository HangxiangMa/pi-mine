/**
 * esc-restore — after an ESC-interrupted turn, roll the session back to the
 * state right before that prompt was sent, instead of leaving an "Operation
 * aborted" stub in history and a separately-refilled editor.
 *
 * WHY: pi's own ESC handling only restores messages that were queued but not yet
 * sent (`restoreQueuedMessagesToEditor`). The prompt that was actually in flight
 * when ESC landed is not put back in the editor, and the aborted exchange (user
 * prompt + assistant "Operation aborted" stub, `interactive-mode.js:2655-2661`)
 * stays in history permanently — an orphan checkpoint nobody asked for.
 *
 * `ctx.fork(entryId, { position: "before" })` is pi's own primitive for exactly
 * this (the same one `/fork` and double-ESC's `doubleEscapeAction: "fork"` use,
 * `interactive-mode.js:1419-1431`): it forks the session tree to a new file that
 * ends right before the given user message, and the core fork action itself does
 * `this.editor.setText(result.selectedText ?? "")` — no manual setEditorText
 * needed here. `ctx.fork` only exists on `ExtensionCommandContext` (command
 * handlers), not on the plain `ExtensionContext` event handlers get ("These are
 * only available in commands because they can deadlock if called from event
 * handlers" — docs/extensions.md:1111), so this registers an internal command and
 * reaches it via `pi.sendUserMessage("/esc-rewind", { deliverAs: "followUp",
 * expandPromptTemplates: true })`. `expandPromptTemplates` is required —
 * `sendUserMessage` defaults it to `false` and docs/extensions.md:1439 says it
 * "Always triggers a turn" without it, so the command text ships as a literal
 * chat prompt to the model instead of dispatching to `registerCommand`.
 *
 * Confirmed via `agent_end`: neither `agent_end` nor `agent_settled` carries a
 * dedicated abort flag on the event itself, but the assistant message in
 * `event.messages` carries `stopReason === "aborted"` when the run was
 * ESC-cancelled (`@earendil-works/pi-agent-core/dist/agent.js`'s
 * `handleRunFailure`), and that path still fires `agent_end` normally.
 *
 * RISK, and the two bugs a live run already hit:
 *
 * 1. Core's own fork action (`interactive-mode.js:1419-1431` →
 *    `agent-session-runtime.js:174-195`) treats a bad `entryId` as fatal: if the
 *    resolved entry isn't `type === "message"` with `message.role === "user"`,
 *    it throws `"Invalid entry ID for forking"`, which `handleFatalRuntimeError`
 *    turns into `process.exit(1)` — not something an extension can catch. The
 *    first version of this file captured `entryId` via
 *    `ctx.sessionManager.getLeafId()` inside the `message_start` handler, on the
 *    theory that the leaf at that instant *is* the new user message. Live it
 *    crashed the whole process on every ESC — the leaf pointer is almost
 *    certainly not updated yet when `message_start` fires, so the captured id
 *    pointed at the *previous* turn's entry (often role `assistant`), which
 *    fails that type check. Fixed by not trusting any id captured at
 *    `message_start` at all: `agent_end` now resolves the entry itself by
 *    walking `ctx.sessionManager.getBranch()` backward for the nearest
 *    `type === "message"`, `role === "user"` entry — reading the tree after the
 *    turn has fully landed, when the append is guaranteed to be visible.
 * 2. Without `expandPromptTemplates: true`, `/esc-rewind` shipped as literal
 *    chat text instead of dispatching to `registerCommand`; the model had no
 *    idea what it meant, that bogus turn's own `agent_end` could itself read as
 *    aborted, and this handler fired the exact same followUp again — a live
 *    run looped through it several times before settling. `findLastUserEntry`
 *    below also skips any entry whose text is literally `/esc-rewind`, so even
 *    an injected literal turn can never become fork bait for a subsequent
 *    abort.
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

function isAborted(messages: readonly unknown[] | undefined): boolean {
	return (messages ?? []).some(
		(message) =>
			typeof message === "object" &&
			message !== null &&
			(message as { stopReason?: unknown }).stopReason === "aborted",
	);
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
			await ctx.fork(entryId, { position: "before" });
		},
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!ctx.hasUI) return;
		if (!isAborted(event.messages)) return;

		const entry = findLastUserEntry(ctx.sessionManager.getBranch());
		if (!entry) return;
		const sentAt = Date.parse(entry.timestamp);
		if (Number.isFinite(sentAt) && Date.now() - sentAt > windowMs()) return;

		rewindEntryId = entry.id;
		pi.sendUserMessage(`/${REWIND_COMMAND}`, {
			deliverAs: "followUp",
			expandPromptTemplates: true,
		});
	});
}
