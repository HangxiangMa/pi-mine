// Diagnostic probe for the selection window's key handling. It is off unless PI_PICKER_PROBE=1 is
// set, and it only observes: it never consumes a key and never changes picker state. It exists to
// answer one question from a live session: does a given key reach the open selection window, and
// what does it do there.

import { appendFileSync } from "node:fs";

/** True only when the probe is explicitly enabled. Any other value, or no value, means off. */
export function probeEnabled(env: Record<string, string | undefined>): boolean {
	return env.PI_PICKER_PROBE === "1";
}

/** Raw bytes in a readable escape form, e.g. "\x1b[A" becomes "ESC[A". */
function readable(bytes: string): string {
	return bytes.replace(/\x1b/g, "ESC").replace(/[\x00-\x1f\x7f]/g, (c) => `^${String.fromCharCode(c.charCodeAt(0) + 64)}`);
}

export interface ProbeEvent {
	readonly bytes: string;
	/** The action the key maps to, or undefined when it maps to nothing. */
	readonly action: string | undefined;
	readonly cursorBefore: number;
	readonly cursorAfter: number;
	readonly at: number;
}

/** One line per key. An unmapped key says so instead of disappearing from the log. */
export function formatProbeLine(event: ProbeEvent): string {
	const what = event.action ?? "no action";
	return `${new Date(event.at).toISOString()} key=${readable(event.bytes)} ${what} cursor ${event.cursorBefore}->${event.cursorAfter}`;
}

/** Where probe lines go. Kept beside the other diagnostics in /tmp, not in the repository. */
export const PROBE_LOG = "/tmp/pi-picker-probe.log";

/** Append one line. Errors are swallowed: a diagnostic must never break the picker. */
export function writeProbe(event: ProbeEvent): void {
	try {
		appendFileSync(PROBE_LOG, `${formatProbeLine(event)}\n`);
	} catch {
		/* the probe is optional */
	}
}
