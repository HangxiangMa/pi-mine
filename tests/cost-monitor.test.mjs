import assert from "node:assert/strict";
import { __test } from "../extensions/cost-monitor.ts";
import { __test as taskDockTest } from "../extensions/task-dock.ts";

assert.deepEqual(__test.usage(25, 100), { used: 25, cap: 100, percent: 25 });
assert.equal(__test.usage("25", 100), undefined);
assert.equal(
	__test
		.render({ aicp: { used: 12.5, cap: 50, percent: 25 }, breeze: undefined })
		.replace(/\x1b\[[0-9;]*m/g, ""),
	"AICP: 12.50/50.00 (25%) | Breeze unavailable | ",
);
assert.equal(
	taskDockTest.estimateCost(
		{ modelRegistry: { find: () => ({ cost: { input: 3, output: 15 } }) } },
		"breeze/claude-sonnet-5",
		{ input: 1_000_000, output: 2_000_000 },
	),
	33,
);
assert.equal(taskDockTest.formatCost(0.1234, true), "~$0.1234");
