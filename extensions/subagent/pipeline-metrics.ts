import fs from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ContextBudget } from "../context-budget.ts";
import type { RouteEvidence } from "../subagent-model-router.ts";

export const PIPELINE_METRICS_FILE = path.join(getAgentDir(), "pipeline-metrics.jsonl");

export type PipelineMetricRecord = {
	schema: 1;
	runId: string;
	at: number;
	pid: number;
	mode: "single" | "parallel" | "chain";
	phase?: "scout" | "reason" | "execute" | "verify";
	step?: number;
	replan?: boolean;
	agent: string;
	routeEvidence?: RouteEvidence;
	requestedModel?: string;
	actualModel?: string;
	fallback: boolean;
	fallbackReason?: string;
	cooldownUntil?: number;
	/**
	 * Cooldown this attempt wrote. Pairs TTL with its source (`advised` = provider
	 * retry_after, otherwise backoff) so TTLs can be calibrated from real failures.
	 */
	cooldownWritten?: {
		reason: string;
		until: number;
		failures: number;
		advised: boolean;
	};
	blockedReason?: string;
	forceModel?: boolean;
	contextBudget?: Pick<
		ContextBudget,
		"contextWindow" | "maxOutputTokens" | "compactThreshold" | "escalationOutputTokens"
	>;
	latencyMs: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	cost: number;
	costEstimated?: boolean;
	turns: number;
	exitCode?: number;
	stopReason?: string;
	verificationStatus?: "pass" | "fail" | "blocked" | "partial" | "unknown";
	failed: boolean;
	retryAttempt: number;
};

export type PipelineMetricsQuery = {
	days: number;
	limit: number;
};

export type PipelineMetricsSummary = {
	file: string;
	periodStart?: number;
	periodEnd?: number;
	records: number;
	runs: number;
	runsWithFailure: number;
	runsWithOutputRetry: number;
	runsWithReplan: number;
	failedRecords: number;
	fallbackAttempts: number;
	totalLatencyMs: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
	totalCost: number;
	byMode: Record<string, number>;
	byPhase: Record<string, number>;
	byAgent: Record<string, number>;
	byModel: Record<string, number>;
	byRouteRule: Record<string, number>;
	byRouteCertainty: Record<string, number>;
	byModelCost: Record<string, number>;
	byAgentCost: Record<string, number>;
	estimatedCostRecords: number;
};

function isMetricRecord(value: unknown): value is PipelineMetricRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<PipelineMetricRecord>;
	return (
		record.schema === 1 &&
		typeof record.runId === "string" &&
		typeof record.at === "number" &&
		typeof record.agent === "string" &&
		typeof record.mode === "string" &&
		typeof record.latencyMs === "number" &&
		typeof record.inputTokens === "number" &&
		typeof record.outputTokens === "number" &&
		typeof record.cacheReadTokens === "number" &&
		typeof record.cacheWriteTokens === "number" &&
		typeof record.cost === "number" &&
		typeof record.failed === "boolean"
	);
}

export function appendPipelineMetric(record: PipelineMetricRecord): void {
	try {
		fs.mkdirSync(path.dirname(PIPELINE_METRICS_FILE), { recursive: true });
		fs.appendFileSync(PIPELINE_METRICS_FILE, `${JSON.stringify(record)}\n`, "utf8");
	} catch {
		// Telemetry must never make delegation fail.
	}
}

/**
 * What `readPipelineMetricsReport` could not use. Counts are surfaced so a dropped record is
 * visible rather than silently missing from the summary.
 */
export interface PipelineMetricsSkips {
	/** Lines that are not valid JSON (for example a truncated write). */
	malformed: number;
	/** Valid JSON that fails the record schema (wrong schema version or missing fields). */
	invalid: number;
	/** Set when the file exists but cannot be read. A missing file is normal and not an error. */
	readError?: string;
}

export interface PipelineMetricsReport {
	records: PipelineMetricRecord[];
	skipped: PipelineMetricsSkips;
}

export function readPipelineMetricsReport(query: PipelineMetricsQuery): PipelineMetricsReport {
	const skipped: PipelineMetricsSkips = { malformed: 0, invalid: 0 };
	let lines: string[];
	try {
		lines = fs.readFileSync(PIPELINE_METRICS_FILE, "utf8").split("\n");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		// No metrics yet is the normal first-run state, not a failure.
		if (code !== "ENOENT")
			skipped.readError = error instanceof Error ? error.message : String(error);
		return { records: [], skipped };
	}
	const cutoff = Date.now() - Math.max(1, query.days) * 24 * 60 * 60 * 1000;
	const records: PipelineMetricRecord[] = [];
	for (let i = lines.length - 1; i >= 0 && records.length < query.limit; i--) {
		if (!lines[i]) continue;
		let value: unknown;
		try {
			value = JSON.parse(lines[i]);
		} catch {
			skipped.malformed++;
			continue;
		}
		if (!isMetricRecord(value)) {
			skipped.invalid++;
			continue;
		}
		if (value.at >= cutoff) records.push(value);
	}
	return { records: records.reverse(), skipped };
}

export function readPipelineMetrics(query: PipelineMetricsQuery): PipelineMetricRecord[] {
	return readPipelineMetricsReport(query).records;
}

function increment(bucket: Record<string, number>, key: string | undefined): void {
	if (key) bucket[key] = (bucket[key] ?? 0) + 1;
}

export function prunePipelineMetrics(
	options: { retentionDays?: number; maxRecords?: number } = {},
): number {
	try {
		const lines = fs.readFileSync(PIPELINE_METRICS_FILE, "utf8").split("\n");
		const cutoff = Date.now() - Math.max(1, options.retentionDays ?? 30) * 24 * 60 * 60 * 1000;
		const records = lines.flatMap((line) => {
			if (!line) return [];
			try {
				const value: unknown = JSON.parse(line);
				return isMetricRecord(value) && value.at >= cutoff ? [value] : [];
			} catch {
				return [];
			}
		});
		const kept = records.slice(-(options.maxRecords ?? 20000));
		const removed = records.length - kept.length;
		if (removed === 0 && kept.length === lines.filter(Boolean).length) return 0;
		const tempPath = `${PIPELINE_METRICS_FILE}.${process.pid}.tmp`;
		fs.writeFileSync(
			tempPath,
			kept.map((record) => JSON.stringify(record)).join("\n") + (kept.length ? "\n" : ""),
			{
				encoding: "utf8",
				mode: 0o600,
			},
		);
		fs.renameSync(tempPath, PIPELINE_METRICS_FILE);
		return lines.filter(Boolean).length - kept.length;
	} catch {
		return 0;
	}
}

export function summarizePipelineMetrics(records: PipelineMetricRecord[]): PipelineMetricsSummary {
	const runFlags = new Map<string, { failure: boolean; outputRetry: boolean; replan: boolean }>();
	const summary: PipelineMetricsSummary = {
		file: PIPELINE_METRICS_FILE,
		periodStart: records[0]?.at,
		periodEnd: records.at(-1)?.at,
		records: records.length,
		runs: new Set(records.map((record) => record.runId)).size,
		runsWithFailure: 0,
		runsWithOutputRetry: 0,
		runsWithReplan: 0,
		failedRecords: 0,
		fallbackAttempts: 0,
		totalLatencyMs: 0,
		totalInputTokens: 0,
		totalOutputTokens: 0,
		totalCacheReadTokens: 0,
		totalCacheWriteTokens: 0,
		totalCost: 0,
		byMode: {},
		byPhase: {},
		byAgent: {},
		byModel: {},
		byRouteRule: {},
		byRouteCertainty: {},
		byModelCost: {},
		byAgentCost: {},
		estimatedCostRecords: 0,
	};
	for (const record of records) {
		const flags = runFlags.get(record.runId) ?? {
			failure: false,
			outputRetry: false,
			replan: false,
		};
		flags.failure ||= record.failed;
		flags.outputRetry ||= record.retryAttempt > 0;
		flags.replan ||= record.replan === true;
		runFlags.set(record.runId, flags);
		if (record.failed) summary.failedRecords++;
		if (record.fallback) summary.fallbackAttempts++;
		summary.totalLatencyMs += record.latencyMs;
		summary.totalInputTokens += record.inputTokens;
		summary.totalOutputTokens += record.outputTokens;
		summary.totalCacheReadTokens += record.cacheReadTokens;
		summary.totalCacheWriteTokens += record.cacheWriteTokens;
		summary.totalCost += record.cost;
		if (record.costEstimated) summary.estimatedCostRecords++;
		const model = record.actualModel ?? record.requestedModel;
		if (model) summary.byModelCost[model] = (summary.byModelCost[model] ?? 0) + record.cost;
		summary.byAgentCost[record.agent] = (summary.byAgentCost[record.agent] ?? 0) + record.cost;
		increment(summary.byMode, record.mode);
		increment(summary.byPhase, record.phase);
		increment(summary.byAgent, record.agent);
		increment(summary.byModel, record.actualModel ?? record.requestedModel);
		increment(summary.byRouteRule, record.routeEvidence?.rule);
		increment(summary.byRouteCertainty, record.routeEvidence?.certainty);
	}
	for (const flags of runFlags.values()) {
		if (flags.failure) summary.runsWithFailure++;
		if (flags.outputRetry) summary.runsWithOutputRetry++;
		if (flags.replan) summary.runsWithReplan++;
	}
	return summary;
}
