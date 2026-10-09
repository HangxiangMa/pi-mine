/** Current QPilot model prices, in USD per 1M tokens. */
export interface ModelPricing {
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
	/**
	 * Prompt-size break. A single request whose prompt (input + cache read + cache write)
	 * exceeds `breakTokens` bills at `over` instead. Haiku 5.5 publishes this at 100K.
	 */
	breakTokens?: number;
	over?: Omit<ModelPricing, "breakTokens" | "over">;
}

const PRICES: Record<string, ModelPricing> = {
	"gpt-5.1": { input: 1.25, output: 10, cacheRead: 0.125 },
	"gpt-5.2": { input: 1.75, output: 14, cacheRead: 0.175 },
	"gpt-5.4": { input: 2.5, output: 15, cacheRead: 0.25 },
	"gpt-5.4-mini": { input: 0.75, output: 4.5, cacheRead: 0.075 },
	"gpt-5.5": { input: 5, output: 30, cacheRead: 0.5 },
	"gpt-5.6-luna": { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 1.25 },
	"gpt-5.6-sol": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
	"gpt-5.6-terra": { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 3.125 },
	// Official Anthropic 5.5 list prices (https://www.anthropic.com/claude-*-5-5).
	"claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
	"claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
	"claude-haiku-5-5": {
		input: 0.1,
		output: 0.5,
		cacheRead: 0.01,
		cacheWrite: 0.125,
		breakTokens: 100_000,
		over: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
	},
	"claude-4-5-haiku": { input: 0.84, output: 4.2, cacheRead: 0.084, cacheWrite: 1.05 },
	"claude-4-5-haiku:thinking": { input: 1.1, output: 5.5, cacheRead: 1.1, cacheWrite: 1.375 },
	"claude-4-5-sonnet": { input: 2.52, output: 12.6, cacheRead: 0.252, cacheWrite: 3.15 },
	"claude-4-6-opus": { input: 4.2, output: 21, cacheRead: 0.42, cacheWrite: 5.25 },
	"claude-4-6-opus:1M": { input: 30, output: 112.5, cacheRead: 3, cacheWrite: 37.5 },
	"claude-4-6-sonnet": { input: 2.52, output: 12.6, cacheRead: 0.252, cacheWrite: 3.15 },
	"claude-4-6-sonnet:1M": { input: 6.6, output: 24.75, cacheRead: 0.66, cacheWrite: 8.25 },
	"claude-4-7-opus": { input: 4.2, output: 21, cacheRead: 0.42, cacheWrite: 5.25 },
	"claude-4-8-opus": { input: 4.2, output: 21, cacheRead: 0.42, cacheWrite: 5.25 },
	"claude-5-opus": { input: 4.2, output: 21, cacheRead: 0.42, cacheWrite: 5.25 },
	"claude-5-sonnet": { input: 1.68, output: 8.4, cacheRead: 0.168, cacheWrite: 2.1 },
	"deepseek-v4-flash": { input: 0.19, output: 0.51, cacheRead: 0.028 },
	"kimi-k2.7-code": { input: 0.95, output: 4, cacheRead: 0.19 },
	"gemini-2.5-pro": { input: 1.25, output: 10, cacheRead: 0.125 },
	"gemini-3-flash-preview": { input: 0.5, output: 3, cacheRead: 0.05 },
	"gemini-3.1-pro-preview": { input: 2, output: 12, cacheRead: 0.2 },
	"gemini-3.5-flash": { input: 1.5, output: 9, cacheRead: 0.15 },
};

const ALIASES: Record<string, string> = {
	"claude-sonnet-5": "claude-5-sonnet",
	"claude-opus-5": "claude-5-opus",
};

function modelId(modelRef: string): string {
	const slash = modelRef.lastIndexOf("/");
	return (slash >= 0 ? modelRef.slice(slash + 1) : modelRef).trim();
}

export function pricingForModel(modelRef: string | undefined): ModelPricing | undefined {
	if (!modelRef) return undefined;
	const id = modelId(modelRef);
	return PRICES[id] ?? PRICES[ALIASES[id] ?? id];
}

/**
 * Cost of ONE request. A prompt-size break is a per-request rule, so it cannot be applied
 * to a subagent's accumulated usage: a run of short turns and one long turn bill
 * differently. Price each assistant turn here, then sum.
 */
export function estimateRequestCost(
	modelRef: string | undefined,
	tokens: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | undefined,
): number | undefined {
	const base = pricingForModel(modelRef);
	if (!base || !tokens) return undefined;
	const prompt = (tokens.input ?? 0) + (tokens.cacheRead ?? 0) + (tokens.cacheWrite ?? 0);
	const pricing =
		base.breakTokens !== undefined && base.over && prompt > base.breakTokens
			? { ...base, ...base.over }
			: base;
	const value =
		(tokens.input ?? 0) * pricing.input +
		(tokens.output ?? 0) * pricing.output +
		(tokens.cacheRead ?? 0) * (pricing.cacheRead ?? pricing.input) +
		(tokens.cacheWrite ?? 0) * (pricing.cacheWrite ?? pricing.input);
	return Number.isFinite(value) && value > 0 ? value / 1_000_000 : undefined;
}

export function estimateModelCost(
	modelRef: string | undefined,
	tokens: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | undefined,
): number | undefined {
	const pricing = pricingForModel(modelRef);
	if (!pricing || !tokens) return undefined;
	const value =
		(tokens.input ?? 0) * pricing.input +
		(tokens.output ?? 0) * pricing.output +
		(tokens.cacheRead ?? 0) * (pricing.cacheRead ?? pricing.input) +
		(tokens.cacheWrite ?? 0) * (pricing.cacheWrite ?? pricing.input);
	return Number.isFinite(value) && value > 0 ? value / 1_000_000 : undefined;
}
