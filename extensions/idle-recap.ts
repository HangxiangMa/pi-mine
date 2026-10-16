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
 * `pi.sendUserMessage("/recap", { deliverAs: "followUp", expandPromptTemplates:
 * true })`. `expandPromptTemplates` is required: `sendUserMessage` defaults it
 * to `false` and without it the text ships as a literal chat prompt instead of
 * dispatching to `registerCommand` (docs/extensions.md:1439 — "Always triggers
 * a turn" without this flag). A sibling extension (`esc-restore.ts`) hit exactly
 * this bug live: the literal "/esc-rewind" text became a real turn whose own
 * `agent_end` looked aborted, re-triggering the same followUp in a loop. The
 * `message_start` guard below is the same defense-in-depth against that class
 * of self-retrigger, applied here even though `/recap` itself doesn't run
 * through the agent-turn/`agent_end` path. `generateRecap()` itself still
 * no-ops on an empty session (`goal` unset / `rounds.length === 0`) or with no
 * UI, so firing blind on a session with nothing to recap is harmless.
 *
 * Idle is measured from the end of the last agent turn (`agent_end`), not
 * from process start — a session sitting open before its first exchange has
 * nothing to recap yet. Each new user message re-arms the clock; at most one
 * forced recap fires per idle stretch (no repeat-firing while the user stays
 * away).
 *
 * SECOND TRIGGER — context-usage percent: pi-recap's own `agent_end` auto-
 * update (gated by `minTurns`/`cooldownTurns`, install.sh now sets
 * `recap.minTurns` to a value that never reaches on its own — see
 * `pi/install.sh`'s pi:packages step) is no longer the thing deciding
 * cadence; idle above is one half, and this is the other: once the session's
 * context-window usage crosses `PI_IDLE_RECAP_CONTEXT_PERCENT` (default 50),
 * a forced recap fires on EVERY subsequent `agent_end`, not idle-gated at
 * all — the summary needs to stay current precisely because a compaction
 * may be close and the widget is the only place that context survives.
 * Reads `ctx.getContextUsage(): {tokens, contextWindow, percent} | undefined`
 * (`@earendil-works/pi-coding-agent`'s public `ExtensionContext` API,
 * `dist/core/extensions/types.d.ts:244` — the same first-class method
 * `pi-statusline`'s own footer "34.1%/200k" segment uses,
 * `pi-statusline/src/render.ts:161`). `percent` is `null` right after a
 * compaction (tokens not yet known) — treated as "below threshold", not an
 * error; the next turn will have a real number again.
 *
 * CONFIG (env):
 *   PI_IDLE_RECAP_OFF=1                    disable entirely (both triggers).
 *   PI_IDLE_RECAP_THRESHOLD_MS=300000      idle time before a forced recap (default 5min).
 *   PI_IDLE_RECAP_POLL_MS=15000            how often idle time is checked (default 15s).
 *   PI_IDLE_RECAP_CONTEXT_PERCENT=50       context-usage percent at/above which every
 *                                          turn forces a recap, idle or not.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { conversationFingerprint, shouldForceRecap } from "./idle-recap-gate.ts";

const DEFAULT_THRESHOLD_MS = 5 * 60_000;
const DEFAULT_POLL_MS = 15_000;
const DEFAULT_CONTEXT_THRESHOLD_PERCENT = 50;

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

function contextThresholdPercent(): number {
	const raw = Number(process.env.PI_IDLE_RECAP_CONTEXT_PERCENT);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CONTEXT_THRESHOLD_PERCENT;
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

export default function idleRecap(pi: ExtensionAPI): void {
	if (isOff()) return;

	let liveCtx: ExtensionContext | undefined;
	let settledAt: number | undefined;
	let fired = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	// Fingerprint of the conversation the last context-threshold recap was requested for.
	let lastFingerprint: string | undefined;

	function tick(): void {
		// Bare setInterval, not a pi.on() handler — a session replacement
		// (ESC-fork, /tree, newSession) between ticks can leave `liveCtx` stale;
		// fail open rather than let a stale-ctx throw take the process down.
		try {
			if (!liveCtx?.hasUI || fired || settledAt === undefined) return;
			if (Date.now() - settledAt < thresholdMs()) return;
			fired = true;
			pi.sendUserMessage("/recap", { deliverAs: "followUp", expandPromptTemplates: true });
		} catch {
			/* next session_start re-arms with a fresh ctx */
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		liveCtx = ctx;
		settledAt = undefined;
		fired = false;
		// A new session is a new conversation, so nothing has been recapped for it yet.
		lastFingerprint = undefined;
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		if (!ctx.hasUI) return;
		timer = setInterval(tick, pollMs());
		timer.unref?.();
	});

	pi.on("message_start", async (event) => {
		if (event.message.role !== "user") return;
		// Never let our own injected "/recap" text (if dispatch ever falls
		// through to a literal turn) count as real user activity.
		if (messageText(event.message.content) === "/recap") return;
		settledAt = undefined;
		fired = false;
	});

	pi.on("agent_end", async (_event, ctx) => {
		settledAt = Date.now();
		fired = false;
		try {
			if (!ctx?.hasUI) return;
			const percent = ctx.getContextUsage?.()?.percent;
			if (typeof percent !== "number" || percent < contextThresholdPercent()) return;
			// Only recap when the conversation has changed since the last forced recap. While the user
			// is idle and nothing new was said, a repeat call would only re-summarise the same turns.
			const messages = (ctx.sessionManager.getBranch?.() ?? [])
				.filter((entry) => entry.type === "message")
				.map((entry) => entry.message);
			const fingerprint = conversationFingerprint(messages);
			if (!shouldForceRecap({ fingerprint, lastFingerprint })) return;
			lastFingerprint = fingerprint;
			pi.sendUserMessage("/recap", { deliverAs: "followUp", expandPromptTemplates: true });
		} catch {
			/* context-usage read is best-effort; idle trigger still covers this session */
		}
	});
}
