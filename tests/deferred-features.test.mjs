import assert from "node:assert/strict";
import { contextBudgetForModel } from "../extensions/context-budget.ts";
import { validateHooksConfig, validatePermissionsConfig, hasErrors } from "../extensions/config/validation.ts";
import { searchSessions, sessionCandidateFromEntries } from "../extensions/session-search.ts";
import {
	cleanupRuntimeResources,
	registerMcpClient,
	registerRuntimeResource,
	runtimeResourceSnapshot,
	startMcpRuntime,
} from "../extensions/subagent/runtime-resources.ts";

const old = { ...process.env };
try {
	delete process.env.PI_LONG_CONTEXT_MODELS;
	delete process.env.PI_PROVIDER_LONG_CONTEXT;
	assert.equal(contextBudgetForModel("ordinary").contextWindow, 200_000);
	process.env.PI_LONG_CONTEXT_MODELS = "long-model";
	process.env.PI_PROVIDER_LONG_CONTEXT = "1";
	assert.equal(contextBudgetForModel("long-model").contextWindow, 1_000_000);
	assert.equal(contextBudgetForModel("ordinary").contextWindow, 200_000);

	assert.equal(hasErrors(validatePermissionsConfig({ version: 1, deny: ["bash(git push*)"] })), false);
	assert.equal(hasErrors(validatePermissionsConfig({ version: 2 })), true);
	assert.equal(hasErrors(validateHooksConfig({ version: 1, tool_call: [{ hooks: [{ type: "command", command: "true" }] }] })), false);
	assert.equal(hasErrors(validateHooksConfig({ tool_call: [{ matcher: "[", hooks: [] }] })), true);

	const candidate = sessionCandidateFromEntries("s1", [
		{ message: { role: "user", content: "Fix MCP cleanup" } },
		{ message: { role: "assistant", content: "Implemented lifecycle cleanup" } },
	]);
	assert.equal(searchSessions("MCP cleanup", [candidate])[0]?.id, "s1");
	const semantic = searchSessions("cleanup", [
		{ id: "lexical", title: "cleanup" },
		{ id: "semantic", summary: "resource lifecycle" },
	], 20, {
		semanticScore: (_query, item) => item.id === "semantic" ? 1 : 0,
		semanticWeight: 20,
	});
	assert.equal(semantic[0]?.id, "semantic");
	assert.doesNotThrow(() => searchSessions("cleanup", [candidate], 20, {
		semanticScore: () => { throw new Error("provider unavailable"); },
	}));
	assert.deepEqual(searchSessions("", [candidate]), []);

	let closed = 0;
	const started = await startMcpRuntime("mcp-run", ["filesystem"], {
		start: async (servers) => servers.map((name) => ({ kind: "mcp", name, close: () => { closed++; } })),
	});
	assert.deepEqual(started, { started: 1, failed: 0 });
	assert.deepEqual(await cleanupRuntimeResources("mcp-run"), { cleaned: 1, failed: 0 });
	let clientClosed = 0;
	registerMcpClient("run", "filesystem", { close: () => { clientClosed++; } });
	assert.equal(runtimeResourceSnapshot("run")[0]?.kind, "mcp");
	registerRuntimeResource("run", { kind: "mcp", close: () => { closed++; } });
	assert.equal(runtimeResourceSnapshot("run").length, 2);
	assert.deepEqual(await cleanupRuntimeResources("run"), { cleaned: 2, failed: 0 });
	assert.equal(closed, 2);
	assert.equal(clientClosed, 1);
	assert.equal(runtimeResourceSnapshot("run").length, 0);
	assert.deepEqual(await startMcpRuntime("missing", ["filesystem"]), { started: 0, failed: 1 });
	console.log("deferred feature contracts: ok");
} finally {
	for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key];
	Object.assign(process.env, old);
}
