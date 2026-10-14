import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { __test } from "../extensions/cost-monitor.ts";
import {
  __test as taskDockTest,
  registerTaskDockProvider,
  removeTask,
  upsertTask,
} from "../extensions/task-dock.ts";

assert.deepEqual(__test.usage(25, 100), { used: 25, cap: 100, percent: 25 });
assert.equal(__test.usage("25", 100), undefined);
assert.equal(
	__test
		.render({
			aicp: { used: 59.38, cap: 150, percent: (59.38 / 150) * 100 },
			breeze: undefined,
		})
		.replace(/\x1b\[[0-9;]*m/g, ""),
	"AICP: 59.38/150.00 (40%) · Breeze unavailable",
);
assert.deepEqual(__test.usage(30.06, 100), { used: 30.06, cap: 100, percent: 30.06 });
assert.deepEqual(
	__test.combineAicp({ used: 30.55, cap: 30, percent: 101.8 }, { used: 110.35, cap: 270, percent: 40.9 }),
	{ used: 140.9, cap: 300, percent: (140.9 / 300) * 100 },
);
assert.deepEqual(
	__test.combineAicp({ used: 5, cap: 30, percent: 16.7 }, undefined),
	{ used: 5, cap: 30, percent: (5 / 30) * 100 },
);
upsertTask({ hasUI: false }, "stage-test", { source: "delegate", label: "delegate", stage: "processing" });
assert.equal(taskDockTest.peekTask("stage-test")?.stage, "processing");
removeTask("stage-test");
upsertTask(
	{ hasUI: false },
	"clear-test",
	{ source: "delegate", label: "delegate", state: "done", tokens: { input: 10, output: 2 }, cost: 0.5, costEstimated: true },
);
upsertTask({ hasUI: false }, "clear-test", { source: "delegate", tokens: null, cost: null });
assert.equal(taskDockTest.peekTask("clear-test")?.tokens, undefined);
assert.equal(taskDockTest.peekTask("clear-test")?.cost, undefined);
removeTask("clear-test");
assert.equal(
	taskDockTest.estimateCost(
		{
			modelRegistry: {
				find: () => ({ cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 6 } }),
			},
		},
		"custom/test-model",
		{ input: 1_000_000, output: 2_000_000, cacheRead: 3_000_000, cacheWrite: 4_000_000 },
	),
	57.9,
);
assert.equal(
	taskDockTest.estimateCost(
		{ modelRegistry: { find: () => ({ cost: { input: 3, output: 15 } }) } },
		"breeze/claude-sonnet-5",
		{ input: 1_000_000, output: 2_000_000 },
	),
	33,
);
assert.equal(
	taskDockTest.estimateCost(
		{
			modelRegistry: {
				find: (provider, id) =>
					provider === "qgenie" && id === "anthropic::claude-5-sonnet"
						? { cost: { input: 1.68, output: 8.4 } }
						: undefined,
			},
		},
		"qgenie/anthropic::claude-5-sonnet",
		{ input: 1_000_000, output: 2_000_000 },
	),
	18.48,
);
assert.equal(taskDockTest.formatTokenUsage({ input: 1_200, output: 34 }), "↑1.2k ↓34 tok");
assert.equal(taskDockTest.formatCost(0.1234, true), "~$0.1234");
assert.equal(taskDockTest.formatCost(undefined), "cost n/a");
const unregisterProvider = registerTaskDockProvider(() => []);
assert.equal(taskDockTest.hasExternalProviders(), true);
unregisterProvider();
assert.equal(taskDockTest.hasExternalProviders(), false);
const finalized = new Set();
for (let i = 0; i < 300; i++) taskDockTest.rememberFinalized(finalized, `task-${i}`);
assert.equal(finalized.size, 256);
assert.equal(finalized.has("task-0"), false);
assert.equal(finalized.has("task-299"), true);

const theme = { fg: (_color, text) => text };
const row = taskDockTest.renderRow({
	id: "cost-row",
	source: "delegate",
	label: "worker",
	state: "done",
	startedAt: Date.now(),
	tokens: { input: 1_200, output: 34 },
	cost: 0.1234,
	costEstimated: true,
}, theme, 200);
assert.match(row, /↑1\.2k ↓34 tok/);
assert.match(row, /~\$0\.1234/);

const narrowRow = taskDockTest.renderRow({
	id: "narrow-row",
	source: "subagent",
	label: "very-long-investigator-name",
	state: "running",
	startedAt: Date.now(),
	detail: "Investigate the symlinked project agent directory regression",
	model: "qgenie/anthropic::claude-5-sonnet",
	tokens: { input: 123_456, output: 7_890 },
	cost: 0.1234,
}, theme, 72);
assert.ok(visibleWidth(narrowRow) <= 72, `row exceeds width: ${narrowRow}`);
assert.match(narrowRow, /Investigate/);
