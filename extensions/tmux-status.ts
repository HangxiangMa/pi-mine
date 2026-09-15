/**
 * tmux-status — mirror pi's lifecycle state into the same per-window option
 * Claude Code uses, so qcom-public-dotfiles/tmux/tmux.conf renders both clients
 * identically in the tmux window list.
 *
 * States intentionally match claude/tmux-claude-status.sh:
 *   busy = cog, wait = bell, done = check, idle = clear
 *
 * This extension is best-effort. It never shells through a user command, never
 * waits in a pi lifecycle handler, and treats a missing/broken tmux as normal
 * (pi is also commonly run outside tmux). The queue preserves lifecycle order;
 * without it, a slow `done` update could arrive after a newer `busy` update.
 *
 * CONFIG (env):
 *   PI_TMUX_STATUS_OFF=1  disable the bridge entirely.
 */

import { execFile } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type TmuxState = "busy" | "wait" | "done" | "idle";

const TMUX_OPTION = "@claude_status";
const INTERACTIVE_MODES = new Set(["tui", "rpc"]);
const HEX_BY_STATE: Record<TmuxState, string> = {
	busy: "f013",
	wait: "f0f3",
	done: "f00c",
	idle: "",
};

function isInteractive(ctx: ExtensionContext): boolean {
	return INTERACTIVE_MODES.has(String(ctx.mode));
}

function badgeForState(state: TmuxState): string {
	const hex = HEX_BY_STATE[state];
	return hex ? String.fromCodePoint(Number.parseInt(hex, 16)) : "";
}

function currentTmuxPane(): string | undefined {
	if (process.env.TMUX === undefined || process.env.TMUX === "") return undefined;
	const pane = process.env.TMUX_PANE;
	return pane && /^%\d{1,20}$/u.test(pane) ? pane : undefined;
}

function writeTmuxState(state: TmuxState): Promise<void> {
	const pane = currentTmuxPane();
	if (!pane) return Promise.resolve();

	return new Promise((resolve) => {
		try {
			execFile(
				"tmux",
				["set-option", "-w", "-q", "-t", pane, TMUX_OPTION, badgeForState(state)],
				{ timeout: 1_000, windowsHide: true },
				() => resolve(),
			);
		} catch {
			// A missing executable or a teardown race must not affect pi.
			resolve();
		}
	});
}

export default function tmuxStatus(pi: ExtensionAPI): void {
	if (process.env.PI_TMUX_STATUS_OFF === "1") return;

	let active = false;
	let queue = Promise.resolve();

	const publish = (state: TmuxState): void => {
		// Do not await this chain from an event handler: execFile can be slow when
		// a tmux server is starting or disappearing.
		queue = queue.then(() => writeTmuxState(state)).catch(() => undefined);
	};
	const publishIfActive = (state: TmuxState, ctx: ExtensionContext): void => {
		if (active && isInteractive(ctx)) publish(state);
	};

	pi.on("session_start", (_event, ctx) => {
		active = isInteractive(ctx);
		if (active) publish("idle");
	});

	pi.on("input", (_event, ctx) => publishIfActive("busy", ctx));
	pi.on("agent_start", (_event, ctx) => publishIfActive("busy", ctx));
	pi.on("turn_start", (_event, ctx) => publishIfActive("busy", ctx));
	pi.on("tool_execution_start", (_event, ctx) => publishIfActive("busy", ctx));

	pi.on("ui_prompt_start", (_event, ctx) => publishIfActive("wait", ctx));
	pi.on("ui_prompt_end", (_event, ctx) => {
		if (!active || !isInteractive(ctx)) return;
		// A prompt can be a permission/confirmation that resumes the run. Only
		// show done when pi is genuinely idle after the prompt closes.
		publish(ctx.isIdle() ? "done" : "busy");
	});

	// agent_end is deliberately not mapped: pi may retry, compact, or continue
	// with another turn after it. agent_settled is its Stop-equivalent boundary.
	pi.on("agent_settled", (_event, ctx) => publishIfActive("done", ctx));

	pi.on("session_shutdown", (_event, ctx) => {
		if (!active || !isInteractive(ctx)) return;
		publish("idle");
		active = false;
	});
}

export const __test = {
	badgeForState,
	currentTmuxPane,
	isInteractive,
};
