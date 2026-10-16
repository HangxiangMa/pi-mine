/**
 * Pre-compaction cache: wires the pure state machine in `precompute-state.ts` to pi.
 *
 * Pi's own compaction holds the next turn until the summary call returns. This extension
 * starts that call early, in the background, once context passes PRECOMPACT_START_FRACTION
 * of the window. When pi reaches its real compaction threshold, a ready summary is handed
 * back in `session_before_compact` instead of being computed then. pi still chooses the cut
 * (`firstKeptEntryId`) and the token count, so the kept messages stay exactly what pi expects.
 *
 * Fail open throughout: any error here leaves pi's default compaction untouched.
 * Config: `enablePrecompact` in pi-mine.json (default on).
 */

import {
	DEFAULT_COMPACTION_SETTINGS,
	type ExtensionAPI,
	type ExtensionContext,
	convertToLlm,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import {
	type PrecomputeState,
	PRECOMPACT_START_FRACTION,
	consumeForCompaction,
	createPrecompute,
	messagesOf,
	summaryMaxTokens,
	reducePrecompute,
	shouldStartPrecompute,
} from "./precompute-state.ts";

const SUMMARY_PROMPT =
	"Summarise the conversation so far for a coding session. Keep the user's goal, constraints and " +
	"decisions, the files touched, and the open next steps. Plain prose or short bullets. No preamble.";

function extractText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((block) =>
			block && typeof block === "object" && (block as { type?: string }).type === "text"
				? ((block as { text?: string }).text ?? "")
				: "",
		)
		.join("")
		.trim();
}

function branchIdsOf(entries: readonly { id: string }[]): string[] {
	return entries.map((entry) => entry.id);
}

/** Opt-in visible trace for manual verification. Off by default so it never adds noise. */
function trace(ctx: ExtensionContext | undefined, message: string): void {
	if (process.env.PI_PRECOMPACT_DEBUG !== "1") return;
	try {
		ctx?.ui?.notify?.(`[precompact] ${message}`, "info");
	} catch {
		// best-effort trace
	}
}

export default function precompact(pi: ExtensionAPI): void {
	if (process.env.PI_PRECOMPACT_OFF === "1") return;

	let state: PrecomputeState = createPrecompute();
	let nextAttemptId = 1;
	let inFlight: AbortController | undefined;

	function contextFraction(ctx: ExtensionContext): number | undefined {
		const usage = ctx.getContextUsage?.();
		if (!usage || typeof usage.percent !== "number") return undefined;
		return usage.percent / 100;
	}

	function abortInFlight(): void {
		inFlight?.abort();
		inFlight = undefined;
		state = reducePrecompute(state, { type: "abort" });
	}

	async function startPrecompute(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI || !ctx.model) return;
		const model = ctx.model;
		const branch = ctx.sessionManager.getBranch?.() ?? [];
		const head = branch.at(-1);
		if (!head) return;
		// The current branch's conversation messages as plain text, the same shape pi itself summarises.
		const conversation = serializeConversation(convertToLlm(messagesOf(branch)));
		if (!conversation.trim()) return;

		const attemptId = nextAttemptId++;
		const controller = new AbortController();
		inFlight = controller;
		state = reducePrecompute(state, { type: "start", attemptId, coveredThroughId: head.id });
		trace(ctx, `pre-summary started (${conversation.length} chars, covers ${head.id})`);

		try {
			const response = await ctx.modelRegistry.complete(
				model,
				{
					systemPrompt: SUMMARY_PROMPT,
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: conversation }],
							timestamp: Date.now(),
						},
					],
				},
				{
					maxTokens: summaryMaxTokens({
						reserveTokens: DEFAULT_COMPACTION_SETTINGS.reserveTokens,
						modelMaxTokens: model.maxTokens,
					}),
					signal: controller.signal,
				},
			);
			const summary = extractText(response.content);
			if (!summary || response.stopReason === "length") {
				trace(ctx, `pre-summary failed: empty or truncated (stop=${response.stopReason})`);
				state = reducePrecompute(state, {
					type: "fail",
					attemptId,
					error: "empty or truncated summary",
				});
				return;
			}
			trace(ctx, `pre-summary ready (${summary.length} chars)`);
			state = reducePrecompute(state, {
				type: "finish",
				attemptId,
				summary,
				usage: { input: response.usage?.input ?? 0 },
			});
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			trace(ctx, `pre-summary failed: ${reason.slice(0, 160)}`);
			state = reducePrecompute(state, {
				type: "fail",
				attemptId,
				error: reason,
			});
		} finally {
			if (inFlight === controller) inFlight = undefined;
		}
	}

	pi.on("turn_end", async (_event, ctx) => {
		try {
			const fraction = contextFraction(ctx);
			if (fraction === undefined) return;
			if (state.status !== "idle" && state.status !== "failed") return;
			const usage = ctx.getContextUsage?.();
			if (!usage || typeof usage.tokens !== "number" || typeof usage.contextWindow !== "number")
				return;
			if (
				!shouldStartPrecompute({
					tokens: usage.tokens,
					window: usage.contextWindow,
					start: PRECOMPACT_START_FRACTION,
				})
			) {
				return;
			}
			void startPrecompute(ctx);
		} catch {
			// fail open: a broken pre-summary must never break the session
		}
	});

	pi.on("message_start", async (event) => {
		try {
			if (event.message.role !== "user") return;
			// Real user activity wins over a pre-summary still in flight.
			abortInFlight();
		} catch {
			// fail open
		}
	});

	pi.on("session_before_compact", async (event, ctx) => {
		try {
			const branchIds = branchIdsOf(event.branchEntries);
			const decision = consumeForCompaction(state, branchIds, {
				isSplitTurn: event.preparation.isSplitTurn,
			});
			if (!decision.use) {
				trace(ctx, `pre-summary not used: ${decision.reason}`);
				return undefined;
			}
			state = reducePrecompute(state, { type: "consumed" });
			trace(ctx, "pre-summary used for compaction");
			return {
				compaction: {
					summary: decision.summary,
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
				},
			};
		} catch {
			return undefined;
		}
	});

	pi.on("session_start", async () => {
		abortInFlight();
	});
}
