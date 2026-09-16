#!/usr/bin/env node
/** Summarize token-efficiency-metrics.jsonl without external dependencies. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const valueAfter = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? Number(args[index + 1]) : fallback;
};
const days = Math.max(1, valueAfter("--days", 30));
const limit = Math.max(1, valueAfter("--limit", 10_000));
const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
const file = process.env.PI_TOKEN_METRICS_FILE || path.join(agentDir, "token-efficiency-metrics.jsonl");
const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

let records = [];
try {
  records = fs.readFileSync(file, "utf8").split("\n").flatMap((line) => {
    if (!line) return [];
    try {
      const record = JSON.parse(line);
      return record?.schema === 1 && Number(record.at) >= cutoff ? [record] : [];
    } catch {
      return [];
    }
  }).slice(-limit);
} catch {
  // Empty report is useful on a new installation.
}

const sum = (key) => records.reduce((total, record) => total + (Number(record[key]) || 0), 0);
const average = (key) => records.length ? sum(key) / records.length : 0;
const totalPrompt = sum("freshInputTokens") + sum("cacheReadTokens") + sum("cacheCreateTokens");
const cacheHit = totalPrompt ? (sum("cacheReadTokens") / totalPrompt) * 100 : null;
const quality = records.filter((record) => record.quality === "accepted" || record.quality === "rework");
const accepted = quality.filter((record) => record.quality === "accepted").length;
const rework = quality.filter((record) => record.quality === "rework").length;
const sessions = new Set(records.map((record) => record.sessionId).filter(Boolean)).size;
const fmt = (value) => Math.round(value).toLocaleString();

console.log(JSON.stringify({
  file,
  days,
  records: records.length,
  sessions,
  freshInputTokens: sum("freshInputTokens"),
  cacheReadTokens: sum("cacheReadTokens"),
  cacheCreateTokens: sum("cacheCreateTokens"),
  outputTokens: sum("outputTokens"),
  cacheHitRatePercent: cacheHit === null ? null : Number(cacheHit.toFixed(2)),
  avgActiveToolSchemaTokens: Math.round(average("activeToolSchemaTokens")),
  avgActiveToolCount: Number(average("activeToolCount").toFixed(2)),
  totalToolCalls: sum("toolCallCount"),
  avgLatencyMs: Math.round(average("latencyMs")),
  firstPassAcceptancePercent: quality.length ? Number(((accepted / quality.length) * 100).toFixed(2)) : null,
  reworkPercent: quality.length ? Number(((rework / quality.length) * 100).toFixed(2)) : null,
  qualitySamples: quality.length,
}, null, 2));

if (records.length === 0) {
  console.error(`No records found. Start pi, then rerun; expected file: ${file}`);
} else {
  console.error(`Token metrics: ${records.length} turns, ${sessions} sessions, ${fmt(totalPrompt)} prompt tokens`);
}
