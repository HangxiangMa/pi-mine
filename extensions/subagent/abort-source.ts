/**
 * Which abort path produced an exit 130. A user cancel (cancelSubagentRun / the run
 * view's cancel action) takes precedence over the parent's abort signal when both
 * fired, because the user's explicit cancel is the cause a human would report.
 * Returns undefined when neither fired, so the caller leaves the field unset.
 */
export type AbortSource = "user-cancel" | "signal-abort";

export function abortSourceFor(
	wasCancelled: boolean,
	wasAborted: boolean,
): AbortSource | undefined {
	if (wasCancelled) return "user-cancel";
	if (wasAborted) return "signal-abort";
	return undefined;
}
