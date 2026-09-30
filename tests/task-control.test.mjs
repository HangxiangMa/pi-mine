import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isTaskControlRequested,
  normalizeTaskControl,
  parseTaskPacket,
} from "../extensions/subagent/packet.ts";
import {
  acquireTakeover,
  createTaskState,
  markTakeoverReady,
  submitTakeover,
  updateTaskState,
} from "../extensions/subagent/task-state.ts";

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-task-control-"));
const cwd = process.cwd();
try {
  assert.equal(isTaskControlRequested(undefined), false);
  assert.equal(isTaskControlRequested({
    allowTakeover: false,
    allowedPaths: [],
    acceptance: [],
  }), false);
  assert.equal(isTaskControlRequested({
    allowTakeover: true,
    allowedPaths: [],
    acceptance: [],
  }), true);

  const rejected = normalizeTaskControl({
    allowTakeover: true,
    allowedPaths: ["../outside"],
    acceptance: [{ command: "true" }],
  }, cwd);
  assert.equal(rejected.allowTakeover, false);
  assert.deepEqual(rejected.allowedPaths, []);

  const control = normalizeTaskControl({
    allowTakeover: true,
    allowedPaths: ["extensions/subagent"],
    acceptance: [{ command: "true" }],
  }, cwd);
  assert.equal(control.allowTakeover, true);

  const packet = parseTaskPacket(`

after:
\`\`\`task-packet
${JSON.stringify({
    version: 1,
    goal: "repair the worker",
    control,
    scope: ["extensions/subagent"],
    constraints: [],
    evidence: [],
    steps: [{ id: "1", action: "repair", files: ["extensions/subagent"] }],
    tests: ["true"],
    risks: [],
    unknowns: [],
    coverage: "packet test",
  })}
\`\`\`
`);
  assert.equal(packet.control.allowTakeover, true);

  let state = createTaskState("repair the worker", cwd, control, agentDir);
  assert.equal(state.revision, 1);
  state = updateTaskState(state.taskId, (current) => ({ ...current, goal: "repair worker safely" }), agentDir, 1);
  assert.equal(state.revision, 2);
  assert.throws(() => updateTaskState(state.taskId, (current) => current, agentDir, 1), /Stale task revision/);

  state = markTakeoverReady(state.taskId, "worker failed twice", agentDir);
  assert.equal(state.status, "takeover-ready");
  state = acquireTakeover(state.taskId, "main", Date.now(), agentDir);
  assert.equal(state.status, "lead-writing");
  assert.throws(() => acquireTakeover(state.taskId, "other", Date.now(), agentDir), /not takeover-ready|active writer/);
  state = submitTakeover(state.taskId, "main", "fail", "check failed", agentDir);
  assert.equal(state.status, "takeover-ready");
  state = acquireTakeover(state.taskId, "main", Date.now(), agentDir);
  state = submitTakeover(state.taskId, "main", "pass", "checks passed", agentDir);
  assert.equal(state.status, "done");
  console.log("task control contract tests: ok");
} finally {
  fs.rmSync(agentDir, { recursive: true, force: true });
}
