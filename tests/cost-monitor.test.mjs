import assert from "node:assert/strict";
import { __test } from "../extensions/cost-monitor.ts";
import { __test as taskDockTest, removeTask, upsertTask } from "../extensions/task-dock.ts";

assert.deepEqual(__test.usage(25, 100), { used: 25, cap: 100, percent: 25 });
assert.equal(__test.usage("25", 100), undefined);
assert.equal(
	__test
		.render({
			aicp: { used: 59.38, cap: 150, percent: (59.38 / 150) * 100 },
			breeze: undefined,
		})
		.replace(/\x1b\[[0-9;]*m/g, ""),
	"AICP: 59.38/150.00 (40%) | Breeze unavailable | ",
);
assert.deepEqual(__test.usage(30.06, 100), { used: 30.06, cap: 100, percent: 30.06 });
upsertTask({ hasUI: false }, "stage-test", { source: "delegate", label: "delegate", stage: "processing" });
assert.equal(taskDockTest.peekTask("stage-test")?.stage, "processing");
removeTask("stage-test");
assert.equal(
	taskDockTest.estimateCost(
		{ modelRegistry: { find: () => ({ cost: { input: 3, output: 15 } }) } },
		"custom/test-model",
		{ input: 1_000_000, output: 2_000_000 },
	),
	33,
);
assert.equal(
	taskDockTest.estimateCost(
		{ modelRegistry: { find: () => ({ cost: { input: 3, output: 15 } }) } },
		"breeze/claude-sonnet-5",
		{ input: 1_000_000, output: 2_000_000 },
	),
	18.48,
);
assert.equal(taskDockTest.formatTokenUsage({ input: 1_200, output: 34 }), "↑1.2k ↓34 tok");
assert.equal(taskDockTest.formatCost(0.1234, true), "~$0.1234");
assert.equal(taskDockTest.formatCost(undefined), "cost n/a");

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
