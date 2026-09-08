/**
 * notifications — fire an OS-level notification when a turn that took a while
 * finally settles (Claude Code's PushNotification-on-Stop behavior).
 *
 * WHY: `ctx.ui.notify` is in-TUI only (no OS push), and `agent_settled` carries
 * no duration/cost payload, so "was this turn long enough to be worth a ding"
 * has to be tracked locally from the interactive prompt that started it.
 * `agent_settled` (not `agent_end`) is used because it only fires once a run
 * has fully finished with no automatic retry/compaction/queued continuation
 * still pending.
 *
 * CONFIG (env):
 *   PI_NOTIFY_OFF=1            disable entirely.
 *   PI_NOTIFY_MIN_MS=15000     minimum turn duration before notifying (default 15s).
 */

import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_MIN_MS = 15_000;

function minMs(): number {
	const raw = Number(process.env.PI_NOTIFY_MIN_MS);
	return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MIN_MS;
}

function formatDuration(ms: number): string {
	const totalSeconds = Math.round(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}m ${seconds}s`;
}

function sendOsNotification(title: string, body: string): void {
	const command =
		process.platform === "darwin"
			? { bin: "osascript", args: ["-e", `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`] }
			: { bin: "notify-send", args: [title, body] };
	const child = execFile(command.bin, command.args);
	child.on("error", () => {});
}

export default function notifications(pi: ExtensionAPI) {
	if (process.env.PI_NOTIFY_OFF === "1") return;

	let turnStartedAt: number | undefined;

	pi.on("input", async (event, ctx) => {
		if (event.source === "interactive" && event.text.trim() && ctx.isIdle()) {
			turnStartedAt = Date.now();
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const startedAt = turnStartedAt;
		turnStartedAt = undefined;
		if (!startedAt || !ctx.hasUI) return;

		const elapsedMs = Date.now() - startedAt;
		if (elapsedMs < minMs()) return;

		const message = `finished in ${formatDuration(elapsedMs)}`;
		ctx.ui.notify(message, "info");
		sendOsNotification("pi", message);
	});
}
