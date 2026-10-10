/** Shared model-aware request budget. No numeric window implies 1M support. */
export interface ContextBudget {
	contextWindow: number;
	compactThreshold: number;
	defaultOutputTokens: number;
	maxOutputTokens: number;
	escalationOutputTokens?: number;
}

export interface ContextBudgetInput {
	contextWindow?: number;
	maxOutputTokens?: number;
	providerSupportsLongContext?: boolean;
	explicitLongContext?: boolean;
	compactThreshold?: number;
	defaultOutputTokens?: number;
	escalationOutputTokens?: number;
}

const STANDARD_CONTEXT_WINDOW = 200_000;
const LONG_CONTEXT_WINDOW = 1_000_000;
const DEFAULT_OUTPUT = 32_768;

export function contextBudget(input: ContextBudgetInput = {}): ContextBudget {
	const longContext =
		input.providerSupportsLongContext === true && input.explicitLongContext === true;
	const contextWindow = longContext
		? LONG_CONTEXT_WINDOW
		: input.contextWindow && input.contextWindow > 0
			? input.contextWindow
			: STANDARD_CONTEXT_WINDOW;
	const maxOutputTokens = Math.max(
		1,
		input.maxOutputTokens ?? Math.min(128_000, Math.floor(contextWindow / 4)),
	);
	return {
		contextWindow,
		compactThreshold: input.compactThreshold ?? Math.floor(contextWindow * 0.8),
		defaultOutputTokens: input.defaultOutputTokens ?? Math.min(DEFAULT_OUTPUT, maxOutputTokens),
		maxOutputTokens,
		escalationOutputTokens: input.escalationOutputTokens,
	};
}

export function escalateOutputBudget(
	budget: ContextBudget,
	alreadyEscalated: boolean,
): ContextBudget {
	if (
		alreadyEscalated ||
		!budget.escalationOutputTokens ||
		budget.escalationOutputTokens <= budget.maxOutputTokens
	)
		return budget;
	return { ...budget, maxOutputTokens: budget.escalationOutputTokens };
}

export function isOutputLimitError(error: unknown): boolean {
	const text = error instanceof Error ? error.message : String(error);
	return /(?:output|token).*(?:limit|length|truncat)|max_tokens/i.test(text);
}

export function shouldRetryOutputLimit(attempts: number, error: unknown): boolean {
	return attempts === 0 && isOutputLimitError(error);
}

/** Resolve budgets only from explicit provider/model declarations, never from a large number alone. */
export function contextBudgetForModel(model?: string): ContextBudget {
	const explicitModels = (process.env.PI_LONG_CONTEXT_MODELS ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	const explicitLongContext = Boolean(model && explicitModels.includes(model));
	const providerSupportsLongContext = process.env.PI_PROVIDER_LONG_CONTEXT === "1";
	const configuredWindow = Number(process.env.PI_CONTEXT_WINDOW);
	const configuredOutput = Number(process.env.PI_MAX_OUTPUT_TOKENS);
	const configuredContextWindow =
		Number.isFinite(configuredWindow) && configuredWindow > 0 ? configuredWindow : undefined;
	const contextWindow =
		providerSupportsLongContext && explicitLongContext
			? configuredContextWindow
			: configuredContextWindow && configuredContextWindow < STANDARD_CONTEXT_WINDOW
				? configuredContextWindow
				: undefined;
	return contextBudget({
		contextWindow,
		maxOutputTokens:
			Number.isFinite(configuredOutput) && configuredOutput > 0 ? configuredOutput : undefined,
		providerSupportsLongContext,
		explicitLongContext,
		escalationOutputTokens: Number(process.env.PI_ESCALATION_OUTPUT_TOKENS) || undefined,
	});
}

export function contextBudgetFromEnv(): ContextBudget | undefined {
	try {
		const value = JSON.parse(
			process.env.PI_CONTEXT_BUDGET ?? "null",
		) as Partial<ContextBudget> | null;
		if (!value || typeof value.contextWindow !== "number") return undefined;
		return contextBudget(value);
	} catch {
		return undefined;
	}
}
