import assert from "node:assert/strict";
import { contextBudget, contextBudgetForModel, escalateOutputBudget, shouldRetryOutputLimit } from "../extensions/context-budget.ts";
import { normalizeAgentRuntimePolicy } from "../extensions/subagent/packet.ts";
import { makePolicyAuditRecord, resolvePolicyRules } from "../extensions/tool-policy.ts";

assert.equal(resolvePolicyRules([
  { effect: "allow", matcher: "bash", source: "test" },
  { effect: "deny", matcher: "bash(git push*)", source: "test" },
], "bash", { command: "git push origin main" }).behavior, "deny");
assert.equal(resolvePolicyRules([
  { effect: "deny", matcher: "read(/tmp/*)", source: "test" },
], "read", { path: "/tmp/../etc/passwd" }, "/tmp").behavior, "passthrough");
assert.equal(resolvePolicyRules([
  { effect: "deny", matcher: "read(src/foo.ts)", source: "test" },
], "read", { path: "src/foo.ts" }, "/repo").behavior, "deny");
assert.equal(contextBudget({ providerSupportsLongContext: true, explicitLongContext: true }).contextWindow, 1_000_000);
assert.equal(contextBudget({ providerSupportsLongContext: false, explicitLongContext: true }).contextWindow, 200_000);
const savedContextEnv = {
  window: process.env.PI_CONTEXT_WINDOW,
  models: process.env.PI_LONG_CONTEXT_MODELS,
  provider: process.env.PI_PROVIDER_LONG_CONTEXT,
};
process.env.PI_CONTEXT_WINDOW = "1000000";
process.env.PI_LONG_CONTEXT_MODELS = "model/long";
process.env.PI_PROVIDER_LONG_CONTEXT = "0";
assert.equal(contextBudgetForModel("model/long").contextWindow, 200_000);
process.env.PI_PROVIDER_LONG_CONTEXT = "1";
assert.equal(contextBudgetForModel("model/long").contextWindow, 1_000_000);
for (const [key, value] of Object.entries({
  PI_CONTEXT_WINDOW: savedContextEnv.window,
  PI_LONG_CONTEXT_MODELS: savedContextEnv.models,
  PI_PROVIDER_LONG_CONTEXT: savedContextEnv.provider,
})) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
const budget = contextBudget({ escalationOutputTokens: 64_000 });
assert.equal(escalateOutputBudget(budget, false).maxOutputTokens, 64_000);
assert.equal(escalateOutputBudget(budget, true).maxOutputTokens, budget.maxOutputTokens);
assert.equal(shouldRetryOutputLimit(0, new Error("max_tokens exceeded")), true);
assert.equal(shouldRetryOutputLimit(1, new Error("max_tokens exceeded")), false);
assert.deepEqual(normalizeAgentRuntimePolicy({ isolation: "worktree", allowedTools: [" bash ", 4] }, "/repo"), {
  cwd: "/repo", isolation: "worktree", permissionMode: "default", allowedTools: ["bash"], deniedTools: undefined, mcpServers: undefined,
});
const audit = makePolicyAuditRecord({ toolName: "bash", input: { command: "secret" }, decision: "deny", latencyMs: 1 });
assert.equal(audit.inputHash.length, 64);
assert.equal("command" in audit, false);
console.log("runtime policy contract tests: ok");
