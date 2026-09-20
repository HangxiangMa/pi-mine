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
let graftStatus: string | undefined;
let statusSlotInitialized = false;

function isOff(): boolean {
	return process.env.PI_THINKING_PROFILES_OFF === "1";
}

/** Keep Graft in the profile slot; later status registrations stay at the tail. */
export function setGraftStatus(ctx: ExtensionContext | undefined, text: string): void {
	graftStatus = text;
	if (!statusSlotInitialized) return;
	try {
		if (ctx?.hasUI) {
			const label = text.startsWith("graft:")
				? ctx.ui.theme.fg("muted", "graft:") + text.slice("graft:".length)
				: text;
			ctx.ui.setStatus(STATUS_KEY, `| ${label} | `);
		}
	} catch {
		// Optional status UI must never affect the turn.
	}
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

	pi.setThinkingLevel(level);
	ctx.ui.notify(`Profile "${profile}" selected (thinking:${pi.getThinkingLevel()})`, "info");
	return true;
}

export default function thinkingProfiles(pi: ExtensionAPI): void {
	// Register after graft's session handler so this key keeps the old profile slot.
	pi.on("session_start", async (_event, ctx) => {
		statusSlotInitialized = true;
		if (graftStatus !== undefined) setGraftStatus(ctx, graftStatus);
	});
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
}
