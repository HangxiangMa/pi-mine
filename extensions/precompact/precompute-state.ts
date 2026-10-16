/**
 * Pre-compaction cache: a pure state machine.
 *
 * Pi's compaction blocks the next turn while it summarises, so the pause the user
 * feels is the whole summary call. This cache moves that call into the background:
 * once context passes `start` of the window, a summary of the history so far is
 * generated while the session keeps working. When real compaction is due, a ready
 * summary is handed over instead of being computed then.
 *
 * A cached summary covers history up to `coveredThroughId`. It is only reused while
 * that message is still on the active branch, so `/tree` navigation or a rewind can
 * never splice a stale summary into a different history. A user interrupt discards
 * the attempt, and a failed attempt is never consumed.
 *
 * No pi runtime is imported here, so the policy is testable on its own. The
 * extension wires it to the session events and to `ctx.modelRegistry.complete`.
 */

export type PrecomputeStatus = "idle" | "running" | "ready" | "failed";

export interface PrecomputeState {
	status: PrecomputeStatus;
	/** Identifies the attempt in flight, so a late result from an older attempt is ignored. */
	attemptId?: number;
	coveredThroughId?: string;
	summary?: string;
	usage?: { input: number };
	error?: string;
}

export type PrecomputeAction =
	| { type: "start"; attemptId?: number; coveredThroughId: string }
	| { type: "finish"; attemptId?: number; summary: string; usage: { input: number } }
	| { type: "fail"; attemptId?: number; error: string }
	| { type: "abort" }
	| { type: "consumed" };

export type ConsumeResult =
	| { use: true; summary: string; coveredThroughId: string }
	| { use: false; reason: string };

/** Begin pre-summarising at this fraction of the window, before real compaction is due. */
export const PRECOMPACT_START_FRACTION = 0.6;

/**
 * Output-token cap for the pre-summary, the same rule pi applies to its own summary: 80% of
 * reserveTokens, never above the model's limit. A smaller cap truncates long summaries, and a
 * truncated summary is discarded, so the cache would never be used.
 */
export function summaryMaxTokens(input: { reserveTokens: number; modelMaxTokens: number }): number {
	const byReserve = Math.floor(0.8 * input.reserveTokens);
	return input.modelMaxTokens > 0 ? Math.min(byReserve, input.modelMaxTokens) : byReserve;
}

export function createPrecompute(): PrecomputeState {
	return { status: "idle" };
}

export function shouldStartPrecompute(input: {
	tokens: number;
	window: number;
	start: number;
}): boolean {
	if (input.window <= 0) return false;
	return input.tokens / input.window >= input.start;
}

export function reducePrecompute(
	state: PrecomputeState,
	action: PrecomputeAction,
): PrecomputeState {
	switch (action.type) {
		case "start": {
			// One attempt at a time. A second start while running keeps the in-flight attempt.
			if (state.status === "running") return state;
			return {
				status: "running",
				attemptId: action.attemptId,
				coveredThroughId: action.coveredThroughId,
			};
		}
		case "finish": {
			// A result from another attempt is stale. Ignore it rather than overwrite the current one.
			if (state.status !== "running" || state.attemptId !== action.attemptId) return state;
			return { ...state, status: "ready", summary: action.summary, usage: action.usage };
		}
		case "fail": {
			if (state.status !== "running" || state.attemptId !== action.attemptId) return state;
			return {
				status: "failed",
				attemptId: state.attemptId,
				coveredThroughId: state.coveredThroughId,
				error: action.error,
			};
		}
		case "abort": {
			// A user interrupt discards whatever was in flight or ready.
			return createPrecompute();
		}
		case "consumed": {
			return createPrecompute();
		}
	}
}

/**
 * The conversation messages of a branch, in order. Only `message` entries carry conversation
 * text, so compaction, model-change and other metadata entries are dropped. The summary model
 * is shown these messages, not the raw session file.
 */
export function messagesOf<T extends { type: string }>(
	entries: readonly T[],
): Array<T extends { type: "message"; message: infer M } ? M : never> {
	return entries
		.filter((entry): entry is T & { type: "message"; message: unknown } => entry.type === "message")
		.map((entry) => entry.message) as Array<
		T extends { type: "message"; message: infer M } ? M : never
	>;
}

/**
 * Whether a cached summary covering up to `coveredThroughId` may stand in for pi's summary,
 * given pi's own cut `cutId` (its `firstKeptEntryId`). The cached summary must cover only
 * messages strictly before the cut. The cut message itself is kept verbatim, so covering it
 * would drop it; covering past it would swallow kept messages. Both ids must be on the branch.
 */
export function coversBeforeCut(
	branchIds: readonly string[],
	coveredThroughId: string,
	cutId: string,
): boolean {
	const covered = branchIds.indexOf(coveredThroughId);
	const cut = branchIds.indexOf(cutId);
	if (covered === -1 || cut === -1) return false;
	return covered < cut;
}

/**
 * Decide whether the cached summary can replace the real compaction.
 * It is used only when ready, and only when the message it covers is still on the
 * active branch. Otherwise the caller falls back to ordinary compaction.
 */
export function consumeForCompaction(
	state: PrecomputeState,
	branchIds: readonly string[],
	cut: { isSplitTurn: boolean } = { isSplitTurn: false },
): ConsumeResult {
	// A split turn needs pi's two-summary merge. A single cached summary cannot stand in for it.
	if (cut.isSplitTurn) {
		return { use: false, reason: "split turn needs two summaries" };
	}
	if (
		state.status !== "ready" ||
		state.summary === undefined ||
		state.coveredThroughId === undefined
	) {
		return {
			use: false,
			reason: state.status === "failed" ? "pre-summary failed" : "no ready pre-summary",
		};
	}
	if (!branchIds.includes(state.coveredThroughId)) {
		return { use: false, reason: "covered message left the branch" };
	}
	return { use: true, summary: state.summary, coveredThroughId: state.coveredThroughId };
}
