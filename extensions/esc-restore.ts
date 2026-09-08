/**
 * esc-restore — after an ESC-interrupted turn, refill the empty editor with the
 * prompt that was just cut short, so the user can re-edit and resend it instead
 * of retyping (Claude Code's ESC-then-edit behavior).
 *
 * WHY: pi's own ESC handling only restores messages that were queued but not yet
 * sent (`restoreQueuedMessagesToEditor`). The prompt that was actually in flight
 * when ESC landed is not put back in the editor, so an interrupted turn currently
 * just vanishes. Confirmed via `agent_end`: neither `agent_end` nor `agent_settled`
 * carries a dedicated abort flag on the event itself, but the assistant message in
 * `event.messages` carries `stopReason === "aborted"` when the run was ESC-cancelled
 * (`@earendil-works/pi-agent-core/dist/agent.js`'s `handleRunFailure`), and that path
 * still fires `agent_end` normally — it is not short-circuited.
 *
 * CONFIG (env):
 *   PI_ESC_RESTORE_OFF=1              disable entirely.
 *   PI_ESC_RESTORE_WINDOW_MS=30000    how long after sending a prompt an abort still
 *                                     counts as "restore-worthy" (default 30s).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_WINDOW_MS = 30_000;

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

	let lastInteractiveInput: { text: string; at: number } | undefined;

	pi.on("input", async (event) => {
		if (event.source === "interactive" && event.text.trim()) {
			lastInteractiveInput = { text: event.text, at: Date.now() };
		}
		return { action: "continue" };
	});

	pi.on("agent_end", async (event, ctx) => {
		const pending = lastInteractiveInput;
		if (!pending || !ctx.hasUI) return;
		if (Date.now() - pending.at > windowMs()) return;
		if (!isAborted(event.messages)) return;

		lastInteractiveInput = undefined;
		if (ctx.ui.getEditorText().trim()) return;
		ctx.ui.setEditorText(pending.text);
	});
}
