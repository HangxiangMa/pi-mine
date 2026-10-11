/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { randomUUID } from "node:crypto";
import { exec as execCommand, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	getAgentDir,
	getMarkdownTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import {
	HANDOFF_CONTRACT,
	MAX_HANDOFF_CHARS,
	isTaskControlRequested,
	normalizeTaskControl,
	type RoutedResultContract,
	parseVerificationStatus,
	prepareHandoff,
	type AgentRuntimePolicy,
	type TaskControl,
	type TaskControlStatus,
	type TaskState,
} from "./packet.ts";
import {
	acquireTakeover,
	changesSinceBaseline,
	createTaskState,
	markTakeoverReady,
	recordTaskAttempt,
	readTaskState,
	submitTakeover,
	TaskStateError,
	updateTaskState,
} from "./task-state.ts";
import {
	getRoutedCallItems,
	routeModelForAgent,
	type RouteEvidence,
} from "../subagent-model-router.ts";
import { estimateModelCost, estimateRequestCost } from "../model-pricing.ts";
import { contextBudgetForModel, type ContextBudget } from "../context-budget.ts";
import { classifyCooldown, coolingModels, recordCooldown } from "./router-health.ts";
import { requestTaskControl, taskDockSnapshot, upsertTask } from "../task-dock.ts";
import { taskTitle } from "../task-title.ts";
import {
	closeSubagentFleetInspector,
	openSubagentFleetInspector,
	type SubagentFleetRun,
	type SubagentRunStatus,
} from "./fleet-inspector.ts";
import {
	cleanupRuntimeResources,
	loadMcpServerConfigs,
	registerRuntimeResource,
	startMcpRuntime,
	type McpRuntimeLifecycle,
} from "./runtime-resources.ts";
import {
	appendPipelineMetric,
	prunePipelineMetrics,
	readPipelineMetricsReport,
	summarizePipelineMetrics,
	type PipelineMetricRecord,
} from "./pipeline-metrics.ts";

const execAsync = promisify(execCommand);
const MAX_PARALLEL_TASKS = 8;
const MAX_CHAIN_STEPS = 6;
const MAX_CONCURRENCY = 4;

function inspectorSnapshot(): SubagentFleetRun[] {
	const external = taskDockSnapshot()
		.filter((run) => run.source === "delegate")
		.map(
			(run): SubagentFleetRun => ({
				id: run.id,
				agent: run.label,
				task: run.detail ?? run.id,
				model: run.model,
				status: run.state === "done" ? "completed" : run.state === "error" ? "failed" : "running",
				startedAt: run.startedAt,
				output: run.summary ?? run.activity ?? "",
				stderr: "",
				inputTokens: run.tokens?.input ?? 0,
				outputTokens: run.tokens?.output ?? 0,
			}),
		);
	return [...subagentFleetSnapshot(), ...external];
}

function isDelegateRun(id: string): boolean {
	return id.startsWith("delegate:");
}

const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
// `--mode json` normally exits immediately after emitting `agent_end`. Keep a
// short bounded grace period for runtimes/extensions that leave a stdio handle
// open after the result is already complete; otherwise the parent tool can wait
// forever on ChildProcess `close` even though the subagent has finished.
const AGENT_END_CLOSE_GRACE_MS = 1_500;
const ABORT_KILL_ESCALATION_MS = 5_000;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "find ") +
				themeFg("accent", pattern) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	/** Per-request fallback cost, summed turn by turn. Used only when the provider reports no cost. */
	requestCostUsd?: number;
	agent: string;
	controlTaskId?: string;
	controlStatus?: TaskControlStatus;
	takeoverReady?: boolean;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	actualModel?: string;
	requestedModel?: string;
	fallback?: boolean;
	routeEvidence?: RouteEvidence;
	routerFallbackFromModel?: string;
	routerFallbackReason?: string;
	routerCooldownUntil?: number;
	routerBlockedReason?: string;
	/** Cooldown this attempt wrote, for TTL calibration in pipeline metrics. */
	routerCooldownWritten?: {
		reason: string;
		until: number;
		failures: number;
		advised: boolean;
	};
	latencyMs?: number;
	stopReason?: string;
	errorMessage?: string;
	verificationStatus?: "pass" | "fail" | "blocked" | "partial";
	needsReplan?: boolean;
	handoff?: { packetValid: boolean; truncated: boolean; chars: number };
	phase?: "scout" | "reason" | "execute" | "verify";
	step?: number;
}

interface ActiveSubagentRun extends SubagentFleetRun {
	cancel?: () => void;
	cancelRequested: boolean;
	done: Promise<SingleResult>;
	resolveDone: (result: SingleResult) => void;
	guide?: (guidance: string) => Promise<string>;
}

const activeSubagentRuns = new Map<string, ActiveSubagentRun>();

function statusForResult(result: SingleResult): SubagentRunStatus {
	if (result.errorMessage === "Subagent was cancelled") return "cancelled";
	return isFailedResult(result) ? "failed" : "completed";
}

function trimFinishedSubagentRuns(): void {
	const finished = [...activeSubagentRuns.values()]
		.filter((run) => run.status !== "running")
		.sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
	while (finished.length > 12) {
		const old = finished.shift();
		if (old) activeSubagentRuns.delete(old.id);
	}
}

export function subagentFleetSnapshot(): SubagentFleetRun[] {
	return [...activeSubagentRuns.values()]
		.sort((a, b) => {
			if (a.status === "running" && b.status !== "running") return -1;
			if (a.status !== "running" && b.status === "running") return 1;
			return b.startedAt - a.startedAt;
		})
		.map((run) => ({
			id: run.id,
			agent: run.agent,
			task: run.task,
			model: run.model,
			status: run.status,
			startedAt: run.startedAt,
			finishedAt: run.finishedAt,
			output: run.output,
			stderr: run.stderr,
			inputTokens: run.inputTokens,
			outputTokens: run.outputTokens,
		}));
}

export function cancelSubagentRun(runId: string): boolean {
	const run = activeSubagentRuns.get(runId);
	if (!run || run.status !== "running" || !run.cancel) return false;
	run.cancelRequested = true;
	run.status = "cancelled";
	run.cancel();
	return true;
}

export async function guideSubagentRun(runId: string, guidance: string): Promise<string> {
	const run = activeSubagentRuns.get(runId);
	if (!run?.guide) return `Unknown or non-runnable subagent: ${runId}`;
	return run.guide(guidance);
}

interface PipelineMetrics {
	chainRuns: number;
	steps: number;
	packetHandoffs: number;
	rawHandoffs: number;
	truncatedHandoffs: number;
	failures: number;
	replans: number;
	replanSuccesses: number;
	fallbackAttempts: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
	totalLatencyMs: number;
	totalCost: number;
}

type AttemptMode = "single" | "parallel" | "chain";

interface AttemptContext {
	runId: string;
	mode: AttemptMode;
	phase?: "scout" | "reason" | "execute" | "verify";
	step?: number;
	fallback?: boolean;
	fallbackFromModel?: string;
	fallbackReason?: string;
	cooldownUntil?: number;
	blockedReason?: string;
	routeEvidence?: RouteEvidence;
	forceModel?: boolean;
	replan?: boolean;
	contextBudget?: ContextBudget;
	runtimePolicy?: AgentRuntimePolicy;
	mcpLifecycle?: McpRuntimeLifecycle;
}

const pipelineMetrics: PipelineMetrics = {
	chainRuns: 0,
	steps: 0,
	packetHandoffs: 0,
	rawHandoffs: 0,
	truncatedHandoffs: 0,
	failures: 0,
	replans: 0,
	replanSuccesses: 0,
	fallbackAttempts: 0,
	totalInputTokens: 0,
	totalOutputTokens: 0,
	totalCacheReadTokens: 0,
	totalCacheWriteTokens: 0,
	totalLatencyMs: 0,
	totalCost: 0,
};

function estimatedCost(result: SingleResult): number {
	if (result.usage.cost > 0) return result.usage.cost;
	if (result.requestCostUsd !== undefined && result.requestCostUsd > 0)
		return result.requestCostUsd;
	return estimateModelCost(result.actualModel ?? result.model, result.usage) ?? 0;
}

function recordHandoff(handoff: { packetValid: boolean; truncated: boolean }): void {
	if (handoff.packetValid) pipelineMetrics.packetHandoffs++;
	else pipelineMetrics.rawHandoffs++;
	if (handoff.truncated) pipelineMetrics.truncatedHandoffs++;
}

function recordPipelineResult(result: SingleResult): void {
	pipelineMetrics.steps++;
	if (isFailedResult(result)) pipelineMetrics.failures++;
	if (result.fallback) pipelineMetrics.fallbackAttempts++;
	pipelineMetrics.totalInputTokens += result.usage.input;
	pipelineMetrics.totalOutputTokens += result.usage.output;
	pipelineMetrics.totalCacheReadTokens += result.usage.cacheRead;
	pipelineMetrics.totalCacheWriteTokens += result.usage.cacheWrite;
	pipelineMetrics.totalLatencyMs += result.latencyMs ?? 0;
	pipelineMetrics.totalCost += estimatedCost(result);
}

function recordAttemptMetric(
	result: SingleResult,
	context: AttemptContext,
	startedAt: number,
	retryAttempt: number,
): void {
	appendPipelineMetric({
		schema: 1,
		at: Date.now(),
		pid: process.pid,
		...context,
		agent: result.agent,
		routeEvidence: result.routeEvidence ?? context.routeEvidence,
		requestedModel: result.routerFallbackFromModel ?? result.requestedModel,
		actualModel: result.actualModel ?? result.model,
		fallback: result.fallback ?? context.fallback ?? false,
		fallbackReason: result.routerFallbackReason ?? context.fallbackReason,
		cooldownUntil: result.routerCooldownUntil ?? context.cooldownUntil,
		...(result.routerCooldownWritten ? { cooldownWritten: result.routerCooldownWritten } : {}),
		blockedReason: result.routerBlockedReason ?? context.blockedReason,
		latencyMs: result.latencyMs ?? Math.max(0, Date.now() - startedAt),
		inputTokens: result.usage.input,
		outputTokens: result.usage.output,
		cacheReadTokens: result.usage.cacheRead,
		cacheWriteTokens: result.usage.cacheWrite,
		cost: estimatedCost(result),
		costEstimated: result.usage.cost <= 0 && estimatedCost(result) > 0,
		turns: result.usage.turns,
		exitCode: result.exitCode,
		stopReason: result.stopReason,
		verificationStatus: result.verificationStatus,
		failed: isFailedResult(result),
		retryAttempt,
	});
}

function pipelineMetricsSnapshot(): PipelineMetrics {
	return { ...pipelineMetrics };
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
	pipelineMetrics: PipelineMetrics;
	routedResult?: RoutedResultContract;
}

type RoutedStatusItem = { agent: string; task: string; model?: string };

function publishRoutedStatus(
	ctx: any,
	toolCallId: string,
	mode: "single" | "parallel" | "chain",
	items: RoutedStatusItem[],
	results: SingleResult[],
	startedAt: number,
	state: "running" | "done" | "error" = "running",
): boolean {
	try {
		// `hasUI` is a guarded getter. A status interval can outlive the session
		// that supplied `ctx` after /new, /fork, /tree, or /reload.
		if (items.length === 0 || !ctx?.hasUI) return true;
		items.forEach((item, index) => {
			const result = results[index];
			// Chain steps complete in order; a result at this index means this step is
			// done, even while the overall chain call is still "running" for later steps.
			const itemState: "running" | "done" | "error" =
				state !== "running"
					? state
					: result
						? isFailedResult(result)
							? "error"
							: "done"
						: "running";
			const finalOutput = result ? getResultOutput(result) : "";
			upsertTask(ctx, `sub:${toolCallId}:${index}`, {
				source: "subagent",
				label: item.agent,
				model: result?.model ?? item.model,
				state: itemState,
				stage: result?.controlStatus,
				startedAt,
				detail: taskTitle(item.task),
				summary: result ? compactStatusText(finalOutput) : undefined,
				activity: result ? getActivitySummary(result.messages) : undefined,
				tokens: result
					? {
							input: result.usage.input,
							output: result.usage.output,
							cacheRead: result.usage.cacheRead,
							cacheWrite: result.usage.cacheWrite,
						}
					: undefined,
				cost:
					result && result.usage.cost > 0
						? result.usage.cost
						: result
							? estimateModelCost(result.actualModel ?? result.model ?? item.model, result.usage)
							: undefined,
				costEstimated: Boolean(
					result &&
						result.usage.cost <= 0 &&
						estimateModelCost(result.actualModel ?? result.model ?? item.model, result.usage) !==
							undefined,
				),
			});
		});
		return true;
	} catch {
		// Optional status UI must not take down Pi when its captured context is stale.
		return false;
	}
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function compactStatusText(text: string, max = 96): string | undefined {
	const oneLine = text.replace(/\s+/g, " ").trim();
	if (!oneLine) return undefined;
	return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function getActivitySummary(messages: Message[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		for (let j = msg.content.length - 1; j >= 0; j--) {
			const part = msg.content[j];
			if (part.type === "toolCall") return `tool:${part.name}`;
		}
	}
	return undefined;
}

function isFailedResult(result: SingleResult): boolean {
	return (
		result.exitCode !== 0 ||
		result.stopReason === "error" ||
		result.stopReason === "aborted" ||
		result.verificationStatus === "fail" ||
		result.verificationStatus === "blocked" ||
		result.verificationStatus === "partial"
	);
}

function controlSummary(state: TaskState | undefined): RoutedResultContract["control"] | undefined {
	if (!state) return undefined;
	return {
		taskId: state.taskId,
		status: state.status,
		takeoverReady: state.status === "takeover-ready",
		reason: state.attempts.at(-1)?.reason,
	};
}

function isQuotaMessage(text: string): boolean {
	return Boolean(classifyCooldown(text));
}

function controlAttemptStatus(
	result: SingleResult,
): "pass" | "fail" | "blocked" | "partial" | "error" {
	if (result.verificationStatus) return result.verificationStatus;
	if (isQuotaMessage(getResultOutput(result))) return "blocked";
	return isFailedResult(result) ? "error" : "pass";
}

function parseNeedsReplan(text: string): boolean {
	return /(?:NEEDS_REPLAN|needs_replan)\s*:\s*(?:true|yes)\b/i.test(text);
}

interface ReplanChainStep {
	agent: string;
	phase?: "scout" | "reason" | "execute" | "verify";
	cwd?: string;
	model?: string;
	routerFallback?: boolean;
	routerFallbackFromModel?: string;
	routerFallbackReason?: string;
	routerCooldownUntil?: number;
	routerBlockedReason?: string;
	forceModel?: boolean;
	contextBudget?: ContextBudget;
	runtimePolicy?: AgentRuntimePolicy;
}

function findReplanReasonStep(
	chain: ReplanChainStep[],
	failedIndex: number,
): ReplanChainStep | undefined {
	for (let index = failedIndex - 1; index >= 0; index--) {
		const candidate = chain[index];
		if (candidate.phase === "reason" || candidate.agent === "planner") return candidate;
	}
	return undefined;
}

function shouldReplan(
	result: SingleResult,
	step: { phase?: "scout" | "reason" | "execute" | "verify" },
): boolean {
	if (result.needsReplan) return true;
	if (step.phase !== "execute") return false;
	// `partial` is intentionally stop-and-report: it may contain useful progress but
	// does not prove that a new plan is needed. An executor can opt in explicitly with
	// NEEDS_REPLAN: true, which is checked above.
	return (
		result.exitCode !== 0 ||
		result.stopReason === "error" ||
		result.stopReason === "aborted" ||
		result.verificationStatus === "fail" ||
		result.verificationStatus === "blocked"
	);
}

function fallbackNotice(
	result: Pick<
		SingleResult,
		"routerFallbackFromModel" | "model" | "routerFallbackReason" | "routerCooldownUntil"
	>,
): string | undefined {
	if (!result.routerFallbackFromModel || !result.model) return undefined;
	const reason = result.routerFallbackReason ? ` (${result.routerFallbackReason})` : "";
	const until = result.routerCooldownUntil
		? ` until ${new Date(result.routerCooldownUntil).toISOString()}`
		: "";
	return `[router fallback] requested ${result.routerFallbackFromModel}; executed ${result.model}${reason}${until}`;
}

function fallbackNotices(results: SingleResult[]): string {
	return results
		.map(fallbackNotice)
		.filter((notice): notice is string => Boolean(notice))
		.join("\n");
}

export const __test = {
	isFailedResult,
	parseNeedsReplan,
	shouldReplan,
	findReplanReasonStep,
	fallbackNotice,
	recordCooldownIfQuota,
	recordAttemptMetric,
	isQuotaMessage: (text: string) => Boolean(classifyCooldown(text)),
};

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall")
					items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(
	agentName: string,
	prompt: string,
): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

interface DispatchDefaults {
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

const OUTPUT_LIMIT_RE =
	/maximum output token limit|output token limit|max(?:imum)?[_ -]tokens?|max_tokens|finish(?:ed)?\s+because\s+.*token/i;
const MAX_OUTPUT_LIMIT_RETRIES = 2;
// Cooldown state is shared with the pre-tool router. Include all child-visible
// error channels, including structured events and final output.
// Only the failure channels that name a provider error are classified. The whole
// transcript is deliberately excluded: a child that merely read a file mentioning
// "rate limit" must not cool its model.
const USER_CANCEL_MESSAGE = "Subagent was cancelled";

function recordCooldownIfQuota(model: string | undefined, result: SingleResult): void {
	if (!model) return;
	// A user-initiated cancel or abort is not a provider signal; cooling the model
	// for it would route work away from a healthy model.
	if (result.errorMessage === USER_CANCEL_MESSAGE) return;
	const failed =
		result.exitCode !== 0 ||
		result.errorMessage !== undefined ||
		result.stopReason === "error" ||
		result.stopReason === "aborted";
	if (!failed) return;
	const text = [
		result.errorMessage,
		result.stopReason,
		result.stderr,
		getFinalOutput(result.messages),
	]
		.filter(Boolean)
		.join(" ");
	if (!classifyCooldown(text)) return;
	const entry = recordCooldown(model, text);
	if (entry) {
		result.routerCooldownWritten = {
			reason: entry.reason,
			until: entry.until,
			failures: entry.failures,
			advised: entry.advised === true,
		};
	}
}

async function runSingleAgent(
	defaultCwd: string,
	dispatchDefaults: DispatchDefaults,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	modelOverride: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	retryAttempt = 0,
	attemptContext: AttemptContext = { runId: "unknown", mode: "single" },
): Promise<SingleResult> {
	const startedAt = Date.now();
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		const unknownResult: SingleResult = {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				contextTokens: 0,
				turns: 0,
			},
			requestedModel: modelOverride,
			routeEvidence: attemptContext.routeEvidence,
			fallback: attemptContext.fallback ?? false,
			routerFallbackFromModel: attemptContext.fallbackFromModel,
			step,
		};
		recordAttemptMetric(unknownResult, attemptContext, startedAt, retryAttempt);
		return unknownResult;
	}

	// Revalidate health at execution time. Hook metadata may be stale by the time
	// interactive confirmation or Graft retrieval finishes, and is not trusted input.
	const dynamicDecision = routeModelForAgent(
		agentName,
		modelOverride,
		coolingModels(),
		attemptContext.forceModel,
	);
	const effectiveBlockedReason = dynamicDecision.blockedReason;
	if (effectiveBlockedReason) {
		const blockedResult: SingleResult = {
			agent: agentName,
			agentSource: agent.source,
			task,
			exitCode: 1,
			messages: [],
			stderr: effectiveBlockedReason,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				contextTokens: 0,
				turns: 0,
			},
			model: undefined,
			routeEvidence: attemptContext.routeEvidence,
			requestedModel: modelOverride,
			fallback: true,
			routerFallbackFromModel: dynamicDecision?.fallbackFromModel,
			routerFallbackReason: dynamicDecision?.fallbackReason,
			routerCooldownUntil: dynamicDecision?.cooldownUntil,
			routerBlockedReason: effectiveBlockedReason,
			step,
		};
		recordAttemptMetric(blockedResult, attemptContext, startedAt, retryAttempt);
		return blockedResult;
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	const inheritsDispatchConfig = !agent.model && !modelOverride && !dynamicDecision.model;
	const model = dynamicDecision.model ?? modelOverride ?? agent.model ?? dispatchDefaults.model;
	if (dynamicDecision.model && dynamicDecision.model !== modelOverride) {
		attemptContext = { ...attemptContext, contextBudget: contextBudgetForModel(model) };
	}
	const effectiveFallback = dynamicDecision.fallback || attemptContext.fallback;
	const effectiveFallbackFrom =
		attemptContext.fallbackFromModel ?? dynamicDecision?.fallbackFromModel;
	const reasons = [attemptContext.fallbackReason, dynamicDecision?.fallbackReason].filter(
		(reason, index, all) => reason && all.indexOf(reason) === index,
	);
	const effectiveFallbackReason = reasons.length > 0 ? reasons.join("+") : undefined;
	const effectiveCooldownUntil = dynamicDecision?.cooldownUntil ?? attemptContext.cooldownUntil;
	if (model) args.push("--model", model);
	if (inheritsDispatchConfig && dispatchDefaults.thinkingLevel) {
		args.push("--thinking", dispatchDefaults.thinkingLevel);
	}
	const runtimePolicy = attemptContext.runtimePolicy;
	if (runtimePolicy?.isolation === "worktree")
		throw new Error("worktree isolation is not available for routed subagents");
	const deniedTools = new Set(runtimePolicy?.deniedTools ?? []);
	const allowedTools = runtimePolicy?.allowedTools;
	const planTools = new Set(["read", "grep", "find", "ls"]);
	const tools = (agent.tools ?? []).filter(
		(tool) =>
			(allowedTools === undefined || allowedTools.includes(tool)) &&
			(runtimePolicy?.permissionMode !== "plan" || planTools.has(tool)) &&
			!deniedTools.has(tool),
	);
	if (allowedTools !== undefined || runtimePolicy?.permissionMode === "plan")
		args.push(
			tools.length > 0 ? "--tools" : "--no-tools",
			...(tools.length > 0 ? [tools.join(",")] : []),
		);
	if (deniedTools.size > 0) args.push("--exclude-tools", [...deniedTools].join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;
	let unregisterRuntimeResource: (() => void) | undefined;

	let metricRecorded = false;
	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			contextTokens: 0,
			turns: 0,
		},
		model,
		routeEvidence: attemptContext.routeEvidence,
		requestedModel: modelOverride ?? model,
		fallback: effectiveFallback,
		routerFallbackFromModel: effectiveFallbackFrom,
		routerFallbackReason: effectiveFallbackReason,
		routerCooldownUntil: effectiveCooldownUntil,
		step,
	};

	const fleetRunId = `${attemptContext.runId}:${retryAttempt}:${randomUUID().slice(0, 8)}`;
	let resolveDone!: (result: SingleResult) => void;
	const done = new Promise<SingleResult>((resolve) => {
		resolveDone = resolve;
	});
	const active: ActiveSubagentRun = {
		id: fleetRunId,
		agent: agentName,
		task,
		model,
		status: "running",
		startedAt,
		output: "",
		stderr: "",
		inputTokens: 0,
		outputTokens: 0,
		cancelRequested: false,
		done,
		resolveDone,
	};
	activeSubagentRuns.set(fleetRunId, active);

	const syncActive = () => {
		active.output = getFinalOutput(currentResult.messages);
		active.stderr = currentResult.stderr;
		active.inputTokens = currentResult.usage.input;
		active.outputTokens = currentResult.usage.output;
	};
	const emitUpdate = () => {
		syncActive();
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};
	active.guide = async (guidance: string) => {
		const text = guidance.trim();
		if (!text) return "Guidance must be non-empty.";
		if (active.status === "running") {
			cancelSubagentRun(fleetRunId);
			await active.done;
		}
		const guided = await runSingleAgent(
			defaultCwd,
			dispatchDefaults,
			agents,
			agentName,
			`${task}\n\nAdditional guidance for this attempt:\n${text}`,
			cwd,
			modelOverride,
			step,
			signal,
			onUpdate,
			makeDetails,
			0,
			attemptContext,
		);
		return getFinalOutput(guided.messages) || guided.stderr || "(no output)";
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		const requestedMcpServers = attemptContext.runtimePolicy?.mcpServers ?? [];
		const mcpConfig = loadMcpServerConfigs(requestedMcpServers);
		const missingMcpServers = requestedMcpServers.filter((name) => !mcpConfig[name]);
		if (missingMcpServers.length > 0)
			throw new Error(`MCP server configuration not found: ${missingMcpServers.join(", ")}`);
		const mcp = attemptContext.mcpLifecycle
			? await startMcpRuntime(fleetRunId, requestedMcpServers, attemptContext.mcpLifecycle)
			: { started: 0, failed: 0 };
		if (mcp.failed) throw new Error("MCP runtime failed to start requested server(s)");
		let wasAborted = false;
		let wasCancelled = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? attemptContext.runtimePolicy?.cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					PI_SUBAGENT_RUN_ID: fleetRunId,
					PI_CONTEXT_BUDGET: JSON.stringify(
						attemptContext.contextBudget ?? contextBudgetForModel(model),
					),
					PI_SUBAGENT_MCP_SERVERS: requestedMcpServers.join(","),
					PI_SUBAGENT_MCP_CONFIG:
						requestedMcpServers.length > 0 ? JSON.stringify(mcpConfig) : undefined,
					PI_SUBAGENT_ALLOWED_TOOLS: (attemptContext.runtimePolicy?.allowedTools ?? []).join(","),
					PI_SUBAGENT_DENIED_TOOLS: (attemptContext.runtimePolicy?.deniedTools ?? []).join(","),
					PI_SUBAGENT_PERMISSION_MODE: attemptContext.runtimePolicy?.permissionMode ?? "default",
				},
			});
			unregisterRuntimeResource = registerRuntimeResource(fleetRunId, {
				kind: "shell",
				close: () => {
					if (!proc.killed) proc.kill("SIGTERM");
				},
			});
			let buffer = "";
			let settled = false;
			let childClosed = false;
			let agentEndTimer: ReturnType<typeof setTimeout> | undefined;
			let killTimer: ReturnType<typeof setTimeout> | undefined;

			const settle = (code: number) => {
				if (settled) return;
				settled = true;
				if (agentEndTimer) clearTimeout(agentEndTimer);
				// Keep escalation alive when agent_end forced an early resolve; the
				// child can still be draining after the parent result is returned.
				if (killTimer && childClosed) clearTimeout(killTimer);
				resolve(code);
			};

			const terminate = () => {
				try {
					proc.kill("SIGTERM");
				} catch {
					/* child may already have exited */
				}
				// ChildProcess.killed only means that kill(2) was requested; it does
				// not mean the process actually exited. Escalate based on close state.
				killTimer = setTimeout(() => {
					if (childClosed) return;
					try {
						proc.kill("SIGKILL");
					} catch {
						/* child may have exited between the check and kill */
					}
				}, ABORT_KILL_ESCALATION_MS);
				killTimer.unref?.();
			};
			active.cancel = () => {
				wasCancelled = true;
				terminate();
			};

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
							// Price this request on its own prompt size, so a Haiku break applies
							// to the turn that crossed it. The model is known only once the turn ends.
							const turnCost = estimateRequestCost(msg.model ?? currentResult.model, {
								input: usage.input,
								output: usage.output,
								cacheRead: usage.cacheRead,
								cacheWrite: usage.cacheWrite,
							});
							if (turnCost !== undefined) {
								currentResult.requestCostUsd = (currentResult.requestCostUsd ?? 0) + turnCost;
							}
						}
						if (msg.model) currentResult.actualModel = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}

				if (event.type === "agent_end" && !agentEndTimer) {
					// The final assistant message has already been streamed when
					// agent_end is emitted. Do not wait indefinitely for a broken
					// descendant/stdio handle to let `close` fire.
					agentEndTimer = setTimeout(() => {
						if (settled) return;
						currentResult.stderr +=
							"Subagent emitted agent_end but did not close; terminated after grace period.\n";
						terminate();
						settle(0);
					}, AGENT_END_CLOSE_GRACE_MS);
					agentEndTimer.unref?.();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				childClosed = true;
				if (buffer.trim()) processLine(buffer);
				settle(code ?? 0);
			});

			proc.on("error", () => {
				childClosed = true;
				settle(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					terminate();
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = wasCancelled || wasAborted ? 130 : exitCode;
		if (wasCancelled || wasAborted) currentResult.errorMessage = "Subagent was cancelled";
		recordCooldownIfQuota(model, currentResult);
		if (wasAborted) throw new Error("Subagent was aborted");

		// Some providers report this as stopReason="length"; others emit the
		// literal maximum-output error. Continue in a bounded fresh child because
		// routed children use --no-session and cannot be resumed in place.
		const stopText = `${currentResult.stopReason ?? ""} ${currentResult.errorMessage ?? ""} ${currentResult.stderr ?? ""}`;
		const hitOutputLimit = currentResult.stopReason === "length" || OUTPUT_LIMIT_RE.test(stopText);
		if (hitOutputLimit && retryAttempt < MAX_OUTPUT_LIMIT_RETRIES && !signal?.aborted) {
			currentResult.latencyMs = Math.max(0, Date.now() - startedAt);
			recordAttemptMetric(currentResult, attemptContext, startedAt, retryAttempt);
			metricRecorded = true;
			const partial = getFinalOutput(currentResult.messages).trim();
			const continuationTask = [
				task,
				"",
				"The previous attempt stopped at the maximum output token limit before producing a complete answer.",
				"Continue the task and return one complete final answer. Do not mention this retry and do not stop at an outline.",
				partial
					? `Partial previous answer (use it as context; do not blindly repeat it):\n${partial}`
					: "",
			]
				.filter(Boolean)
				.join("\n");
			const continuation = await runSingleAgent(
				defaultCwd,
				dispatchDefaults,
				agents,
				agentName,
				continuationTask,
				cwd,
				modelOverride,
				step,
				signal,
				onUpdate,
				makeDetails,
				retryAttempt + 1,
				attemptContext,
			);
			currentResult.messages.push(...continuation.messages);
			currentResult.stderr += continuation.stderr;
			currentResult.usage.input += continuation.usage.input;
			currentResult.usage.output += continuation.usage.output;
			currentResult.usage.cacheRead += continuation.usage.cacheRead;
			currentResult.usage.cacheWrite += continuation.usage.cacheWrite;
			currentResult.usage.cost += continuation.usage.cost;
			currentResult.usage.contextTokens =
				continuation.usage.contextTokens || currentResult.usage.contextTokens;
			currentResult.usage.turns += continuation.usage.turns;
			currentResult.exitCode = continuation.exitCode;
			currentResult.stopReason = continuation.stopReason;
			currentResult.errorMessage = continuation.errorMessage;
			currentResult.model = continuation.model ?? currentResult.model;
			currentResult.actualModel = continuation.actualModel ?? currentResult.actualModel;
			emitUpdate();
		}
		const finalOutput = getFinalOutput(currentResult.messages);
		currentResult.verificationStatus = parseVerificationStatus(finalOutput);
		currentResult.needsReplan = parseNeedsReplan(finalOutput);
		return currentResult;
	} finally {
		syncActive();
		active.status =
			active.cancelRequested || currentResult.errorMessage === "Subagent was cancelled"
				? "cancelled"
				: statusForResult(currentResult);
		active.finishedAt = Date.now();
		active.cancel = undefined;
		active.resolveDone(currentResult);
		active.resolveDone = () => {};
		trimFinishedSubagentRuns();
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
		const cleanup = await cleanupRuntimeResources(fleetRunId);
		unregisterRuntimeResource?.();
		unregisterRuntimeResource = undefined;
		if (cleanup.failed)
			currentResult.stderr += `runtime cleanup failed for ${cleanup.failed} resource(s).\n`;
		if (!metricRecorded) {
			currentResult.latencyMs = Math.max(0, Date.now() - startedAt);
			recordAttemptMetric(currentResult, attemptContext, startedAt, retryAttempt);
		}
	}
}

const AcceptanceSchema = Type.Object({
	command: Type.String({ description: "Shell command used for deterministic acceptance" }),
	cwd: Type.Optional(Type.String()),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 600_000 })),
});

const TaskControlSchema = Type.Object({
	version: Type.Optional(Type.Literal(1)),
	taskId: Type.Optional(Type.String()),
	allowedPaths: Type.Array(Type.String(), { description: "Relative paths Lead may change" }),
	acceptance: Type.Array(AcceptanceSchema, {
		description: "Commands reused for takeover verification",
	}),
	maxRework: Type.Optional(Type.Integer({ minimum: 0, maximum: 8 })),
	maxLeadSubmissions: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
	allowTakeover: Type.Boolean(),
});

const RuntimePolicySchema = Type.Object({
	cwd: Type.String(),
	isolation: StringEnum(["none", "worktree"] as const),
	permissionMode: StringEnum(["default", "plan", "acceptEdits"] as const),
	allowedTools: Type.Optional(Type.Array(Type.String())),
	deniedTools: Type.Optional(Type.Array(Type.String())),
	mcpServers: Type.Optional(Type.Array(Type.String())),
});

const ContextBudgetSchema = Type.Object({
	contextWindow: Type.Number(),
	compactThreshold: Type.Number(),
	defaultOutputTokens: Type.Number(),
	maxOutputTokens: Type.Number(),
	escalationOutputTokens: Type.Optional(Type.Number()),
});

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	model: Type.Optional(Type.String({ description: "Model selected by the router" })),
	contextBudget: Type.Optional(ContextBudgetSchema),
	runtimePolicy: Type.Optional(RuntimePolicySchema),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	routerFallback: Type.Optional(Type.Boolean()),
	routerFallbackFromModel: Type.Optional(Type.String()),
	routerFallbackReason: Type.Optional(Type.String()),
	routerCooldownUntil: Type.Optional(Type.Number()),
	routerBlockedReason: Type.Optional(Type.String()),
	forceModel: Type.Optional(Type.Boolean()),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	contextBudget: Type.Optional(ContextBudgetSchema),
	runtimePolicy: Type.Optional(RuntimePolicySchema),
	phase: Type.Optional(
		StringEnum(["scout", "reason", "execute", "verify"] as const, {
			description: "Optional pipeline phase used for handoff policy and task-dock visibility",
		}),
	),
	model: Type.Optional(Type.String({ description: "Model selected by the router" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	routerFallback: Type.Optional(Type.Boolean()),
	routerFallbackFromModel: Type.Optional(Type.String()),
	routerFallbackReason: Type.Optional(Type.String()),
	routerCooldownUntil: Type.Optional(Type.Number()),
	routerBlockedReason: Type.Optional(Type.String()),
	forceModel: Type.Optional(Type.Boolean()),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description:
		'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(
		Type.String({ description: "Name of the agent to invoke (for single mode)" }),
	),
	model: Type.Optional(
		Type.String({ description: "Model override provider/id for single mode (set by the router)" }),
	),
	contextBudget: Type.Optional(ContextBudgetSchema),
	runtimePolicy: Type.Optional(RuntimePolicySchema),
	control: Type.Optional(TaskControlSchema),
	routerFallback: Type.Optional(Type.Boolean()),
	routerFallbackFromModel: Type.Optional(Type.String()),
	routerFallbackReason: Type.Optional(Type.String()),
	routerCooldownUntil: Type.Optional(Type.Number()),
	routerBlockedReason: Type.Optional(Type.String()),
	forceModel: Type.Optional(Type.Boolean()),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(
		Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" }),
	),
	chain: Type.Optional(
		Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" }),
	),
	replanOnFailure: Type.Optional(
		Type.Boolean({
			description:
				"After an execute failure or explicit NEEDS_REPLAN marker, ask the chain's reason step for one revised plan",
		}),
	),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({
			description: "Prompt before running project-local agents. Default: true.",
			default: true,
		}),
	),
	cwd: Type.Optional(
		Type.String({ description: "Working directory for the agent process (single mode)" }),
	),
});

const PipelineMetricsParams = Type.Object({
	days: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 365,
			description: "Look back this many days. Default: 30.",
		}),
	),
	limit: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 10000,
			description: "Maximum records to scan. Default: 5000.",
		}),
	),
	prune: Type.Optional(
		Type.Boolean({ description: "Prune records older than retentionDays and cap file size." }),
	),
	retentionDays: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 3650,
			description: "Retention window for prune. Default: 30.",
		}),
	),
});

function changedWorkspacePaths(cwd: string): Promise<string[]> {
	return execAsync(
		"git diff --name-only --diff-filter=ACDMRTUXB && git ls-files --others --exclude-standard",
		{
			cwd,
			maxBuffer: 64 * 1024,
		},
	).then(({ stdout }) =>
		Array.from(
			new Set(
				stdout
					.split(/\r?\n/)
					.map((line) => line.trim())
					.filter(Boolean),
			),
		),
	);
}

function isAllowedChangedPath(file: string, allowedPaths: string[]): boolean {
	const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "");
	return allowedPaths.some((allowed) => {
		const prefix = allowed.replaceAll("\\", "/").replace(/^\.\//, "");
		return prefix === "." || normalized === prefix || normalized.startsWith(`${prefix}/`);
	});
}

async function runAcceptance(state: TaskState): Promise<{ pass: boolean; output: string }> {
	const changed = changesSinceBaseline(
		await changedWorkspacePaths(state.cwd),
		state.workspaceBaseline,
	);
	const outside = changed.filter((file) => !isAllowedChangedPath(file, state.control.allowedPaths));
	if (outside.length > 0)
		return { pass: false, output: `Changed paths outside allowed scope: ${outside.join(", ")}` };
	const outputs: string[] = [];
	for (const check of state.control.acceptance) {
		const checkCwd = path.resolve(state.cwd, check.cwd ?? ".");
		const relativeCwd = path.relative(state.cwd, checkCwd);
		if (
			relativeCwd === ".." ||
			relativeCwd.startsWith(`..${path.sep}`) ||
			path.isAbsolute(relativeCwd)
		)
			return { pass: false, output: `Acceptance cwd is outside task cwd: ${check.cwd ?? "."}` };
		try {
			const result = await execAsync(check.command, {
				cwd: checkCwd,
				timeout: Math.min(check.timeoutMs ?? 120_000, 600_000),
				maxBuffer: 256 * 1024,
			});
			outputs.push(`$ ${check.command}\\n${result.stdout}${result.stderr}`.slice(0, 8_000));
		} catch (error) {
			const failure = error as { stdout?: string; stderr?: string; message?: string };
			outputs.push(
				`$ ${check.command}\\n${failure.stdout ?? ""}${failure.stderr ?? failure.message ?? String(error)}`.slice(
					0,
					8_000,
				),
			);
			return { pass: false, output: outputs.join("\\n\\n") };
		}
	}
	return { pass: true, output: outputs.join("\\n\\n") || "Acceptance passed; no output." };
}

const TakeoverParams = Type.Object({
	taskId: Type.String(),
	owner: Type.Optional(Type.String()),
});

const SubmitTakeoverParams = Type.Object({
	taskId: Type.String(),
	owner: Type.Optional(Type.String()),
	status: StringEnum(["pass", "fail", "blocked"] as const),
	reason: Type.Optional(Type.String()),
});

export default function (pi: ExtensionAPI) {
	if (typeof pi.registerShortcut === "function") {
		pi.registerShortcut("ctrl+alt+i", {
			description: "Toggle all subagent runs inspector",
			handler: async (ctx) => {
				if (closeSubagentFleetInspector()) return;
				await openSubagentFleetInspector(ctx, inspectorSnapshot, {
					cancel: (runId) => {
						if (isDelegateRun(runId)) requestTaskControl(runId, "cancel");
						else cancelSubagentRun(runId);
					},
					guide: (runId) => {
						void (async () => {
							const guidance = await ctx.ui.editor("Guide subagent (interrupt + relaunch)", "");
							if (guidance === undefined) return;
							if (isDelegateRun(runId)) {
								requestTaskControl(runId, "guide", guidance);
								ctx.ui.notify(`Delegate ${runId.slice("delegate:".length)}: guidance sent`, "info");
								return;
							}
							const result = await guideSubagentRun(runId, guidance);
							ctx.ui.notify(`Subagent ${runId}: ${result.slice(0, 240)}`, "info");
						})().catch((error) =>
							ctx.ui.notify(`Subagent guide failed: ${String(error)}`, "error"),
						);
					},
				});
			},
		});
	}

	pi.registerTool({
		name: "subagent_takeover",
		label: "Lead takeover",
		description:
			"Acquire the Host-authorized write lease for a failed controlled subagent task. Only takeover-ready tasks can be acquired.",
		parameters: TakeoverParams,
		async execute(_toolCallId, params) {
			const owner = params.owner?.trim() || "main";
			try {
				const current = readTaskState(params.taskId);
				if (!current) throw new TaskStateError(`Unknown controlled task: ${params.taskId}`);
				const state = acquireTakeover(params.taskId, owner);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									taskId: state.taskId,
									owner,
									status: state.status,
									allowedPaths: state.control.allowedPaths,
									acceptance: state.control.acceptance,
									attempts: state.attempts.slice(-5),
									leaseExpiresAt: state.lease?.expiresAt,
								},
								null,
								2,
							),
						},
					],
					details: state,
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: `Lead takeover denied: ${String(error)}` }],
					details: undefined,
					isError: true,
				};
			}
		},
	});

	pi.registerTool({
		name: "subagent_submit_takeover",
		label: "Submit Lead takeover",
		description:
			"Run the frozen acceptance checks and release a controlled task's Lead write lease.",
		parameters: SubmitTakeoverParams,
		async execute(_toolCallId, params) {
			const owner = params.owner?.trim() || "main";
			try {
				const current = readTaskState(params.taskId);
				if (!current) throw new TaskStateError(`Unknown controlled task: ${params.taskId}`);
				let finalStatus = params.status;
				let output = params.reason ?? "";
				if (params.status === "pass") {
					const acceptance = await runAcceptance(current);
					finalStatus = acceptance.pass ? "pass" : "fail";
					output = [output, acceptance.output].filter(Boolean).join("\\n\\n");
				}
				const state = submitTakeover(params.taskId, owner, finalStatus, output || undefined);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{ taskId: state.taskId, status: state.status, submission: finalStatus, output },
								null,
								2,
							),
						},
					],
					details: state,
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: `Lead takeover submission failed: ${String(error)}` }],
					details: undefined,
					isError: true,
				};
			}
		},
	});

	pi.registerTool({
		name: "subagent_metrics",
		label: "Subagent metrics",
		description:
			"Read aggregated subagent routing telemetry from the local JSONL metrics file. Reports latency, token/cache usage, cost, failures, fallbacks, and counts by mode/phase/agent/model.",
		parameters: PipelineMetricsParams,
		async execute(_toolCallId, params) {
			const pruned = params.prune
				? prunePipelineMetrics({ retentionDays: params.retentionDays ?? 30 })
				: 0;
			const report = readPipelineMetricsReport({
				days: params.days ?? 30,
				limit: params.limit ?? 5000,
			});
			// Surface what was dropped, so a summary never silently under-counts.
			const summary = {
				...summarizePipelineMetrics(report.records),
				pruned,
				skipped: report.skipped,
			};
			return {
				content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
				details: summary,
			};
		},
	});

	pi.registerTool({
		name: "subagent_routed",
		label: "Subagent (routed)",
		description: [
			"Delegate tasks to specialized subagents with isolated context, cost/quota/1M-window routed by the subagent-model-router (see AGENTS.md). Prefer this for ordinary single/parallel/chain delegations where you want the cheapest healthy model of the right tier auto-picked.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			"Chain may opt into one replan after an execute failure or NEEDS_REPLAN: true marker via replanOnFailure: true; partial verification remains stop-and-report.",
			"For a bounded Lead takeover, use single mode with control={allowedPaths, acceptance, allowTakeover:true}; failures get limited rework and return a taskId for subagent_takeover. Provider quota errors never unlock takeover.",
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		].join(" "),
		parameters: SubagentParams,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const dispatchDefaults: DispatchDefaults = {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
			};
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;
			const runId = randomUUID();
			const routed = getRoutedCallItems(toolCallId) ?? [];
			const routeContext = (index: number): Pick<AttemptContext, "routeEvidence"> => {
				const evidence = routed[index]?.routeEvidence;
				return evidence ? { routeEvidence: evidence } : {};
			};

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);
			let routedResultContract: RoutedResultContract | undefined;
			let controlledTaskState: TaskState | undefined;

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
					pipelineMetrics: pipelineMetricsSnapshot(),
					routedResult: routedResultContract,
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			const controlRequested = isTaskControlRequested(params.control);
			const normalizedControl = controlRequested
				? normalizeTaskControl(params.control, params.cwd ?? ctx.cwd)
				: undefined;
			if (controlRequested && (!hasSingle || !normalizedControl?.allowTakeover)) {
				return {
					content: [
						{
							type: "text",
							text: "Controlled takeover requires single mode, allowedPaths, acceptance, and allowTakeover=true.",
						},
					],
					details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
					isError: true,
				};
			}

			if (
				(agentScope === "project" || agentScope === "both") &&
				confirmProjectAgents &&
				ctx.hasUI
			) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (normalizedControl && params.task) {
				try {
					const taskCwd = params.cwd ?? ctx.cwd;
					let workspaceBaseline: string[] = [];
					try {
						workspaceBaseline = await changedWorkspacePaths(taskCwd);
					} catch {
						// Preserve the existing acceptance behavior when the cwd is not a Git worktree.
					}
					controlledTaskState = createTaskState(
						params.task,
						taskCwd,
						normalizedControl,
						undefined,
						workspaceBaseline,
					);
				} catch (error) {
					return {
						content: [{ type: "text", text: `Could not create controlled task: ${String(error)}` }],
						details: makeDetails("single")([]),
						isError: true,
					};
				}
			}

			const statusMode: "single" | "parallel" | "chain" = hasChain
				? "chain"
				: hasTasks
					? "parallel"
					: "single";
			const statusModelFor = (agentName: string, override?: string): string | undefined =>
				override ??
				agents.find((agent) => agent.name === agentName)?.model ??
				dispatchDefaults.model;
			const statusItems: RoutedStatusItem[] = hasChain
				? (params.chain ?? []).map((item) => ({
						agent: item.agent,
						task: item.task,
						model: statusModelFor(item.agent, item.model),
					}))
				: hasTasks
					? (params.tasks ?? []).map((item) => ({
							agent: item.agent,
							task: item.task,
							model: statusModelFor(item.agent, item.model),
						}))
					: [
							{
								agent: params.agent ?? "?",
								task: params.task ?? "",
								model: statusModelFor(params.agent ?? "?", params.model),
							},
						];
			const statusStartedAt = Date.now();
			let latestStatusResults: SingleResult[] = [];
			let statusTimer: ReturnType<typeof setInterval> | undefined;
			let terminalNotified = false;
			const notifyRoutedResult = (results: SingleResult[], state: "done" | "error") => {
				if (terminalNotified) return;
				terminalNotified = true;
				const stages: RoutedResultContract["stages"] = statusItems.map((item, index) => {
					const result = results[index];
					return {
						agent: item.agent,
						status: result && !isFailedResult(result) ? "done" : "error",
						summary:
							compactStatusText(result ? getResultOutput(result) : "no result", 48) ?? "no result",
					};
				});
				const contract: RoutedResultContract = {
					version: 1,
					status: state,
					mode: statusMode,
					summary:
						compactStatusText(
							results[results.length - 1]
								? getResultOutput(results[results.length - 1])
								: "no result",
							48,
						) ?? "no result",
					stages,
					control: controlSummary(controlledTaskState),
				};
				routedResultContract = contract;
				pi.events.emit("subagent_routed:result", {
					toolCallId,
					contract,
					items: statusItems,
					outputs: results.map((result) => getResultOutput(result)),
				});
			};
			const updateRoutedStatus = (
				results: SingleResult[] = latestStatusResults,
				state: "running" | "done" | "error" = "running",
			): boolean => {
				latestStatusResults = results;
				if (state !== "running") notifyRoutedResult(results, state);
				return publishRoutedStatus(
					ctx,
					toolCallId,
					statusMode,
					statusItems,
					results,
					statusStartedAt,
					state,
				);
			};
			const stopRoutedStatus = () => {
				if (statusTimer) clearInterval(statusTimer);
				statusTimer = undefined;
			};
			const hasUI = (() => {
				try {
					return Boolean(ctx?.hasUI);
				} catch {
					return false;
				}
			})();
			updateRoutedStatus();
			if (hasUI) {
				statusTimer = setInterval(() => {
					if (!updateRoutedStatus()) stopRoutedStatus();
				}, 1000);
				statusTimer.unref?.();
			}

			if (params.chain && params.chain.length > 0) {
				if (params.chain.length > MAX_CHAIN_STEPS) {
					stopRoutedStatus();
					return {
						content: [
							{
								type: "text",
								text: `Too many chain steps (${params.chain.length}). Max is ${MAX_CHAIN_STEPS}.`,
							},
						],
						details: makeDetails("chain")([]),
					};
				}
				pipelineMetrics.chainRuns++;
				const results: SingleResult[] = [];
				let previousOutput = "";
				let replanUsed = false;

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const handoff = prepareHandoff(previousOutput, MAX_HANDOFF_CHARS);
					const taskWithContext = step.task.replace(/\{previous\}/g, handoff.text);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									updateRoutedStatus(allResults);
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					let result = await runSingleAgent(
						ctx.cwd,
						dispatchDefaults,
						agents,
						step.agent,
						taskWithContext,
						step.cwd,
						step.model,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
						0,
						{
							runId,
							mode: "chain",
							phase: step.phase,
							step: i + 1,
							fallback: step.routerFallback,
							fallbackFromModel: step.routerFallbackFromModel,
							fallbackReason: step.routerFallbackReason,
							cooldownUntil: step.routerCooldownUntil,
							blockedReason: step.routerBlockedReason,
							forceModel: step.forceModel,
							contextBudget: step.contextBudget,
							runtimePolicy: step.runtimePolicy,
							...routeContext(i),
						},
					);
					result.phase = step.phase;
					result.handoff = {
						packetValid: handoff.packetValid,
						truncated: handoff.truncated,
						chars: handoff.text.length,
					};
					recordHandoff(handoff);
					recordPipelineResult(result);
					results.push(result);
					updateRoutedStatus(results);

					let isError = isFailedResult(result);
					if (shouldReplan(result, step) && params.replanOnFailure && !replanUsed) {
						replanUsed = true;
						const reasonStep = findReplanReasonStep(params.chain, i);
						const replanTask = [
							"The chain requested a replan after an execute failure or explicit NEEDS_REPLAN marker. Produce one revised task-packet plan; do not edit files.",
							`Failed stage output:\n${prepareHandoff(getResultOutput(result)).text}`,
							HANDOFF_CONTRACT,
						].join("\n\n");
						const replanned = await runSingleAgent(
							ctx.cwd,
							dispatchDefaults,
							agents,
							reasonStep?.agent ?? "planner",
							replanTask,
							reasonStep?.cwd,
							reasonStep?.model,
							i + 1,
							signal,
							chainUpdate,
							makeDetails("chain"),
							0,
							{
								runId,
								mode: "chain",
								phase: reasonStep?.phase ?? "reason",
								step: i + 1,
								fallback: reasonStep?.routerFallback,
								fallbackFromModel: reasonStep?.routerFallbackFromModel,
								fallbackReason: reasonStep?.routerFallbackReason,
								cooldownUntil: reasonStep?.routerCooldownUntil,
								blockedReason: reasonStep?.routerBlockedReason,
								forceModel: reasonStep?.forceModel,
								contextBudget: reasonStep?.contextBudget,
								runtimePolicy: reasonStep?.runtimePolicy,
								...routeContext(i),
								replan: true,
							},
						);
						replanned.phase = reasonStep?.phase ?? "reason";
						const replanHandoff = prepareHandoff(getResultOutput(result));
						replanned.handoff = {
							packetValid: replanHandoff.packetValid,
							truncated: replanHandoff.truncated,
							chars: replanHandoff.text.length,
						};
						recordHandoff(replanHandoff);
						recordPipelineResult(replanned);
						pipelineMetrics.replans++;
						results.push(replanned);
						updateRoutedStatus(results);
						if (isFailedResult(replanned)) result = replanned;
						else {
							pipelineMetrics.replanSuccesses++;
							const retryHandoff = prepareHandoff(getFinalOutput(replanned.messages));
							const retryTask = step.task.replace(/\{previous\}/g, retryHandoff.text);
							result = await runSingleAgent(
								ctx.cwd,
								dispatchDefaults,
								agents,
								step.agent,
								retryTask,
								step.cwd,
								step.model,
								i + 1,
								signal,
								chainUpdate,
								makeDetails("chain"),
								0,
								{
									runId,
									mode: "chain",
									phase: step.phase,
									step: i + 1,
									fallback: step.routerFallback,
									fallbackFromModel: step.routerFallbackFromModel,
									fallbackReason: step.routerFallbackReason,
									cooldownUntil: step.routerCooldownUntil,
									blockedReason: step.routerBlockedReason,
									forceModel: step.forceModel,
									contextBudget: step.contextBudget,
									runtimePolicy: step.runtimePolicy,
									...routeContext(i),
									replan: true,
								},
							);
							result.phase = step.phase;
							result.handoff = {
								packetValid: retryHandoff.packetValid,
								truncated: retryHandoff.truncated,
								chars: retryHandoff.text.length,
							};
							recordHandoff(retryHandoff);
							recordPipelineResult(result);
							results.push(result);
							updateRoutedStatus(results);
						}
						isError = isFailedResult(result);
					}
					if (isError) {
						const errorMsg = getResultOutput(result);
						stopRoutedStatus();
						updateRoutedStatus(results, "error");
						return {
							content: [
								{
									type: "text",
									text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}${fallbackNotice(result) ? `\n${fallbackNotice(result)}` : ""}`,
								},
							],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				stopRoutedStatus();
				updateRoutedStatus(results, "done");
				return {
					content: [
						{
							type: "text",
							text: [
								getFinalOutput(results[results.length - 1].messages) || "(no output)",
								fallbackNotices(results),
							]
								.filter(Boolean)
								.join("\n"),
						},
					],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS) {
					stopRoutedStatus();
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};
				}

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							cost: 0,
							contextTokens: 0,
							turns: 0,
						},
					};
				}

				const emitParallelUpdate = () => {
					updateRoutedStatus([...allResults]);
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{
									type: "text",
									text: `Parallel: ${done}/${allResults.length} done, ${running} running...`,
								},
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(
					params.tasks,
					MAX_CONCURRENCY,
					async (t, index) => {
						const result = await runSingleAgent(
							ctx.cwd,
							dispatchDefaults,
							agents,
							t.agent,
							t.task,
							t.cwd,
							t.model,
							undefined,
							signal,
							// Per-task update callback
							(partial) => {
								if (partial.details?.results[0]) {
									allResults[index] = partial.details.results[0];
									emitParallelUpdate();
								}
							},
							makeDetails("parallel"),
							0,
							{
								runId,
								mode: "parallel",
								fallback: t.routerFallback,
								fallbackFromModel: t.routerFallbackFromModel,
								fallbackReason: t.routerFallbackReason,
								cooldownUntil: t.routerCooldownUntil,
								blockedReason: t.routerBlockedReason,
								forceModel: t.forceModel,
								contextBudget: t.contextBudget,
								runtimePolicy: t.runtimePolicy,
								...routeContext(index),
							},
						);
						recordPipelineResult(result);
						allResults[index] = result;
						emitParallelUpdate();
						return result;
					},
				);

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				stopRoutedStatus();
				updateRoutedStatus(results, successCount === 0 ? "error" : "done");
				const summaries = results.map((r) => {
					const output = truncateParallelOutput(getResultOutput(r));
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					const fallback = fallbackNotice(r);
					return `### [${r.agent}] ${status}${fallback ? ` — ${fallback}` : ""}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (params.agent && params.task) {
				const singleUpdate: OnUpdateCallback | undefined = onUpdate
					? (partial) => {
							if (partial.details?.results[0]) updateRoutedStatus(partial.details.results);
							onUpdate(partial);
						}
					: undefined;
				let result = await runSingleAgent(
					ctx.cwd,
					dispatchDefaults,
					agents,
					params.agent,
					params.task,
					params.cwd,
					params.model,
					undefined,
					signal,
					singleUpdate,
					makeDetails("single"),
					0,
					{
						runId,
						mode: "single",
						fallback: params.routerFallback,
						fallbackFromModel: params.routerFallbackFromModel,
						fallbackReason: params.routerFallbackReason,
						cooldownUntil: params.routerCooldownUntil,
						blockedReason: params.routerBlockedReason,
						forceModel: params.forceModel,
						contextBudget: params.contextBudget,
						runtimePolicy: params.runtimePolicy,
						...routeContext(0),
					},
				);
				if (controlledTaskState) {
					result.controlTaskId = controlledTaskState.taskId;
					controlledTaskState = recordTaskAttempt(controlledTaskState.taskId, {
						kind: "worker",
						status: controlAttemptStatus(result),
						reason: compactStatusText(getResultOutput(result), 240),
						at: Date.now(),
					});
					let rework = 0;
					while (
						isFailedResult(result) &&
						!isQuotaMessage(getResultOutput(result)) &&
						rework < controlledTaskState.control.maxRework
					) {
						rework++;
						controlledTaskState = updateTaskState(
							controlledTaskState.taskId,
							(state) => ({
								...state,
								status: "rework",
								reworkCount: state.reworkCount + 1,
							}),
							undefined,
						);
						result = await runSingleAgent(
							ctx.cwd,
							dispatchDefaults,
							agents,
							params.agent,
							`${params.task}\n\nPrevious controlled attempt failed; repair the failure and retry.\n${prepareHandoff(getResultOutput(result)).text}`,
							params.cwd,
							params.model,
							undefined,
							signal,
							singleUpdate,
							makeDetails("single"),
							rework,
							{
								runId,
								mode: "single",
								fallback: params.routerFallback,
								fallbackFromModel: params.routerFallbackFromModel,
								fallbackReason: params.routerFallbackReason,
								cooldownUntil: params.routerCooldownUntil,
								blockedReason: params.routerBlockedReason,
								forceModel: params.forceModel,
								contextBudget: params.contextBudget,
								runtimePolicy: params.runtimePolicy,
								...routeContext(0),
							},
						);
						result.controlTaskId = controlledTaskState.taskId;
						controlledTaskState = recordTaskAttempt(controlledTaskState.taskId, {
							kind: "rework",
							status: controlAttemptStatus(result),
							reason: compactStatusText(getResultOutput(result), 240),
							at: Date.now(),
						});
					}
					if (isFailedResult(result)) {
						controlledTaskState = isQuotaMessage(getResultOutput(result))
							? updateTaskState(
									controlledTaskState.taskId,
									(state) => ({ ...state, status: "needs-user-decision" }),
									undefined,
								)
							: markTakeoverReady(controlledTaskState.taskId, "Worker failed after bounded rework");
						result.controlStatus = controlledTaskState.status;
						result.takeoverReady = controlledTaskState.status === "takeover-ready";
					} else {
						controlledTaskState = updateTaskState(
							controlledTaskState.taskId,
							(state) => ({ ...state, status: "done" }),
							undefined,
						);
						result.controlStatus = "done";
					}
				}
				recordPipelineResult(result);
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					stopRoutedStatus();
					updateRoutedStatus([result], "error");
					return {
						content: [
							{
								type: "text",
								text: `Agent ${result.stopReason || "failed"}: ${errorMsg}${fallbackNotice(result) ? `\n${fallbackNotice(result)}` : ""}${controlledTaskState ? `\nControl: ${controlledTaskState.status} (${controlledTaskState.taskId})${controlledTaskState.status === "takeover-ready" ? "; call subagent_takeover" : ""}` : ""}`,
							},
						],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				stopRoutedStatus();
				updateRoutedStatus([result], "done");
				return {
					content: [
						{
							type: "text",
							text: [getFinalOutput(result.messages) || "(no output)", fallbackNotice(result)]
								.filter(Boolean)
								.join("\n"),
						},
					],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, context) {
			const scope: AgentScope = args.agentScope ?? "user";
			const routed = getRoutedCallItems(context.toolCallId) ?? [];
			const route = (
				item: { agent?: string; model?: string; routerFallbackFromModel?: string },
				index: number,
			) => {
				const selected = item.model ? item : routed[index];
				if (!selected?.model) return undefined;
				const fallback = selected.routerFallbackFromModel
					? ` (${selected.routerFallbackFromModel} fallback)`
					: "";
				return `router: ${selected.agent ?? item.agent ?? "?"} → ${selected.model}${fallback}`;
			};
			const routeText = (
				item: { agent?: string; model?: string; routerFallbackFromModel?: string },
				index: number,
			) => {
				const tag = route(item, index);
				return tag ? theme.fg("muted", ` · ${tag}`) : "";
			};
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						routeText(step, i) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3)
					text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const [i, t] of args.tasks.slice(0, 3).entries()) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${routeText(t, i)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3)
					text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || routed[0]?.agent || "...";
			const preview = args.task
				? args.task.length > 60
					? `${args.task.slice(0, 60)}...`
					: args.task
				: "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`) +
				routeText(args, 0);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") +
											formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT)
						text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => !isFailedResult(r)).length;
				const icon =
					successCount === details.results.length
						? theme.fg("success", "✓")
						: theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = !isFailedResult(r) ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(
							new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0),
						);

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") +
											formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = !isFailedResult(r) ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter(
					(r) => r.exitCode !== -1 && !isFailedResult(r),
				).length;
				const failCount = details.results.filter(
					(r) => r.exitCode !== -1 && isFailedResult(r),
				).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(
							new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0),
						);

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") +
											formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
