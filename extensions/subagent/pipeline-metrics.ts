import fs from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

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
	requestedModel?: string;
	actualModel?: string;
	fallback: boolean;
	latencyMs: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	cost: number;
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

export function readPipelineMetrics(query: PipelineMetricsQuery): PipelineMetricRecord[] {
	try {
		const cutoff = Date.now() - Math.max(1, query.days) * 24 * 60 * 60 * 1000;
		const lines = fs.readFileSync(PIPELINE_METRICS_FILE, "utf8").split("\n");
		const records: PipelineMetricRecord[] = [];
		for (let i = lines.length - 1; i >= 0 && records.length < query.limit; i--) {
			if (!lines[i]) continue;
			try {
				const value: unknown = JSON.parse(lines[i]);
				if (isMetricRecord(value) && value.at >= cutoff) records.push(value);
			} catch {
				// Ignore a partial or malformed telemetry line.
			}
		}
		return records.reverse();
	} catch {
		return [];
	}
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
		increment(summary.byMode, record.mode);
		increment(summary.byPhase, record.phase);
		increment(summary.byAgent, record.agent);
		increment(summary.byModel, record.actualModel ?? record.requestedModel);
	}
	for (const flags of runFlags.values()) {
		if (flags.failure) summary.runsWithFailure++;
		if (flags.outputRetry) summary.runsWithOutputRetry++;
		if (flags.replan) summary.runsWithReplan++;
	}
	return summary;
}
