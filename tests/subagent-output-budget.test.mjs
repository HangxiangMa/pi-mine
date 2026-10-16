// Child-side output-cap clamp. A routed subagent gets PI_CONTEXT_BUDGET from the
// router; the clamp must lower the outgoing output cap to that budget, never raise
// it, and stay inert outside a routed subagent.
import assert from "node:assert/strict";
import { clampOutputCap, budgetFromChildEnv } from "../extensions/subagent/output-budget.ts";

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`not ok  ${name}`);
    console.log(err.stack ?? err);
  }
}

const budget = { contextWindow: 272000, compactThreshold: 217600, defaultOutputTokens: 32768, maxOutputTokens: 32768 };

check("lowers an oversized max_tokens to the budget cap", () => {
  const out = clampOutputCap({ model: "m", max_tokens: 128000 }, budget);
  assert.equal(out.max_tokens, 32768);
  assert.equal(out.model, "m");
});

check("never raises a cap that is already below the budget", () => {
  const payload = { max_tokens: 1024 };
  const out = clampOutputCap(payload, budget);
  assert.equal(out.max_tokens, 1024);
  assert.equal(out, payload, "unchanged payload is returned as the same object");
});

check("clamps every provider output-cap field name it recognises", () => {
  const out = clampOutputCap(
    { max_tokens: 99999, max_completion_tokens: 99999, max_output_tokens: 99999, maxOutputTokens: 99999 },
    budget,
  );
  assert.equal(out.max_tokens, 32768);
  assert.equal(out.max_completion_tokens, 32768);
  assert.equal(out.max_output_tokens, 32768);
  assert.equal(out.maxOutputTokens, 32768);
});

check("does not add an output-cap field the payload did not carry", () => {
  const out = clampOutputCap({ messages: [] }, budget);
  assert.equal("max_tokens" in out, false);
  assert.equal("max_completion_tokens" in out, false);
});

check("passes non-object and array payloads through untouched", () => {
  assert.equal(clampOutputCap(undefined, budget), undefined);
  assert.equal(clampOutputCap(null, budget), null);
  assert.equal(clampOutputCap("text", budget), "text");
  const arr = [1, 2];
  assert.equal(clampOutputCap(arr, budget), arr);
});

check("ignores non-numeric and non-finite cap values", () => {
  const payload = { max_tokens: "99999", max_output_tokens: Number.NaN };
  const out = clampOutputCap(payload, budget);
  assert.equal(out, payload);
});

check("does not mutate the caller's payload", () => {
  const payload = { max_tokens: 128000 };
  clampOutputCap(payload, budget);
  assert.equal(payload.max_tokens, 128000);
});

check("budgetFromChildEnv is inert without PI_SUBAGENT_RUN_ID", () => {
  const env = { PI_CONTEXT_BUDGET: JSON.stringify(budget) };
  assert.equal(budgetFromChildEnv(env), undefined);
});

check("budgetFromChildEnv reads the router budget inside a routed subagent", () => {
  const prev = process.env.PI_CONTEXT_BUDGET;
  const prevRun = process.env.PI_SUBAGENT_RUN_ID;
  try {
    process.env.PI_SUBAGENT_RUN_ID = "run-1";
    process.env.PI_CONTEXT_BUDGET = JSON.stringify(budget);
    const parsed = budgetFromChildEnv();
    assert.equal(parsed.maxOutputTokens, 32768);
    assert.equal(parsed.contextWindow, 272000);
  } finally {
    if (prev === undefined) delete process.env.PI_CONTEXT_BUDGET;
    else process.env.PI_CONTEXT_BUDGET = prev;
    if (prevRun === undefined) delete process.env.PI_SUBAGENT_RUN_ID;
    else process.env.PI_SUBAGENT_RUN_ID = prevRun;
  }
});

if (failed > 0) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log("subagent output budget: all passed");
