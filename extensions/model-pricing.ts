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

/**
 * Route-specific prices, keyed by the full `provider/id` reference. These win over the
 * bundled catalog because the same model id can be billed differently per route: the
 * Breeze gateway bills Haiku 5.5 flat at $1/$5 (verified against provider-reported cost
 * on every breeze turn, no 100K break), while Anthropic direct bills $0.10/$0.50 with a
 * break. Keep this in sync with models.json for the gateway provider.
 */
const ROUTE_PRICES: Record<string, ModelPricing> = {
	"breeze/claude-haiku-5-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
	// The gateway bills these at its own rate, not the QGenie rate the ALIASES map to.
	"breeze/claude-opus-5": { input: 5, output: 25 },
	"breeze/claude-sonnet-5": { input: 2, output: 10 },
};

/**
 * A `-1m` provider is the long-context route of the same model. Its price is higher than
 * the standard one (e.g. Gemini 2.5 Pro 1M is $2.5/$15 vs $1.25/$10). The bundled table
 * holds only standard prices, so a 1M route must stay unpriced rather than inherit the
 * standard rate and be undercharged.
 */
function isLongContextRoute(modelRef: string): boolean {
	const slash = modelRef.indexOf("/");
	const provider = slash > 0 ? modelRef.slice(0, slash) : "";
	return /-1m$/i.test(provider);
}

/**
 * Vendor-prefixed ids such as `anthropic::claude-5-opus` are the same model as
 * `claude-5-opus`; the `vertexai::` / `anthropic::` part names the upstream, not the model.
 */
function catalogId(modelRef: string): string {
	const id = modelId(modelRef);
	const scope = id.lastIndexOf("::");
	return scope >= 0 ? id.slice(scope + 2) : id;
}

export function pricingForModel(modelRef: string | undefined): ModelPricing | undefined {
	if (!modelRef) return undefined;
	const routed = ROUTE_PRICES[modelRef.trim()];
	if (routed) return routed;
	if (isLongContextRoute(modelRef)) return undefined;
	const id = catalogId(modelRef);
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
