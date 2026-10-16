/**
 * Dim hint above the input box after a code restore.
 *
 * The hint is an extension widget placed `aboveEditor`, so it sits outside the input
 * box and never changes the editor. It is cleared on the first printable keystroke
 * the user types, or when a new turn starts. Text written into the editor by pi
 * (for example the `/tree` prefill) is not a keystroke, so it does not clear the hint.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const WIDGET_KEY = "code-restore-hint";
const WIDGET_OPTIONS = { placement: "aboveEditor" } as const;
const DIM = "\x1b[2m";
const RESET = "\x1b[22m";

type Active = { unsubscribe: () => void };
let active: Active | undefined;

/** Printable input: a single character, not an escape sequence or control byte. */
export function isPrintableKey(data: string): boolean {
	if (data.length === 0) return false;
	if (data.startsWith("\x1b")) return false;
	const code = data.charCodeAt(0);
	if (code < 0x20 || code === 0x7f) return false;
	return true;
}

/**
 * Show the hint above the input box until the user types a character.
 * Replaces any hint already shown.
 */
export function showRestoreHint(ctx: ExtensionContext, text: string): void {
	if (!ctx.hasUI) return;
	clearRestoreHint(ctx);
	const line = text.trim();
	if (!line) return;
	ctx.ui.setWidget(WIDGET_KEY, [`${DIM}${line}${RESET}`], WIDGET_OPTIONS);
	if (typeof ctx.ui.onTerminalInput === "function") {
		const unsubscribe = ctx.ui.onTerminalInput((data) => {
			if (isPrintableKey(data)) clearRestoreHint(ctx);
			return undefined;
		});
		active = { unsubscribe };
	}
}

/** Remove the hint and its keystroke listener. Safe to call when nothing is shown. */
export function clearRestoreHint(ctx: ExtensionContext): void {
	if (active) {
		active.unsubscribe();
		active = undefined;
	}
	if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
}

/** True while a hint is shown. Exposed for tests. */
export function isRestoreHintShown(): boolean {
	return active !== undefined;
}
