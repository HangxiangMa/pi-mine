import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { budgetFromChildEnv, clampOutputCap } from "./output-budget.ts";

/**
 * Registers the child-side output-cap clamp. Inert unless this process is a routed
 * subagent with a PI_CONTEXT_BUDGET. Fails open on any error.
 */
export default function outputBudgetHook(pi: ExtensionAPI): void {
	const budget = budgetFromChildEnv();
	if (!budget) return;
	pi.on("before_provider_request", (event) => {
		try {
			return clampOutputCap(event.payload, budget);
		} catch {
			return event.payload;
		}
	});
}
