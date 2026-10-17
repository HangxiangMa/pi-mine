/**
 * config — top-level enable/disable switches for pi-mine's migrated features.
 *
 * Mirrors pi-cc-extensions' extensions/config/config.ts: a process-wide `config`
 * object, loaded once from `<agentDir>/pi-mine.json`, read directly as
 * `config.xxx`, written only through `updateConfig`.
 *
 * These booleans are a SEPARATE layer from each feature's own env-var switch
 * (`PI_HOOKS_OFF`, `PI_TASK_DOCK_OFF`, `PI_TLIVE_OFF`, `PI_TMUX_STATUS_OFF`,
 * `PI_TOOLSEARCH_OFF`, `PI_ESC_RESTORE_OFF`, `PI_NOTIFY_OFF`, `PI_PERMISSIONS_OFF`) that several of the
 * migrated files already read internally — this file does not re-read or
 * shadow any of those env vars, so there is exactly one env-var gate per
 * feature (inside the feature file itself, untouched) and exactly one
 * config-file gate per feature (here, wired in extensions/index.ts). All
 * default to `true`: none of these were optional before this migration.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ProfileName = "code" | "review" | "sift" | "quick";
export type ThinkingProfiles = Record<ProfileName, ThinkingLevel>;

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

export const DEFAULT_PROFILES: ThinkingProfiles = {
	code: "high",
	review: "xhigh",
	sift: "medium",
	quick: "low",
};

export type Config = {
	enableThinkingProfiles: boolean;
	enableDelegateStatusFix: boolean;
	enableEscRestore: boolean;
	enableCodeCheckpoint: boolean;
	enableHooks: boolean;
	enableIdleRecap: boolean;
	enablePrecompact: boolean;
	enableNotifications: boolean;
	enablePermissions: boolean;
	enableSubagentRouted: boolean;
	enableTaskDock: boolean;
	enableTliveBridge: boolean;
	enableTmuxStatus: boolean;
	enableToolSearch: boolean;
	enableSessionInvariants: boolean;
	enableReadGuard: boolean;
	enableMetrics: boolean;
	profiles: ThinkingProfiles;
};

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(AGENT_DIR, "pi-mine.json");

export const DEFAULT_CONFIG: Config = {
	enableThinkingProfiles: true,
	enableDelegateStatusFix: true,
	enableEscRestore: true,
	enableCodeCheckpoint: true,
	enableHooks: true,
	enableIdleRecap: true,
	// Paused (2026-10-17): off until the feature is finished. Enable only with an explicit true.
	enablePrecompact: false,
	enableNotifications: true,
	enablePermissions: true,
	enableSubagentRouted: true,
	enableTaskDock: true,
	enableTliveBridge: true,
	enableTmuxStatus: true,
	enableToolSearch: true,
	enableSessionInvariants: true,
	enableReadGuard: true,
	enableMetrics: true,
	profiles: { ...DEFAULT_PROFILES },
};

export function normalizeConfig(input: unknown): Config {
	const source = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
	const rawProfiles = source.profiles && typeof source.profiles === "object" ? source.profiles : {};
	const profiles = { ...DEFAULT_PROFILES };
	for (const name of Object.keys(DEFAULT_PROFILES) as ProfileName[]) {
		const value = (rawProfiles as Record<string, unknown>)[name];
		if (typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevel)) {
			profiles[name] = value as ThinkingLevel;
		}
	}
	return {
		enableThinkingProfiles: source.enableThinkingProfiles !== false,
		enableDelegateStatusFix: source.enableDelegateStatusFix !== false,
		enableEscRestore: source.enableEscRestore !== false,
		enableCodeCheckpoint: source.enableCodeCheckpoint !== false,
		enableHooks: source.enableHooks !== false,
		enableIdleRecap: source.enableIdleRecap !== false,
		enablePrecompact: source.enablePrecompact === true,
		enableNotifications: source.enableNotifications !== false,
		enablePermissions: source.enablePermissions !== false,
		enableSubagentRouted: source.enableSubagentRouted !== false,
		enableTaskDock: source.enableTaskDock !== false,
		enableTliveBridge: source.enableTliveBridge !== false,
		enableTmuxStatus: source.enableTmuxStatus !== false,
		enableToolSearch: source.enableToolSearch !== false,
		enableSessionInvariants: source.enableSessionInvariants !== false,
		enableReadGuard: source.enableReadGuard !== false,
		enableMetrics: source.enableMetrics !== false,
		profiles,
	};
}

export function formatConfigStatus(source: Config = config): string {
	return [
		`thinkingProfiles=${source.enableThinkingProfiles ? "on" : "off"}`,
		`delegateStatusFix=${source.enableDelegateStatusFix ? "on" : "off"}`,
		`escRestore=${source.enableEscRestore ? "on" : "off"}`,
		`codeCheckpoint=${source.enableCodeCheckpoint ? "on" : "off"}`,
		`hooks=${source.enableHooks ? "on" : "off"}`,
		`idleRecap=${source.enableIdleRecap ? "on" : "off"}`,
		`precompact=${source.enablePrecompact ? "on" : "off"}`,
		`notifications=${source.enableNotifications ? "on" : "off"}`,
		`permissions=${source.enablePermissions ? "on" : "off"}`,
		`subagentRouted=${source.enableSubagentRouted ? "on" : "off"}`,
		`taskDock=${source.enableTaskDock ? "on" : "off"}`,
		`tliveBridge=${source.enableTliveBridge ? "on" : "off"}`,
		`tmuxStatus=${source.enableTmuxStatus ? "on" : "off"}`,
		`toolSearch=${source.enableToolSearch ? "on" : "off"}`,
		`sessionInvariants=${source.enableSessionInvariants ? "on" : "off"}`,
		`readGuard=${source.enableReadGuard ? "on" : "off"}`,
		`metrics=${source.enableMetrics ? "on" : "off"}`,
	].join(" · ");
}

/** 进程内唯一的活动配置对象。读取直接用 `config.xxx`；写入必须走 `updateConfig`。 */
export const config: Config = loadConfig();

function loadConfig(): Config {
	try {
		const source = existsSync(CONFIG_PATH)
			? (JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>)
			: {};
		return normalizeConfig(source);
	} catch {
		// Ignore bad config and fall back to defaults.
	}
	return { ...DEFAULT_CONFIG };
}

export function saveConfig() {
	writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

/** 运行时配置写入的唯一入口：合并 + 规范化 + 持久化。 */
export function updateConfig(partial: Partial<Config>): void {
	Object.assign(config, normalizeConfig({ ...config, ...partial }));
	saveConfig();
}

/** 整体替换配置（default export 的 configOverride 注入路径；就地覆盖，不持久化）。 */
export function setConfig(next: Config): void {
	Object.assign(config, next);
}
