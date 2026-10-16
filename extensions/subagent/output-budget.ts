import { contextBudgetFromEnv, type ContextBudget } from "../context-budget.ts";

/**
 * Output-cap field names used by the provider payloads pi sends. Each provider
 * uses one of these. The clamp only touches fields that are present, so a
 * payload with an unknown shape passes through unchanged.
 */
const OUTPUT_CAP_FIELDS = [
	"max_tokens",
	"max_completion_tokens",
	"max_output_tokens",
	"maxOutputTokens",
] as const;

/**
 * Lower an outgoing request's output cap to the child's budget. Never raises a
 * cap, and never adds a field the payload did not already carry. Returns the same
 * object when nothing changes so callers can skip replacing the payload.
 */
export function clampOutputCap(payload: unknown, budget: ContextBudget): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
	const record = payload as Record<string, unknown>;
	let next: Record<string, unknown> | undefined;
	for (const field of OUTPUT_CAP_FIELDS) {
		const current = record[field];
		if (typeof current !== "number" || !Number.isFinite(current)) continue;
		if (current <= budget.maxOutputTokens) continue;
		next ??= { ...record };
		next[field] = budget.maxOutputTokens;
	}
	return next ?? payload;
}

/**
 * Child-side wiring. Active only inside a routed subagent (PI_SUBAGENT_RUN_ID set)
 * and only when the router passed a valid PI_CONTEXT_BUDGET. Fails open: any error
 * leaves the original payload in place.
 */
export function budgetFromChildEnv(
	env: NodeJS.ProcessEnv = process.env,
): ContextBudget | undefined {
	if (!env.PI_SUBAGENT_RUN_ID) return undefined;
	return contextBudgetFromEnv();
}
