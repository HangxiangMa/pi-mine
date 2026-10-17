// readPipelineMetricsReport must surface what it skips, while readPipelineMetrics keeps its
// original return value. Runs against a temporary agent directory, never the real one.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { locatePiJiti } from "./lib/pi-jiti-locate.mjs";

const require = createRequire(import.meta.url);
const here = path.dirname(new URL(import.meta.url).pathname);
const pkgRoot = path.resolve(here, "..");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "metrics-report-"));
const shim = path.join(tmp, "shim.cjs");
fs.writeFileSync(shim, `exports.getAgentDir = () => process.env.PI_ROUTER_TEST_DIR;\n`);
process.env.PI_ROUTER_TEST_DIR = tmp;

function resolvePiBin() {
  if (process.env.PI_BIN) return fs.realpathSync(process.env.PI_BIN);
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(dir, "pi");
    if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
  }
  throw new Error("pi executable not found: set PI_BIN or put pi on PATH");
}

const piBin = resolvePiBin();
const jitiDir = locatePiJiti(piBin);
if (!jitiDir) throw new Error(`pi package jiti not found near ${piBin}`);
const loader = require(jitiDir)(pkgRoot, {
  interopDefault: true,
  alias: {
    "@earendil-works/pi-coding-agent": shim,
    "@earendil-works/pi-tui": path.join(path.dirname(jitiDir), "@earendil-works/pi-tui"),
  },
});
const metrics = loader(path.join(pkgRoot, "extensions/subagent/pipeline-metrics.ts"));

const file = metrics.PIPELINE_METRICS_FILE;
assert.ok(file.startsWith(tmp), `metrics must live in the temp dir, got ${file}`);

const now = Date.now();
const valid = (runId) => ({
  schema: 1, runId, at: now, agent: "coder", mode: "routed", latencyMs: 5,
  inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0,
  model: "breeze/claude-haiku-5-5", requestedModel: "breeze/claude-haiku-5-5",
  exitCode: 0, failed: false, attempts: 1, fallbackUsed: false,
});
const stale = { ...valid("stale"), at: now - 400 * 24 * 60 * 60 * 1000 };
const wrongSchema = { ...valid("schema2"), schema: 2 };
const missingField = (() => { const r = valid("nofield"); delete r.latencyMs; return r; })();

const lines = [
  JSON.stringify(valid("a")),
  '{"schema":1,"runId":"trunc', // truncated write: malformed JSON
  JSON.stringify(wrongSchema),
  JSON.stringify(missingField),
  JSON.stringify(stale),
  "",
  JSON.stringify(valid("b")),
];
fs.writeFileSync(file, lines.join("\n") + "\n");

// --- report: counts reflect what was skipped and why -----------------------------------
const report = metrics.readPipelineMetricsReport({ days: 30, limit: 100 });
assert.deepEqual(report.records.map((r) => r.runId), ["a", "b"], "valid in-window records are kept, in order");
assert.equal(report.skipped.malformed, 1, "one truncated line is counted as malformed");
assert.equal(report.skipped.invalid, 2, "wrong schema and missing field are both counted as invalid");
assert.equal(report.skipped.readError, undefined, "a readable file reports no read error");
// A stale record is valid, just out of window: it is neither kept nor counted as skipped.
assert.ok(!report.records.some((r) => r.runId === "stale"), "out-of-window record is excluded");

// --- compatibility: readPipelineMetrics returns exactly the report's records -----------
const legacy = metrics.readPipelineMetrics({ days: 30, limit: 100 });
assert.deepEqual(legacy.map((r) => r.runId), report.records.map((r) => r.runId), "legacy return value is unchanged");

// --- a missing file is the normal first-run state, not an error ----------------------
fs.rmSync(file);
const fresh = metrics.readPipelineMetricsReport({ days: 30, limit: 100 });
assert.deepEqual(fresh.records, [], "no file means no records");
assert.equal(fresh.skipped.readError, undefined, "ENOENT is not reported as a read error");
assert.deepEqual(metrics.readPipelineMetrics({ days: 30, limit: 100 }), [], "legacy returns [] on a missing file");

// --- an unreadable file surfaces the error instead of hiding it ---------------------
fs.mkdirSync(file); // a directory where the file should be: readFileSync throws EISDIR
const broken = metrics.readPipelineMetricsReport({ days: 30, limit: 100 });
assert.deepEqual(broken.records, [], "unreadable file yields no records");
assert.ok(typeof broken.skipped.readError === "string" && broken.skipped.readError.length > 0,
  "a non-ENOENT read failure is reported in skipped.readError");
fs.rmdirSync(file);

// --- the query limit still counts only kept records -----------------------------------
fs.writeFileSync(file, [JSON.stringify(valid("x1")), JSON.stringify(wrongSchema), JSON.stringify(valid("x2"))].join("\n") + "\n");
const limited = metrics.readPipelineMetricsReport({ days: 30, limit: 1 });
assert.deepEqual(limited.records.map((r) => r.runId), ["x2"], "limit applies to kept records, scanning newest first");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("pipeline metrics report contracts: ok");
