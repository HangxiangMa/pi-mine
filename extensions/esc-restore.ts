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
 * reaches it via `pi.sendUserMessage("/esc-rewind", { deliverAs: "followUp" })` —
 * the same escape hatch pi's own `examples/extensions/reload-runtime.ts` uses for
 * the identical restriction.
 *
 * Confirmed via `agent_end`: neither `agent_end` nor `agent_settled` carries a
 * dedicated abort flag on the event itself, but the assistant message in
 * `event.messages` carries `stopReason === "aborted"` when the run was
 * ESC-cancelled (`@earendil-works/pi-agent-core/dist/agent.js`'s
 * `handleRunFailure`), and that path still fires `agent_end` normally.
 *
 * RISK: core's own fork action (`interactive-mode.js:1419-1431`) treats a failed
 * fork as fatal (`handleFatalRuntimeError` → `process.exit(1)`) — that's not
 * something an extension can catch, so this only fires with an `entryId` captured
 * moments earlier from the same session's own leaf, immediately before the abort
 * it belongs to. Set `PI_ESC_RESTORE_OFF=1` to fall back to pi's stock ESC
 * behavior entirely if this ever misbehaves.
 *
 * CONFIG (env):
 *   PI_ESC_RESTORE_OFF=1              disable entirely.
 *   PI_ESC_RESTORE_WINDOW_MS=30000    how long after sending a prompt an abort still
 *                                     counts as "rewind-worthy" (default 30s).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

export default function escRestore(pi: ExtensionAPI) {
	if (process.env.PI_ESC_RESTORE_OFF === "1") return;

	let pendingEntry: { entryId: string; at: number } | undefined;
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

	pi.on("message_start", async (event, ctx) => {
		if (event.message.role === "user") {
			const entryId = ctx.sessionManager.getLeafId();
			pendingEntry = entryId ? { entryId, at: Date.now() } : undefined;
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		const pending = pendingEntry;
		if (!pending || !ctx.hasUI) return;
		if (Date.now() - pending.at > windowMs()) return;
		if (!isAborted(event.messages)) return;

		pendingEntry = undefined;
		rewindEntryId = pending.entryId;
		pi.sendUserMessage(`/${REWIND_COMMAND}`, { deliverAs: "followUp" });
	});
}
