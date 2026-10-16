import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { config } from "./config/config.ts";
import { applyBgShellFromPiMine } from "./bg-shell/index.ts";

// lifecycle / editor UX
import delegateStatusFix from "./delegate-status-fix.ts";
import escRestore from "./esc-restore.ts";
import askUserQuestion from "./ask-user-question/index.ts";
import codeCheckpoint from "./checkpoint/index.ts";
import graft from "./graft.ts";
import hooks from "./hooks.ts";
import idleRecap from "./idle-recap.ts";
import notifications from "./notifications.ts";
import permissions from "./permissions.ts";
import readGuard from "./read-guard.ts";
import writeGuard from "./write-guard.ts";
import skillTool from "./skill-tool.ts";
import sessionInvariants from "./session-invariants.ts";
import thinkingProfiles from "./thinking-profiles.ts";

// task status panel (shared by subagent/index.ts and subagent-model-router.ts)
import taskDock from "./task-dock.ts";

// subagent delegation: the routed tool + its model/tier router hook
import subagentRouted from "./subagent/index.ts";
import subagentModelRouter from "./subagent-model-router.ts";
import mcpBridge from "./subagent/mcp-bridge.ts";

// dashboards / context economy
import tliveBridge from "./tlive-bridge.ts";
import tmuxStatus from "./tmux-status.ts";
import toolSearch from "./tool-search.ts";
import metricsLogger from "./metrics-logger.ts";
import costMonitor from "./cost-monitor.ts";
import { searchSessions, sessionCandidateFromEntries } from "./session-search.ts";

export default function (pi: ExtensionAPI): void {
	// First, so pi-background-tasks (which reads PI_BG_POSIX_SHELL when its factory runs) sees it.
	applyBgShellFromPiMine();
	pi.registerTool({
		name: "session_search",
		label: "Session search",
		description:
			"Search bounded session metadata and the current transcript with deterministic ranking.",
		parameters: Type.Object({
			query: Type.String({ description: "Natural-language search query" }),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
			candidates: Type.Optional(
				Type.Array(
					Type.Object({
						id: Type.String(),
						title: Type.Optional(Type.String()),
						tags: Type.Optional(Type.Array(Type.String())),
						branch: Type.Optional(Type.String()),
						summary: Type.Optional(Type.String()),
						firstPrompt: Type.Optional(Type.String()),
						transcript: Type.Optional(Type.String()),
					}),
				),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const manager = ctx.sessionManager as unknown as {
				getEntries?: () => unknown[];
				getSessionId?: () => string;
			};
			const candidates = params.candidates ?? [
				sessionCandidateFromEntries(
					manager.getSessionId?.() ?? "current",
					manager.getEntries?.() ?? [],
				),
			];
			const results = searchSessions(params.query, candidates, params.limit ?? 20);
			return {
				content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
				details: { results },
			};
		},
	});
	if (config.enableDelegateStatusFix) delegateStatusFix(pi);
	if (config.enableEscRestore) escRestore(pi);
	if (config.enableCodeCheckpoint) codeCheckpoint(pi);
	graft(pi);
	if (config.enableHooks) hooks(pi);
	if (config.enableIdleRecap) idleRecap(pi);
	if (config.enableNotifications) notifications(pi);
	if (config.enablePermissions) permissions(pi);
	if (config.enableReadGuard) readGuard(pi);
	writeGuard(pi);
	skillTool(pi);
	if (config.enableSessionInvariants) sessionInvariants(pi);
	if (config.enableThinkingProfiles) thinkingProfiles(pi);
	if (config.enableTaskDock) taskDock(pi);
	askUserQuestion(pi);
	if (config.enableSubagentRouted) {
		subagentRouted(pi);
		subagentModelRouter(pi);
	}
	mcpBridge(pi);
	if (config.enableTliveBridge) tliveBridge(pi);
	if (config.enableTmuxStatus) tmuxStatus(pi);
	if (config.enableToolSearch) toolSearch(pi);
	if (config.enableMetrics) metricsLogger(pi);
	costMonitor(pi);
}
