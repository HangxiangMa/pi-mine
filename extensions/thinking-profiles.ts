/** Map stable workflow profiles to pi's public thinking-level API. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { config, DEFAULT_PROFILES, type ProfileName, type ThinkingLevel } from "./config/config.ts";

const PROFILE_NAMES = Object.keys(DEFAULT_PROFILES) as ProfileName[];
const PROFILE_LEVELS = new Set<ThinkingLevel>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);
const STATUS_KEY = "thinking-profile";

function isOff(): boolean {
	return process.env.PI_THINKING_PROFILES_OFF === "1";
}

let activeProfile: ProfileName | undefined;

function profileForLevel(level: ThinkingLevel): ProfileName | undefined {
	return PROFILE_NAMES.find((name) => config.profiles[name] === level);
}

function updateStatus(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const profile = activeProfile ?? "none";
	ctx.ui.setStatus(
		STATUS_KEY,
		ctx.ui.theme.fg("muted", `profile:${profile} · thinking:${pi.getThinkingLevel()}`),
	);
}

function availableProfiles(): string {
	return PROFILE_NAMES.map((name) => `${name}=${config.profiles[name]}`).join(", ");
}

async function applyProfile(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	name: string,
): Promise<boolean> {
	if (!PROFILE_NAMES.includes(name as ProfileName)) {
		ctx.ui.notify(`Unknown profile "${name}". Available: ${availableProfiles()}`, "error");
		return false;
	}
	const profile = name as ProfileName;
	const level = config.profiles[profile];
	if (!PROFILE_LEVELS.has(level)) {
		ctx.ui.notify(`Invalid thinking level for profile "${profile}"`, "error");
		return false;
	}

	activeProfile = profile;
	pi.setThinkingLevel(level);
	updateStatus(pi, ctx);
	ctx.ui.notify(`Profile "${profile}" selected (thinking:${pi.getThinkingLevel()})`, "info");
	return true;
}

export default function thinkingProfiles(pi: ExtensionAPI): void {
	if (isOff()) return;

	pi.registerCommand("profile", {
		description: "Select a thinking profile: /profile code|review|sift|quick",
		handler: async (args, ctx) => {
			const name = args.trim();
			if (!name) {
				ctx.ui.notify(`Usage: /profile <name>. Available: ${availableProfiles()}`, "info");
				return;
			}
			await applyProfile(pi, ctx, name);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		activeProfile = profileForLevel(pi.getThinkingLevel());
		updateStatus(pi, ctx);
	});

	pi.on("thinking_level_select", async (event, ctx) => {
		const level = event.level as ThinkingLevel;
		if (!activeProfile || config.profiles[activeProfile] !== level) {
			activeProfile = profileForLevel(level);
		}
		updateStatus(pi, ctx);
	});
}
