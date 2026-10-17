/**
 * Keeps attested off because the office uses a company relay and traffic management, not subscription OAuth.
 * pi-background-tasks reads PI_BG_FEATURES at factory time, and pi-mine loads first.
 */
export const BG_FEATURES_ENV = "PI_BG_FEATURES";
export const BG_FEATURES_WITHOUT_ATTESTED = "process,delegate,fusion,attribution";

/** Set PI_BG_FEATURES unless the user already chose a non-empty value. Idempotent. */
export function applyBgFeaturesPolicy(env: NodeJS.ProcessEnv): void {
	if (env[BG_FEATURES_ENV] !== undefined && env[BG_FEATURES_ENV] !== "") return;
	env[BG_FEATURES_ENV] = BG_FEATURES_WITHOUT_ATTESTED;
}
