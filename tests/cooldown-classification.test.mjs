// Cooldown recording must classify only provider error channels. Covers the
// subagent failure path (recordCooldownIfQuota) end to end through the real
// router-health store, using a temporary agent directory.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const here = path.dirname(new URL(import.meta.url).pathname);
const pkgRoot = path.resolve(here, "..");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cooldown-classify-"));
const shim = path.join(tmp, "shim.cjs");
fs.writeFileSync(shim, `exports.getAgentDir = () => process.env.PI_ROUTER_TEST_DIR;\n`);
process.env.PI_ROUTER_TEST_DIR = tmp;

// Resolve the pi executable from PI_BIN or PATH. Unlike the shell suites this test
// must not skip: it guards against wrongly cooling a healthy model, so a silent
// skip would let a regression pass `npm test`.
function resolvePiBin() {
  if (process.env.PI_BIN) return fs.realpathSync(process.env.PI_BIN);
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(dir, "pi");
    if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
  }
  throw new Error("pi executable not found: set PI_BIN or put pi on PATH");
}

const piBin = resolvePiBin();
const jitiCandidates = [
  path.join(path.dirname(piBin), "../../node_modules/jiti"),
  path.join(path.dirname(piBin), "node_modules/@earendil-works/pi-coding-agent/node_modules/jiti"),
  path.join(path.dirname(piBin), "../lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti"),
];
const jitiDir = jitiCandidates.find((candidate) => fs.existsSync(candidate));
if (!jitiDir) {
  throw new Error(`pi package jiti not found near ${piBin}`);
}
const piTui = path.join(path.dirname(jitiDir), "@earendil-works/pi-tui");
const loader = require(jitiDir)(pkgRoot, {
  interopDefault: true,
  alias: {
    "@earendil-works/pi-coding-agent": shim,
    "@earendil-works/pi-tui": piTui,
  },
});

const subagent = loader(path.join(pkgRoot, "extensions/subagent/index.ts"));
const health = loader(path.join(pkgRoot, "extensions/subagent/router-health.ts"));
const { recordCooldownIfQuota, recordAttemptMetric } = subagent.__test;
const metrics = loader(path.join(pkgRoot, "extensions/subagent/pipeline-metrics.ts"));

const MODEL = "breeze/claude-haiku-5-5";
// usage must carry the numeric token fields a real SingleResult always has;
// readPipelineMetrics silently drops records whose token fields are missing.
const base = {
  exitCode: 0,
  messages: [],
  stderr: "",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
  agent: "editor",
  task: "t",
  agentSource: "unknown",
};
const assistantText = (text) => ({ role: "assistant", content: [{ type: "text", text }] });
const cooling = () => health.coolingModels(tmp, Date.now()).has(MODEL);
const reset = () => fs.rmSync(path.join(tmp, "router-health.json"), { force: true });

let ran = 0;
const check = (name, fn) => {
  reset();
  fn();
  ran++;
  console.log(`ok  ${name}`);
};

check("provider 429 quota text in errorMessage cools the model", () => {
  recordCooldownIfQuota(MODEL, {
    ...base,
    exitCode: 1,
    errorMessage: '429 {"error":{"code":"RATE_LIMIT_EXCEEDED","message":"daily cost allowance has been exceeded","details":{"retry_after":"52189s"}}}',
  });
  assert.equal(cooling(), true);
});

check("user cancel is not a provider signal and never cools", () => {
  recordCooldownIfQuota(MODEL, {
    ...base,
    exitCode: 130,
    errorMessage: "Subagent was cancelled",
    stopReason: "aborted",
    messages: [assistantText("partial output mentioning rate limit")],
  });
  assert.equal(cooling(), false);
});

check("successful child that read text mentioning 429/rate limit does not cool", () => {
  recordCooldownIfQuota(MODEL, {
    ...base,
    exitCode: 0,
    messages: [assistantText("Done. The retry policy handles 429 and rate limit errors.")],
  });
  assert.equal(cooling(), false);
});

check("failed child whose transcript tool output mentions rate limit does not cool", () => {
  recordCooldownIfQuota(MODEL, {
    ...base,
    exitCode: 1,
    errorMessage: "task failed: unit test assertion",
    messages: [
      { role: "toolResult", content: [{ type: "text", text: "src/retry.ts: const RATE_LIMIT_RE = /rate limit/" }] },
      assistantText("Tests failed."),
    ],
  });
  assert.equal(cooling(), false);
});

check("failed child with a real throttle in stderr cools the model", () => {
  recordCooldownIfQuota(MODEL, {
    ...base,
    exitCode: 1,
    stderr: "ThrottlingException: Too many tokens, please wait",
  });
  assert.equal(cooling(), true);
});

check("missing model is a no-op", () => {
  recordCooldownIfQuota(undefined, { ...base, exitCode: 1, errorMessage: "quota exceeded" });
  assert.equal(fs.existsSync(path.join(tmp, "router-health.json")), false);
});

check("a cooldown write is attached to the attempt for TTL calibration", () => {
  const result = {
    ...base,
    exitCode: 1,
    errorMessage: '429 {"error":{"message":"daily cost allowance has been exceeded","details":{"retry_after":"52189s"}}}',
  };
  const before = Date.now();
  recordCooldownIfQuota(MODEL, result);
  const after = Date.now();
  assert.ok(result.routerCooldownWritten, "cooldown write must be recorded on the result");
  assert.equal(result.routerCooldownWritten.reason, "quota");
  assert.equal(result.routerCooldownWritten.failures, 1);
  assert.equal(result.routerCooldownWritten.advised, true, "retry_after TTL must be flagged advised");
  // until = write time + retry_after; the write happens between before and after.
  const ttl = result.routerCooldownWritten.until - before;
  assert.ok(ttl >= 52189 * 1000 && ttl <= 52189 * 1000 + (after - before), `until must reflect the retry_after window (ttl ${ttl}ms)`);
});

check("backoff TTL is flagged not-advised", () => {
  const result = { ...base, exitCode: 1, errorMessage: "HTTP 429 Too Many Requests" };
  recordCooldownIfQuota(MODEL, result);
  assert.equal(result.routerCooldownWritten?.advised, false);
});

check("no cooldown write leaves the attempt without cooldownWritten", () => {
  const result = { ...base, exitCode: 0, messages: [assistantText("ok")] };
  recordCooldownIfQuota(MODEL, result);
  assert.equal("routerCooldownWritten" in result, false);
});

check("recordAttemptMetric persists cooldownWritten only for the attempt that wrote it", () => {
  const metricFile = path.join(tmp, "pipeline-metrics.jsonl");
  fs.rmSync(metricFile, { force: true });
  const ctx = { runId: "cooldown-e2e", mode: "single" };
  const failed = {
    ...base,
    model: MODEL,
    requestedModel: MODEL,
    latencyMs: 5,
    errorMessage: '429 RATE_LIMIT_EXCEEDED daily cost allowance has been exceeded retry_after "52189s"',
  };
  recordCooldownIfQuota(MODEL, failed);
  recordAttemptMetric(failed, ctx, Date.now(), 0);
  recordAttemptMetric({ ...base, model: MODEL, requestedModel: MODEL, latencyMs: 5, exitCode: 0, messages: [] }, ctx, Date.now(), 0);
  const [cooled, clean] = fs.readFileSync(metricFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(cooled.cooldownWritten?.reason, "quota");
  assert.equal(cooled.cooldownWritten?.advised, true);
  assert.equal("cooldownWritten" in clean, false, "a non-cooling attempt must not carry cooldownWritten");
  assert.equal(metrics.readPipelineMetrics({ days: 1, limit: 10 }).length, 2, "both records remain readable");
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${ran} passed, 0 failed`);
