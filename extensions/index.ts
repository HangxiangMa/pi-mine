import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { config } from "./config/config.ts";

// lifecycle / editor UX
import delegateStatusFix from "./delegate-status-fix.ts";
import escRestore from "./esc-restore.ts";
import hooks from "./hooks.ts";
import idleRecap from "./idle-recap.ts";
import notifications from "./notifications.ts";
import permissions from "./permissions.ts";
import readGuard from "./read-guard.ts";
import sessionInvariants from "./session-invariants.ts";
import thinkingProfiles from "./thinking-profiles.ts";

// task status panel (shared by subagent/index.ts and subagent-model-router.ts)
import taskDock from "./task-dock.ts";

// subagent delegation: the routed tool + its model/tier router hook
import subagentRouted from "./subagent/index.ts";
import subagentModelRouter from "./subagent-model-router.ts";

// dashboards / context economy
import tliveBridge from "./tlive-bridge.ts";
import tmuxStatus from "./tmux-status.ts";
import toolSearch from "./tool-search.ts";
import metricsLogger from "./metrics-logger.ts";

export default function (pi: ExtensionAPI): void {
	if (config.enableDelegateStatusFix) delegateStatusFix(pi);
	if (config.enableEscRestore) escRestore(pi);
	if (config.enableHooks) hooks(pi);
	if (config.enableIdleRecap) idleRecap(pi);
	if (config.enableNotifications) notifications(pi);
	if (config.enablePermissions) permissions(pi);
	if (config.enableReadGuard) readGuard(pi);
	if (config.enableSessionInvariants) sessionInvariants(pi);
	if (config.enableThinkingProfiles) thinkingProfiles(pi);
	if (config.enableTaskDock) taskDock(pi);
	if (config.enableSubagentRouted) {
		subagentRouted(pi);
		subagentModelRouter(pi);
	}
	if (config.enableTliveBridge) tliveBridge(pi);
	if (config.enableTmuxStatus) tmuxStatus(pi);
	if (config.enableToolSearch) toolSearch(pi);
	if (config.enableMetrics) metricsLogger(pi);
}
