import assert from "node:assert/strict";
import { estimateModelCost, estimateRequestCost, pricingForModel } from "../extensions/model-pricing.ts";
import { contextBudgetForModel } from "../extensions/context-budget.ts";

// Gateway route: flat $1/$5 with no 100K break (verified on provider-reported cost).
const HAIKU = "breeze/claude-haiku-5-5";
// Anthropic direct: $0.10/$0.50 up to 100K, $0.50/$2.50 over.
const HAIKU_DIRECT = "anthropic/claude-haiku-5-5";
const OPUS = "breeze/claude-opus-5-5";
const near = (actual, want, msg) => assert.ok(Math.abs(actual - want) < 1e-9, `${msg}: got ${actual}, want ${want}`);

// --- Gateway Haiku 5.5 is flat: no prompt-size break on the breeze route ---
// Provider-reported cost on every breeze turn implies $1 input / $5 output / $0.10 cache read /
// $1.25 cache write, regardless of prompt size. A 300K prompt must not be billed at a break.
near(estimateRequestCost(HAIKU, { input: 300_000 }), 0.3, "gateway haiku has no break at 300K");
near(estimateRequestCost(HAIKU, { input: 100_000, output: 1_000_000 }), 0.1 + 5, "gateway haiku flat at 100K");
near(estimateRequestCost(HAIKU, { input: 100_001, output: 1_000_000 }), (1 * 100_001) / 1e6 + 5, "gateway haiku flat past 100K");
near(estimateRequestCost(HAIKU, { cacheWrite: 1_000_000 }), 1.25, "gateway haiku cache write is $1.25/M");

// --- Anthropic direct Haiku 5.5 keeps the official prompt-size break ---
near(estimateRequestCost(HAIKU_DIRECT, { input: 100_000, output: 1_000_000 }), 0.01 + 0.5, "direct haiku at 100K is flat");
near(estimateRequestCost(HAIKU_DIRECT, { input: 100_001, output: 1_000_000 }), (0.5 * 100_001) / 1e6 + 2.5, "direct haiku over 100K breaks");
// The prompt is input + cache read + cache write, so cache-heavy prompts cross the break too.
near(
  estimateRequestCost(HAIKU_DIRECT, { input: 50_000, cacheRead: 60_000 }),
  (0.5 * 50_000) / 1e6 + (0.05 * 60_000) / 1e6,
  "direct cache read counts toward the prompt size",
);
// Opus publishes no break, so a 300K prompt stays on the flat rate.
near(estimateRequestCost(OPUS, { input: 300_000 }), 1.2, "opus has no break");
assert.equal(estimateRequestCost("no-such-model", { input: 1 }), undefined, "unknown model is undefined");

// The break is per request. A turn-by-turn sum must differ from the accumulated total,
// which is why the spawner prices each turn and does not price the total.
// --- Lookup rules (price the model, never the wrong route) ----------------------------
// Vendor-prefixed ids name the upstream, not the model: `anthropic::claude-5-opus` is priced
// as `claude-5-opus`, which matches models.json on the standard QGenie route.
near(estimateModelCost("qgenie/anthropic::claude-5-opus", { input: 1_000_000 }), 4.2, "vendor-prefixed standard id is priced");
near(estimateModelCost("qgenie-gemini/vertexai::gemini-3.5-flash", { input: 1_000_000 }), 1.5, "vertexai-prefixed standard id is priced");
// A -1m route is the long-context price, which the table does not hold. It must stay
// unpriced rather than inherit the standard rate: Gemini 1M is $2.5 input, not $1.5.
assert.equal(estimateModelCost("qgenie-gemini-1m/vertexai::gemini-3.5-flash", { input: 1_000_000 }), undefined, "1M route is not undercharged at the standard rate");
assert.equal(estimateModelCost("breeze-1m/claude-haiku-5-5", { input: 1_000_000 }), undefined, "breeze 1M haiku is not undercharged at the official rate");
// Real gaps stay unpriced; no rate is invented for a model the table does not know.
assert.equal(estimateModelCost("qgenie-openai/gpt-6-astra", { input: 1_000_000 }), undefined, "gpt-6-astra has no price on record");
assert.equal(estimateModelCost("qgenie/anthropic::claude-5-5-haiku", { input: 1_000_000 }), undefined, "claude-5-5-haiku has no price on record");

// Per-turn pricing matters only on the direct route, where the break is per request.
const turns = [{ input: 90_000 }, { input: 90_000 }, { input: 150_000 }];
const perTurn = turns.reduce((sum, t) => sum + estimateRequestCost(HAIKU_DIRECT, t), 0);
const accumulated = estimateModelCost(HAIKU_DIRECT, { input: 330_000 });
assert.ok(perTurn > accumulated, `per-turn ${perTurn} should exceed flat accumulated ${accumulated}`);
// On the flat gateway route the per-turn sum equals the accumulated total.
const gwTurns = turns.reduce((sum, t) => sum + estimateRequestCost(HAIKU, t), 0);
near(gwTurns, estimateModelCost(HAIKU, { input: 330_000 }), "gateway per-turn sum equals accumulated (flat)");

// --- 100K default subagent window -------------------------------------------------
const budget = contextBudgetForModel("ordinary");
assert.equal(budget.contextWindow, 200_000, "subagent default window is 200K");
assert.equal(budget.compactThreshold, 160_000, "compaction at 80% of the 200K window");

// --- models.json drift guard -------------------------------------------------------
// Snapshot of every standard-provider cost in models.json (1M routes excluded: they are
// unpriced by design). Price drift between the table and models.json fails here.
const SNAPSHOT = [
  ["breeze", "claude-haiku-4-5-20251001", 1, 5],
  ["breeze", "claude-haiku-5-5", 1, 5],
  ["breeze", "claude-opus-4-1-20250805", 15, 75],
  ["breeze", "claude-opus-4-5-20251101", 5, 25],
  ["breeze", "claude-opus-4-6", 5, 25],
  ["breeze", "claude-opus-4-7", 5, 25],
  ["breeze", "claude-opus-4-8", 5, 25],
  ["breeze", "claude-opus-5", 5, 25],
  ["breeze", "claude-opus-5-5", 4, 20],
  ["breeze", "claude-sonnet-4-20250514", 3, 15],
  ["breeze", "claude-sonnet-4-5-20250929", 3, 15],
  ["breeze", "claude-sonnet-4-6", 3, 15],
  ["breeze", "claude-sonnet-5", 2, 10],
  ["breeze", "claude-sonnet-5-5", 2, 10],
  ["qgenie", "anthropic::claude-4-5-haiku", 0.84, 4.2],
  ["qgenie", "anthropic::claude-4-5-haiku:thinking", 1.1, 5.5],
  ["qgenie", "anthropic::claude-4-5-sonnet", 2.52, 12.6],
  ["qgenie", "anthropic::claude-4-6-opus", 4.2, 21],
  ["qgenie", "anthropic::claude-4-6-sonnet", 2.52, 12.6],
  ["qgenie", "anthropic::claude-4-7-opus", 4.2, 21],
  ["qgenie", "anthropic::claude-4-8-opus", 4.2, 21],
  ["qgenie", "anthropic::claude-5-5-haiku", 0.1, 0.5],
  ["qgenie", "anthropic::claude-5-5-sonnet", 2, 10],
  ["qgenie", "anthropic::claude-5-opus", 4.2, 21],
  ["qgenie", "anthropic::claude-5-sonnet", 1.68, 8.4],
  ["qgenie", "kimi-k2.7-code", 0.95, 4],
  ["qgenie-deepseek", "deepseek-v4-flash", 0.19, 0.51],
  ["qgenie-gemini", "vertexai::gemini-2.5-pro", 1.25, 10],
  ["qgenie-gemini", "vertexai::gemini-3-flash-preview", 0.5, 3],
  ["qgenie-gemini", "vertexai::gemini-3.1-pro-preview", 2, 12],
  ["qgenie-gemini", "vertexai::gemini-3.5-flash", 1.5, 9],
  ["qgenie-openai", "gpt-5.1", 1.25, 10],
  ["qgenie-openai", "gpt-5.2", 1.75, 14],
  ["qgenie-openai", "gpt-5.4", 2.5, 15],
  ["qgenie-openai", "gpt-5.4-mini", 0.75, 4.5],
  ["qgenie-openai", "gpt-5.5", 5, 30],
  ["qgenie-openai", "gpt-5.6-luna", 1, 6],
  ["qgenie-openai", "gpt-5.6-sol", 5, 30],
  ["qgenie-openai", "gpt-5.6-terra", 2.5, 15],
  ["qgenie-openai", "gpt-6-astra", 10, 50],
];
// Rows the table cannot price yet. Listed explicitly so that a NEW unpriced model fails the
// test instead of silently losing its price. Adding a rate here needs a source.
const KNOWN_GAPS = new Set([
  "qgenie/anthropic::claude-5-5-haiku",
  "qgenie/anthropic::claude-5-5-sonnet",
  "qgenie-openai/gpt-6-astra",
  "breeze/claude-opus-4-8",
  "breeze/claude-opus-4-7",
  "breeze/claude-opus-4-6",
  "breeze/claude-opus-4-5-20251101",
  "breeze/claude-opus-4-1-20250805",
  "breeze/claude-sonnet-4-6",
  "breeze/claude-sonnet-4-5-20250929",
  "breeze/claude-sonnet-4-20250514",
  "breeze/claude-haiku-4-5-20251001",
]);
const drift = [];
const newGaps = [];
let agreed = 0;
for (const [provider, id, input, output] of SNAPSHOT) {
  const ref = `${provider}/${id}`;
  const price = pricingForModel(ref);
  if (!price) {
    if (!KNOWN_GAPS.has(ref)) newGaps.push(ref);
    continue;
  }
  if (Math.abs(price.input - input) < 1e-9 && Math.abs(price.output - output) < 1e-9) agreed++;
  else drift.push(`${ref}: models.json ${input}/${output}, table ${price.input}/${price.output}`);
}
assert.deepEqual(drift, [], "price table drifted from models.json");
assert.deepEqual(newGaps, [], "new unpriced model: add a rate with a source or list it in KNOWN_GAPS");
assert.ok(agreed >= 28, `expected at least 28 agreeing rows, got ${agreed}`);

console.log("model pricing contracts: ok");
