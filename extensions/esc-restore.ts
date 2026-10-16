/**
 * esc-restore — make an ESC-interrupted turn read the way Claude Code does.
 *
 * Claude Code 2.1.286 on Esc during a run: it stops the turn, keeps the prompt in
 * history, and shows an "Interrupted · What should Claude do instead?" row. It
 * does not roll the session back, and it does not refill the input with the
 * interrupted prompt. A queued follow-up is the exception: Esc pulls it back into
 * the input (verified in the 2.1.286 binary, cancel handler near byte 224908337,
 * and CHANGELOG entries for queued-message pull-back).
 *
 * pi already does the queued pull-back natively (`restoreQueuedMessagesToEditor`
 * on Esc while streaming, interactive-mode.js:2415-2420). This extension adds:
 *
 *   1. An Interrupted marker in place of pi's "Operation aborted" stub. The marker
 *      is a display-only custom entry, so it never enters model context.
 *   2. Claude's draft double-Esc clear ("Esc again to clear", 800 ms window).
 *   3. Nothing else. The aborted prompt stays in history, and the input is left
 *      as the user typed it. There is no navigateTree rollback.
 *
 * Why the stub is rewritten at message_end and not elsewhere: the live UI
 * (interactive-mode.js:2876-2881) overwrites errorMessage with "Operation
 * aborted" for any aborted assistant message, so the rewrite has to happen before
 * the UI reads it. Setting stopReason to "stop" makes it render as a normal reply,
 * which is what suppresses the stub. The marker is then appended after the run.
 *
 * The empty-prompt double-Esc is left to pi's native handler. It opens /tree
 * (settings: doubleEscapeAction, default "tree"). Its window is pi's 500 ms.
 * Claude uses 800 ms for that gesture too (its open-selector call takes the same
 * IW default as draft clear), so this is a known gap, not a deliberate choice.
 * Closing it needs an extension hook that opens /tree, which pi does not expose.
 *
 * CONFIG (env):
 *   PI_ESC_RESTORE_OFF=1    disable this extension and fall back to pi's stock ESC.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

const MARKER_TYPE = "interrupt-marker";
const MARKER_TEXT = "Interrupted · What should Claude do instead?";
/** Claude's double-press window for draft clear (binary: IW default a=800). */
export const DRAFT_CLEAR_WINDOW_MS = 800;
const ESC = "\x1b";

/**
 * Draft double-Esc clear, as Claude Code does it: the first Esc on a non-empty draft
 * shows "Esc again to clear", and a second Esc inside the window clears the draft.
 * Only an idle, non-empty editor takes the key. A streaming run or an empty editor
 * passes Esc through, so pi still stops the run and runs its own tree double-tap.
 */
export function draftClearStep(
	state: { pendingAt: number | undefined },
	key: string,
	now: number,
	draft: string,
	idle: boolean,
): "pass" | "hint" | "clear" {
	if (key !== ESC) return "pass";
	if (!idle || draft.length === 0) {
		state.pendingAt = undefined;
		return "pass";
	}
	if (state.pendingAt !== undefined && now - state.pendingAt <= DRAFT_CLEAR_WINDOW_MS) {
		state.pendingAt = undefined;
		return "clear";
	}
	state.pendingAt = now;
	return "hint";
}

export default function escRestore(pi: ExtensionAPI) {
	if (process.env.PI_ESC_RESTORE_OFF === "1") return;

	let interruptedThisRun = false;
	const draftClear = { pendingAt: undefined as number | undefined };
	/** Bumped on every hint so a stale timer cannot clear a newer hint early. */
	let hintGeneration = 0;

	pi.registerEntryRenderer(MARKER_TYPE, (_entry, _options, theme) => ({
		render: (width: number) => [truncateToWidth(theme.fg("dim", MARKER_TEXT), width)],
		// The marker is static text, so there is nothing to invalidate.
		invalidate: () => {},
	}));

	let unsubscribeInput: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		// session_start fires again on /new and /resume. Drop the previous listener so
		// each Esc is handled once, not once per session start.
		unsubscribeInput?.();
		unsubscribeInput = ctx.ui.onTerminalInput((data) => {
			const step = draftClearStep(
				draftClear,
				data,
				Date.now(),
				ctx.ui.getEditorText(),
				ctx.isIdle(),
			);
			if (step === "pass") return undefined;
			if (step === "hint") {
				const generation = ++hintGeneration;
				ctx.ui.setStatus("esc-draft", "Esc again to clear");
				setTimeout(() => {
					if (generation === hintGeneration) ctx.ui.setStatus("esc-draft", undefined);
				}, DRAFT_CLEAR_WINDOW_MS);
				return { consume: true };
			}
			ctx.ui.setStatus("esc-draft", undefined);
			ctx.ui.setEditorText("");
			return { consume: true };
		});
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		if (event.message.stopReason !== "aborted") return;
		if (!ctx.hasUI) return;
		interruptedThisRun = true;
		// Stop the stub from rendering. See the header for why this is the stop reason.
		return { message: { ...event.message, stopReason: "stop" as const, errorMessage: undefined } };
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!interruptedThisRun) return;
		interruptedThisRun = false;
		if (!ctx.hasUI) return;
		pi.appendEntry(MARKER_TYPE, { at: Date.now() });
	});
}
