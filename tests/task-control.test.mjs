import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverAgents } from "../extensions/subagent/agents.ts";
import {
  isSafeTaskId,
  isTaskControlRequested,
  normalizeTaskControl,
  parseTaskPacket,
} from "../extensions/subagent/packet.ts";
import {
  acquireTakeover,
  activeTakeoverForCwd,
  changesSinceBaseline,
  createTaskState,
  markTakeoverReady,
  taskStatePath,
  isTaskPathAllowed,
  submitTakeover,
  updateTaskState,
} from "../extensions/subagent/task-state.ts";

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-task-control-"));
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-task-paths-"));
const cwd = process.cwd();
try {
  assert.equal(isSafeTaskId("task-123"), true);
  assert.equal(isSafeTaskId("../outside"), false);
  assert.equal(isSafeTaskId("C:\\\\outside"), false);
  assert.equal(isSafeTaskId("/tmp/outside"), false);
  assert.throws(() => taskStatePath("../outside", agentDir), /Invalid task id/);
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

  const invalidIdControl = normalizeTaskControl({
    taskId: "../outside",
    allowTakeover: true,
    allowedPaths: ["extensions/subagent"],
    acceptance: [{ command: "true" }],
  }, cwd);
  assert.equal(invalidIdControl.allowTakeover, false);

  const control = normalizeTaskControl({
    taskId: "task-123",
    allowTakeover: true,
    allowedPaths: ["extensions/subagent"],
    acceptance: [{ command: "true" }],
  }, cwd);
  assert.equal(control.allowTakeover, true);
  assert.deepEqual(
    changesSinceBaseline(["legacy.txt", "new.txt"], ["legacy.txt"]),
    ["new.txt"],
  );

  const allowedDir = path.join(fixtureDir, "allowed");
  const outsideDir = path.join(fixtureDir, "outside");
  fs.mkdirSync(allowedDir);
  fs.mkdirSync(outsideDir);
  fs.writeFileSync(path.join(outsideDir, "secret.txt"), "secret");
  const pathState = {
    cwd: fixtureDir,
    control: { allowedPaths: ["allowed"] },
  };
  assert.equal(isTaskPathAllowed(pathState, "allowed/new.txt"), true);
  fs.symlinkSync(path.join(outsideDir, "secret.txt"), path.join(allowedDir, "secret.txt"));
  fs.symlinkSync(outsideDir, path.join(allowedDir, "escape"), "dir");
  assert.equal(isTaskPathAllowed(pathState, "allowed/secret.txt"), false);
  assert.equal(isTaskPathAllowed(pathState, "allowed/escape/new.txt"), false);

  const projectTarget = path.join(fixtureDir, "project-agent-target");
  const projectConfig = path.join(fixtureDir, ".pi");
  fs.mkdirSync(projectTarget);
  fs.mkdirSync(projectConfig);
  fs.writeFileSync(
    path.join(projectTarget, "linked.md"),
    "---\nname: linked\ndescription: linked project agent\n---\nUse the linked project agent.\n",
  );
  fs.symlinkSync(projectTarget, path.join(projectConfig, "agents"), "dir");
  const linkedAgents = discoverAgents(fixtureDir, "project");
  assert.equal(linkedAgents.projectAgentsDir, path.join(projectConfig, "agents"));
  assert.equal(linkedAgents.agents[0]?.name, "linked");

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

  const active = createTaskState("active worker", cwd, { ...control, taskId: "task-456" }, agentDir);
  markTakeoverReady(active.taskId, "worker failed", agentDir);
  acquireTakeover(active.taskId, "main", Date.now(), agentDir);
  fs.writeFileSync(path.join(agentDir, "subagent-tasks", "000-corrupt.json"), "{");
  assert.equal(activeTakeoverForCwd(cwd, agentDir)?.taskId, active.taskId);
  console.log("task control contract tests: ok");
} finally {
  fs.rmSync(agentDir, { recursive: true, force: true });
  fs.rmSync(fixtureDir, { recursive: true, force: true });
}
