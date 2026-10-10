import assert from "node:assert/strict";
import { estimateModelCost, estimateRequestCost } from "../extensions/model-pricing.ts";
import { contextBudgetForModel } from "../extensions/context-budget.ts";

const HAIKU = "breeze/claude-haiku-5-5";
const OPUS = "breeze/claude-opus-5-5";
const near = (actual, want, msg) => assert.ok(Math.abs(actual - want) < 1e-9, `${msg}: got ${actual}, want ${want}`);

// --- Haiku 5.5 prompt-size break (official: $0.10/$0.50 up to 100K, $0.50/$2.50 over) ---
// A request at exactly 100K stays on the flat tier: the break is "over", not "at or over".
near(estimateRequestCost(HAIKU, { input: 100_000, output: 1_000_000 }), 0.01 + 0.5, "haiku at 100K is flat");
near(estimateRequestCost(HAIKU, { input: 100_001, output: 1_000_000 }), (0.5 * 100_001) / 1e6 + 2.5, "haiku over 100K breaks");
// The prompt is input + cache read + cache write, so cache-heavy prompts cross the break too.
near(
  estimateRequestCost(HAIKU, { input: 50_000, cacheRead: 60_000 }),
  (0.5 * 50_000) / 1e6 + (0.05 * 60_000) / 1e6,
  "cache read counts toward the prompt size",
);
// Opus publishes no break, so a 300K prompt stays on the flat rate.
near(estimateRequestCost(OPUS, { input: 300_000 }), 1.2, "opus has no break");
assert.equal(estimateRequestCost("no-such-model", { input: 1 }), undefined, "unknown model is undefined");

// The break is per request. A turn-by-turn sum must differ from the accumulated total,
// which is why the spawner prices each turn and does not price the total.
const turns = [{ input: 90_000 }, { input: 90_000 }, { input: 150_000 }];
const perTurn = turns.reduce((sum, t) => sum + estimateRequestCost(HAIKU, t), 0);
const accumulated = estimateModelCost(HAIKU, { input: 330_000 });
assert.ok(perTurn > accumulated, `per-turn ${perTurn} should exceed flat accumulated ${accumulated}`);

// --- 100K default subagent window -------------------------------------------------
const budget = contextBudgetForModel("ordinary");
assert.equal(budget.contextWindow, 200_000, "subagent default window is 200K");
assert.equal(budget.compactThreshold, 160_000, "compaction at 80% of the 200K window");

console.log("model pricing contracts: ok");
