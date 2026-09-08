/**
 * delegate-status-fix — clear billion-context-pi's own "sub-agents ↑Xk ↓Yk"
 * footer status once its delegate calls settle, instead of it staying pinned
 * in the statusline for the rest of the pi process's life.
 *
 * WHY: billion-context-pi's fleet-widget (`dist/index.js`'s inlined
 * `footer-status.ts`, ~10216-10253) writes
 * `ctx.ui.setStatus("billion-context-pi", "sub-agents ↑Xk ↓Yk(...)")` from a
 * module-level cumulative `delegateUsageTotal` that is only ever reset on a
 * real `session_start` (`resetDelegateUsage()`, `dist/index.js` ~17343) — not
 * once a delegate run finishes mid-session. Its own `refresh()` loop (the
 * inlined `fleet-widget.ts`, ~10295-10318) DOES clear the belowEditor
 * delegate-list widget once `runs2.length === 0`, but then calls
 * `updateFooterStatus()` exactly once more and stops its 500ms timer for
 * good — so the footer text from that last call is never revisited: one
 * `acp_delegate` call in a session and this status key is stuck showing a
 * cumulative total for good, reported live as a permanently-occupied
 * statusline slot.
 *
 * No config knob turns this off — checked `delegate.displayUsage`
 * ("merged"|"separate", `dist/config.d.ts`): that only controls whether
 * per-run usage gets folded into the injected result message text, and
 * `updateFooterStatus()` doesn't consult it at all. `ctx.ui.setStatus` also
 * has no position/ordering parameter (`extensions/types.d.ts:80` —
 * `setStatus(key, text)`, nothing else), so which row a status key renders
 * on is entirely up to pi core's own footer layout, not something an
 * extension (this one or billion-context-pi) can steer.
 *
 * billion-context-pi is an npm package here (`packages[]` entry
 * `"npm:billion-context-pi"`), not vendored — patching its dist directly
 * wouldn't survive a reinstall/update. Instead, clear the SAME status key
 * ourselves shortly after its own delegate tool calls settle: the same
 * DONE_LINGER-style debounce `task-dock.ts` uses for its own rows, and the
 * same "clear on tool_result" instinct `subagent-model-router.ts` uses for
 * its "router" key. A genuinely still-running delegate keeps its own 500ms
 * timer alive and will simply overwrite this clear on its next tick, so a
 * real in-flight run is unaffected — only the truly-idle, stuck case is
 * fixed.
 *
 * CONFIG (env):
 *   PI_DELEGATE_STATUS_FIX_OFF=1   disable entirely.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "billion-context-pi";
const DELEGATE_TOOLS = new Set(["acp_delegate", "acp_delegate_wait", "acp_delegate_cancel"]);
const CLEAR_DELAY_MS = 3_000;

function isOff(): boolean {
	return process.env.PI_DELEGATE_STATUS_FIX_OFF === "1";
}

export default function delegateStatusFix(pi: ExtensionAPI): void {
	if (isOff()) return;

	let clearTimer: ReturnType<typeof setTimeout> | undefined;

	pi.on("tool_result", async (event: any, ctx?: any) => {
		try {
			if (!DELEGATE_TOOLS.has(event?.toolName)) return;
			if (!ctx?.ui?.setStatus) return;
			if (clearTimer) clearTimeout(clearTimer);
			clearTimer = setTimeout(() => {
				clearTimer = undefined;
				try {
					ctx.ui.setStatus(STATUS_KEY, undefined);
				} catch {
					/* status bar is optional */
				}
			}, CLEAR_DELAY_MS);
			clearTimer.unref?.();
		} catch {
			/* never let a footer cleanup break delegation */
		}
	});
}
