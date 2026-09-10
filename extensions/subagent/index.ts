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
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
	parseVerificationStatus,
	prepareHandoff,
} from "./packet.ts";
import { getRoutedCallItems } from "../subagent-model-router.ts";
import { upsertTask } from "../task-dock.ts";
import {
	openSubagentFleetInspector,
	type SubagentFleetRun,
	type SubagentRunStatus,
} from "./fleet-inspector.ts";
import {
	appendPipelineMetric,
	prunePipelineMetrics,
	readPipelineMetrics,
	summarizePipelineMetrics,
	type PipelineMetricRecord,
} from "./pipeline-metrics.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CHAIN_STEPS = 6;
const MAX_CONCURRENCY = 4;
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
	agent: string;
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
	return result.exitCode === 0 ? "completed" : "failed";
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
	replan?: boolean;
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
	if (Number.isFinite(result.usage.cost)) pipelineMetrics.totalCost += result.usage.cost;
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
		requestedModel: result.requestedModel,
		actualModel: result.actualModel ?? result.model,
		fallback: result.fallback ?? context.fallback ?? false,
		latencyMs: result.latencyMs ?? Math.max(0, Date.now() - startedAt),
		inputTokens: result.usage.input,
		outputTokens: result.usage.output,
		cacheReadTokens: result.usage.cacheRead,
		cacheWriteTokens: result.usage.cacheWrite,
		cost: result.usage.cost,
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
}

type RoutedStatusItem = { agent: string; task: string; model?: string };

function routedTaskTitle(task: string | undefined): string {
	const clean = (task ?? "task")
		.split("\n\n--- Return contract (injected")[0]
		.split(/\r?\n/, 1)[0]
		.trim();
	return clean.length > 56 ? `${clean.slice(0, 55)}…` : clean || "task";
}

function publishRoutedStatus(
	ctx: any,
	toolCallId: string,
	mode: "single" | "parallel" | "chain",
	items: RoutedStatusItem[],
	results: SingleResult[],
	startedAt: number,
	state: "running" | "done" | "error" = "running",
): void {
	if (!ctx?.hasUI || items.length === 0) return;
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
			startedAt,
			detail: routedTaskTitle(item.task),
			summary: result ? compactStatusText(finalOutput) : undefined,
			activity: result ? getActivitySummary(result.messages) : undefined,
			tokens: result ? { input: result.usage.input, output: result.usage.output } : undefined,
			cost: result && Number.isFinite(result.usage.cost) ? result.usage.cost : undefined,
		});
	});
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

function parseNeedsReplan(text: string): boolean {
	return /(?:NEEDS_REPLAN|needs_replan)\s*:\s*(?:true|yes)\b/i.test(text);
}

function shouldReplan(
	result: SingleResult,
	step: { phase?: "scout" | "reason" | "execute" | "verify" },
): boolean {
	if (result.needsReplan) return true;
	if (step.phase !== "execute") return false;
	return (
		result.exitCode !== 0 ||
		result.stopReason === "error" ||
		result.stopReason === "aborted" ||
		result.verificationStatus === "fail" ||
		result.verificationStatus === "blocked"
	);
}

export const __test = { isFailedResult, parseNeedsReplan, shouldReplan };

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

const ROUTER_QUOTA_RE = /throttl|rate.?limit|too many requests|quota|exceeded|budget|429/i;
const OUTPUT_LIMIT_RE =
	/maximum output token limit|output token limit|max(?:imum)?[_ -]tokens?|max_tokens|finish(?:ed)?\s+because\s+.*token/i;
const MAX_OUTPUT_LIMIT_RETRIES = 2;
const ROUTER_COOLDOWN_MS = 10 * 60 * 1000;
// Reactive health for the model router: when a subagent model hits a quota /
// 429 / rate-limit error, park it in <agentDir>/router-health.json so the
// router (subagent-model-router.ts) routes around it until the cooldown lapses.
function recordCooldownIfQuota(model: string | undefined, result: SingleResult): void {
	if (!model) return;
	const text = `${result.errorMessage ?? ""} ${result.stderr ?? ""}`;
	if (!ROUTER_QUOTA_RE.test(text)) return;
	try {
		const p = path.join(getAgentDir(), "router-health.json");
		let data: Record<string, number> = {};
		try {
			data = JSON.parse(fs.readFileSync(p, "utf-8"));
		} catch {
			data = {};
		}
		data[model] = Date.now() + ROUTER_COOLDOWN_MS;
		fs.writeFileSync(p, JSON.stringify(data, null, 2));
	} catch {
		/* best-effort */
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
			fallback: attemptContext.fallback ?? false,
			step,
		};
		recordAttemptMetric(unknownResult, attemptContext, startedAt, retryAttempt);
		return unknownResult;
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	const inheritsDispatchConfig = !agent.model && !modelOverride;
	const model = modelOverride ?? agent.model ?? dispatchDefaults.model;
	if (model) args.push("--model", model);
	if (inheritsDispatchConfig && dispatchDefaults.thinkingLevel) {
		args.push("--thinking", dispatchDefaults.thinkingLevel);
	}
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

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
		requestedModel: model,
		fallback: attemptContext.fallback,
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
		let wasAborted = false;
		let wasCancelled = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
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
		if (!metricRecorded) {
			currentResult.latencyMs = Math.max(0, Date.now() - startedAt);
			recordAttemptMetric(currentResult, attemptContext, startedAt, retryAttempt);
		}
	}
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	model: Type.Optional(Type.String({ description: "Model selected by the router" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	routerFallback: Type.Optional(Type.Boolean()),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	phase: Type.Optional(
		StringEnum(["scout", "reason", "execute", "verify"] as const, {
			description: "Optional pipeline phase used for handoff policy and task-dock visibility",
		}),
	),
	model: Type.Optional(Type.String({ description: "Model selected by the router" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	routerFallback: Type.Optional(Type.Boolean()),
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
	routerFallback: Type.Optional(Type.Boolean()),
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

export default function (pi: ExtensionAPI) {
	if (typeof pi.registerShortcut === "function") {
		pi.registerShortcut("ctrl+alt+i", {
			description: "Inspect routed subagent runs",
			handler: async (ctx) => {
				await openSubagentFleetInspector(ctx, subagentFleetSnapshot, {
					cancel: cancelSubagentRun,
					guide: (runId) => {
						void (async () => {
							const guidance = await ctx.ui.editor("Guide subagent (interrupt + relaunch)", "");
							if (guidance === undefined) return;
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
		name: "subagent_metrics",
		label: "Subagent metrics",
		description:
			"Read aggregated subagent routing telemetry from the local JSONL metrics file. Reports latency, token/cache usage, cost, failures, fallbacks, and counts by mode/phase/agent/model.",
		parameters: PipelineMetricsParams,
		async execute(_toolCallId, params) {
			const pruned = params.prune
				? prunePipelineMetrics({ retentionDays: params.retentionDays ?? 30 })
				: 0;
			const records = readPipelineMetrics({
				days: params.days ?? 30,
				limit: params.limit ?? 5000,
			});
			const summary = { ...summarizePipelineMetrics(records), pruned };
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

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
					pipelineMetrics: pipelineMetricsSnapshot(),
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
						model: statusModelFor(item.agent),
					}))
				: hasTasks
					? (params.tasks ?? []).map((item) => ({
							agent: item.agent,
							task: item.task,
							model: statusModelFor(item.agent),
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
			const updateRoutedStatus = (
				results: SingleResult[] = latestStatusResults,
				state: "running" | "done" | "error" = "running",
			) => {
				latestStatusResults = results;
				publishRoutedStatus(
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
			updateRoutedStatus();
			if (ctx?.hasUI) {
				statusTimer = setInterval(() => updateRoutedStatus(), 1000);
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
						{ runId, mode: "chain", phase: step.phase, step: i + 1, fallback: step.routerFallback },
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
						const reasonStep = params.chain.find(
							(candidate) => candidate.phase === "reason" || candidate.agent === "planner",
						);
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
									text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}`,
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
							text: getFinalOutput(results[results.length - 1].messages) || "(no output)",
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
							{ runId, mode: "parallel", fallback: t.routerFallback },
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
					return `### [${r.agent}] ${status}\n\n${output}`;
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
				const result = await runSingleAgent(
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
					{ runId, mode: "single", fallback: params.routerFallback },
				);
				recordPipelineResult(result);
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					stopRoutedStatus();
					updateRoutedStatus([result], "error");
					return {
						content: [
							{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` },
						],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				stopRoutedStatus();
				updateRoutedStatus([result], "done");
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
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
			const route = (item: { agent?: string; model?: string }, index: number) => {
				const selected = item.model ? item : routed[index];
				return selected?.model
					? `router: ${selected.agent ?? item.agent ?? "?"} → ${selected.model}`
					: undefined;
			};
			const routeText = (item: { agent?: string; model?: string }, index: number) => {
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
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
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
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
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
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
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
