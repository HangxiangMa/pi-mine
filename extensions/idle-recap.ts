/**
 * idle-recap — force a `/recap` update once the user has gone quiet for a
 * while, instead of only ever refreshing on the existing turn-count/cooldown
 * schedule.
 *
 * WHY: `@lanlance/pi-recap`'s own auto-update (its `agent_end` handler) is
 * gated by `minTurns` (3) and a `cooldownTurns` (3) counter — see its
 * `generateRecap()`. That is fine while the conversation keeps going, but if
 * the user stops mid-cooldown (or before `minTurns` is reached) and walks
 * away, the widget is left stale for however long the session stays open —
 * nothing in pi-recap is time-based. This mirrors Claude Code's habit of
 * writing a final summary when the user stops interacting, not just every
 * few turns while they're active.
 *
 * `/recap` is already a registered command (pi-recap's own
 * `pi.registerCommand("recap", ...)`, `force: true`, bypasses minTurns/
 * cooldown/similarity gating) — this file does not touch pi-recap or
 * reimplement any of its gating, it only decides *when* to ask for a forced
 * refresh by tracking idle time itself and invoking the existing command via
 * `pi.sendUserMessage("/recap", { deliverAs: "followUp" })`, the same
 * escape hatch `esc-restore.ts` and pi's own
 * `examples/extensions/reload-runtime.ts` use to reach a command from a
 * plain event handler. `generateRecap()` itself still no-ops on an empty
 * session (`goal` unset / `rounds.length === 0`) or with no UI, so firing
 * blind on a session with nothing to recap is harmless.
 *
 * Idle is measured from the end of the last agent turn (`agent_end`), not
 * from process start — a session sitting open before its first exchange has
 * nothing to recap yet. Each new user message re-arms the clock; at most one
 * forced recap fires per idle stretch (no repeat-firing while the user stays
 * away).
 *
 * CONFIG (env):
 *   PI_IDLE_RECAP_OFF=1                 disable entirely.
 *   PI_IDLE_RECAP_THRESHOLD_MS=300000   idle time before a forced recap (default 5min).
 *   PI_IDLE_RECAP_POLL_MS=15000         how often idle time is checked (default 15s).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_THRESHOLD_MS = 5 * 60_000;
const DEFAULT_POLL_MS = 15_000;

function isOff(): boolean {
	return process.env.PI_IDLE_RECAP_OFF === "1";
}

function thresholdMs(): number {
	const raw = Number(process.env.PI_IDLE_RECAP_THRESHOLD_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_THRESHOLD_MS;
}

function pollMs(): number {
	const raw = Number(process.env.PI_IDLE_RECAP_POLL_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_POLL_MS;
}

export default function idleRecap(pi: ExtensionAPI): void {
	if (isOff()) return;

	let liveCtx: ExtensionContext | undefined;
	let settledAt: number | undefined;
	let fired = false;
	let timer: ReturnType<typeof setInterval> | undefined;

	function tick(): void {
		// Bare setInterval, not a pi.on() handler — a session replacement
		// (ESC-fork, /tree, newSession) between ticks can leave `liveCtx` stale;
		// fail open rather than let a stale-ctx throw take the process down.
		try {
			if (!liveCtx?.hasUI || fired || settledAt === undefined) return;
			if (Date.now() - settledAt < thresholdMs()) return;
			fired = true;
			pi.sendUserMessage("/recap", { deliverAs: "followUp" });
		} catch {
			/* next session_start re-arms with a fresh ctx */
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		liveCtx = ctx;
		settledAt = undefined;
		fired = false;
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		if (!ctx.hasUI) return;
		timer = setInterval(tick, pollMs());
		timer.unref?.();
	});

	pi.on("message_start", async (event) => {
		if (event.message.role === "user") {
			settledAt = undefined;
			fired = false;
		}
	});

	pi.on("agent_end", async () => {
		settledAt = Date.now();
		fired = false;
	});
}
