// Contract tests for task-dock state mapping. Each mapping mirrors the
// authoritative status enum of its source; the dock must not show a user
// cancellation as a failure, and must not invent a state the source never emits.
import assert from "node:assert/strict";
import { __test as taskDockTest } from "../extensions/task-dock.ts";

const { bgStateFor, delegateStateFor, icon } = taskDockTest;

// pi-background-tasks TaskStatus: running | completed | failed | killed
assert.equal(bgStateFor("running"), "running");
assert.equal(bgStateFor("completed"), "done");
assert.equal(bgStateFor("failed"), "error");
// A user kill is a cancellation, not a failure.
assert.equal(bgStateFor("killed"), "cancelled");

// billion-context-pi RunStatus: queued | running | completed | failed | cancelled
assert.equal(delegateStateFor("queued"), "waiting", "queued waits for a slot; it is not running");
assert.equal(delegateStateFor("running"), "running");
assert.equal(delegateStateFor("completed"), "done");
assert.equal(delegateStateFor("failed"), "error");
assert.equal(delegateStateFor("cancelled"), "cancelled");

// Terminal states must never be reported as "waiting": that state is reserved
// for queued delegate runs and paused workflows, which are not terminal.
for (const status of ["completed", "failed", "killed"]) {
  assert.notEqual(bgStateFor(status), "waiting", `bg ${status} must not be waiting`);
}
for (const status of ["completed", "failed", "cancelled"]) {
  assert.notEqual(delegateStateFor(status), "waiting", `delegate ${status} must not be waiting`);
}

// cancelled gets its own glyph so it is visually distinct from both success and failure.
assert.equal(icon({ state: "cancelled", startedAt: 0 }), "⊘");
assert.notEqual(icon({ state: "cancelled", startedAt: 0 }), icon({ state: "error", startedAt: 0 }));
assert.notEqual(icon({ state: "cancelled", startedAt: 0 }), icon({ state: "done", startedAt: 0 }));

console.log("task dock state mapping contracts: ok");
