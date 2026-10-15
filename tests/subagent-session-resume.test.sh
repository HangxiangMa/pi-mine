#!/usr/bin/env bash
# Regression: a routed subagent keeps its session so it can be resumed in place (Claude Code
# parity). It must (A) spawn with a stored session dir and id instead of --no-session,
# (B) record a terminal status and the run id, (C) refuse to resume a run the user cancelled,
# (D) reuse the same session id on resume, (E) refuse to resume a live run, and (F) keep only
# the 20 most recent finished sessions.
#
# Drives the real subagent_routed.execute through pi's jiti. The child is
# tests/lib/fake-pi-rpc.cjs. getAgentDir is shimmed to a temp dir, so no real session is touched.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
subagent="$here/../extensions/subagent/index.ts"
taskdock="$here/../extensions/task-dock.ts"

# shellcheck source=lib/pi-jiti.sh
source "$here/lib/pi-jiti.sh"
locate_pi_jiti || exit 1

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

cat > "$tmp/shim.cjs" <<'SHIM'
const real = require(process.env.PI_CODING_AGENT_PKG);
module.exports = { ...real, getAgentDir: () => process.env.PI_ROUTER_TEST_DIR };
SHIM
export PI_ROUTER_TEST_DIR="$tmp"
export PI_CODING_AGENT_PKG

mkdir -p "$tmp/bin"
cat > "$tmp/bin/pi" <<PI
#!/usr/bin/env bash
exec node "$here/lib/fake-pi-rpc.cjs" "\$@"
PI
chmod +x "$tmp/bin/pi"
export PATH="$tmp/bin:$PATH"

mkdir -p "$tmp/agents"
cp "$here/../../../agents/deep-reviewer.md" "$tmp/agents/deep-reviewer.md"

export PI_JITI PI_TUI PI_CODING_AGENT_PKG
export PI_SUBAGENT_SRC="$subagent"
export PI_TASK_DOCK_SRC="$taskdock"
export PI_SHIM="$tmp/shim.cjs"
export FAKE_PI_LOG="$tmp/child.log"
export FAKE_PI_ARGV_LOG="$tmp/child-argv.log"
: > "$FAKE_PI_LOG"
: > "$FAKE_PI_ARGV_LOG"

node -e '
const fs = require("node:fs");
const path = require("node:path");
const jiti = require(process.env.PI_JITI)(process.cwd(), { interopDefault: true,
  alias: { "@earendil-works/pi-coding-agent": process.env.PI_SHIM, "@earendil-works/pi-tui": process.env.PI_TUI } });
const sub = jiti(process.env.PI_SUBAGENT_SRC);
const store = jiti(path.join(path.dirname(process.env.PI_SUBAGENT_SRC), "session-store.ts"));

let passed = 0;
function check(ok, label) {
  if (!ok) { console.error("FAIL " + label); process.exit(1); }
  console.log("ok " + label);
  passed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tools = {};
sub.default({
  registerTool: (t) => { tools[t.name] = t; },
  registerShortcut() {}, registerCommand() {}, on() {}, registerMessageRenderer() {},
  events: { on() {}, emit() {} },
  sendUserMessage() { return Promise.resolve(); },
});
const ctx = { cwd: process.cwd(), hasUI: true, sessionManager: {}, ui: {}, model: undefined, thinkingLevel: undefined };
const { subagentFleetSnapshot, cancelSubagentRun } = sub;
const sessionDir = path.join(process.env.PI_ROUTER_TEST_DIR, "subagent-sessions");

// Read the argv the most recent child was spawned with.
const argvRecords = () => {
  const text = fs.readFileSync(process.env.FAKE_PI_ARGV_LOG, "utf8").trim();
  return text ? text.split("\n").map((l) => JSON.parse(l).argv) : [];
};
const lastArgv = () => argvRecords().pop();
const sessionIdFlag = (argv) => argv[argv.indexOf("--session-id") + 1];
// Count child spawns from the argv records. A refused call must leave this unchanged.
const spawnCount = () => argvRecords().length;

(async () => {
  // A. A fresh run persists its session: --session-dir and --session-id, never --no-session.
  const fresh = await tools.subagent_routed.execute(
    "res-a", { agent: "deep-reviewer", task: "first task", run_in_background: false }, undefined, undefined, ctx,
  );
  check(fresh && !fresh.isError, "the fresh run completes (got " + JSON.stringify(String(fresh.content[0].text).slice(0, 80)) + ")");
  const argvA = lastArgv();
  check(argvA && argvA.includes("--session-dir") && argvA.includes("--session-id"),
    "a fresh run spawns with --session-dir and --session-id (got " + JSON.stringify(argvA) + ")");
  check(argvA && !argvA.includes("--no-session"),
    "a fresh run never spawns with --no-session (got " + JSON.stringify(argvA) + ")");
  check(argvA && argvA[argvA.indexOf("--session-dir") + 1] === sessionDir,
    "the session dir is the subagent-sessions directory under the agent dir");
  const sessionIdA = sessionIdFlag(argvA);
  check(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(sessionIdA),
    "the session id satisfies pi session id rules (got " + sessionIdA + ")");

  // B. The finished run records a terminal status with its run id, key and agent.
  const found = fs.readdirSync(sessionDir).filter((f) => f.endsWith(".state.json"));
  check(found.length === 1, "one state file is written for the finished run (got " + found.length + ")");
  const rec = JSON.parse(fs.readFileSync(path.join(sessionDir, found[0]), "utf8"));
  check(rec.status === "done", "a successful run is recorded done (got " + rec.status + ")");
  check(rec.agent === "deep-reviewer", "the record names the agent (got " + rec.agent + ")");
  check(typeof rec.runId === "string" && rec.runId.length > 0, "the record names the fleet run id");
  check(store.sessionIdForRun(rec.sessionKey) === sessionIdA,
    "the stored key maps to the same session id that was spawned");

  // D. A resume of a finished run reuses the same session id. The fresh run is finished, so it
  // may resume. Negative: a resume that mints a new id would fail here.
  const beforeD = spawnCount();
  const resumed = await tools.subagent_routed.execute(
    "res-d", { resume_run: rec.runId, task: "second task", run_in_background: false }, undefined, undefined, ctx,
  );
  check(!resumed.isError, "a finished run can be resumed (got " + JSON.stringify(String(resumed.content[0].text).slice(0, 120)) + ")");
  check(spawnCount() === beforeD + 1, "a resume spawns exactly one child (spawns " + beforeD + " -> " + spawnCount() + ")");
  const argvD = lastArgv();
  check(sessionIdFlag(argvD) === sessionIdA,
    "resume reopens the same session id (fresh " + sessionIdA + ", resumed " + sessionIdFlag(argvD) + ")");

  // D2. Resuming twice with the ORIGINAL run id must still find the stored run. A resume
  // overwrites the record with the new fleet run id, so the first run id may stop resolving.
  // The planner round-trip needs a second resume, so this is checked for real, not assumed.
  const beforeD2 = spawnCount();
  const resumedAgain = await tools.subagent_routed.execute(
    "res-d2", { resume_run: rec.runId, task: "third task", run_in_background: false }, undefined, undefined, ctx,
  );
  const spawnedD2 = spawnCount() === beforeD2 + 1;
  check(spawnedD2 && !resumedAgain.isError,
    "a second resume with the original run id spawns a child (spawns " + beforeD2 + " -> " + spawnCount() + ", error " + String(resumedAgain.isError) + ")");

  // C. A user-cancelled run is never resumed. The state file is written by the cancel path, so
  // create one directly and confirm the resume is refused with no spawn.
  const cancelledRunId = "cancelled-run:0:deadbeef";
  const cancelledId = store.sessionIdForRun("cancelled-key");
  store.recordSessionStatus(sessionDir, cancelledId, {
    status: "cancelled", at: Date.now(), runId: cancelledRunId, sessionKey: "cancelled-key", agent: "deep-reviewer",
  });
  const beforeC = spawnCount();
  const refusedC = await tools.subagent_routed.execute(
    "res-c", { resume_run: cancelledRunId, task: "more" }, undefined, undefined, ctx,
  );
  const afterC = spawnCount();
  check(refusedC.isError === true, "resuming a user-cancelled run is refused");
  check(String(refusedC.content[0].text).includes("stopped by the user and was not resumed"),
    "the refusal says the run was stopped by the user and not resumed");
  check(afterC === beforeC, "a refused resume spawns no child (spawns " + beforeC + " -> " + afterC + ")");

  // E. A live run is refused. Hold the child so the run stays registered as live.
  process.env.FAKE_PI_HOLD = "1";
  const liveReceipt = await tools.subagent_routed.execute(
    "res-e-live", { agent: "deep-reviewer", task: "hold open" }, undefined, undefined, ctx,
  );
  check(!liveReceipt.isError, "the live run starts in the background");
  await sleep(200);
  const liveRun = subagentFleetSnapshot().find((r) => r.status === "running" && String(r.task).includes("hold open"));
  check(liveRun, "the live run is registered in the fleet");
  const refusedE = await tools.subagent_routed.execute(
    "res-e", { resume_run: liveRun.id, task: "again" }, undefined, undefined, ctx,
  );
  check(refusedE.isError === true && String(refusedE.content[0].text).includes("still running"),
    "resuming a live run is refused with the running text (got " + JSON.stringify(String(refusedE.content[0].text).slice(0, 80)) + ")");
  cancelSubagentRun(liveRun.id);
  delete process.env.FAKE_PI_HOLD;
  for (let i = 0; i < 100; i++) {
    if (!subagentFleetSnapshot().some((r) => r.id === liveRun.id && r.status === "running")) break;
    await sleep(50);
  }

  // F. Pruning keeps only the 20 most recent finished sessions. Create 22 finished records with
  // increasing timestamps and confirm the two oldest are removed.
  const pruneDir = path.join(process.env.PI_ROUTER_TEST_DIR, "prune-check");
  for (let i = 0; i < 22; i++) {
    store.recordSessionStatus(pruneDir, "p-" + String(i).padStart(2, "0"), {
      status: "done", at: 1000 + i, runId: "r" + i, sessionKey: "k" + i, agent: "a",
    });
  }
  const removed = store.pruneFinishedSessions(pruneDir);
  const left = fs.readdirSync(pruneDir).filter((f) => f.endsWith(".state.json")).length;
  check(left === store.RETAINED_FINISHED_RUNS, "exactly " + store.RETAINED_FINISHED_RUNS + " finished sessions remain (got " + left + ")");
  check(removed.length === 2 && removed.includes("p-00") && removed.includes("p-01"),
    "the two oldest finished sessions are the ones pruned (removed " + JSON.stringify(removed) + ")");
  store.recordSessionStatus(pruneDir, "p-running", { status: "running", at: 1, runId: "rr", sessionKey: "rk", agent: "a" });
  store.pruneFinishedSessions(pruneDir, 0);
  check(fs.existsSync(path.join(pruneDir, "p-running.state.json")),
    "a running session is never pruned, even when the cap is zero");

  // G. Liveness is decided by a running record and a live owning process. A real live pid
  // (this process) and a real dead pid (a child that has exited) test the rule with no mocks.
  const { spawnSync } = require("node:child_process");
  const exited = spawnSync(process.execPath, ["-e", ""]);
  const deadPid = exited.pid;
  check(store.ownerAlive(process.pid) === true, "the owning process is alive while it runs");
  check(store.ownerAlive(deadPid) === false, "a process that has exited is not alive (pid " + deadPid + ")");
  check(store.ownerAlive(undefined) === false, "a record with no owner pid is not alive");
  const runningLive = { status: "running", at: 1, runId: "g1", sessionKey: "gk", agent: "a", pid: process.pid };
  const runningDead = { ...runningLive, pid: deadPid };
  const doneLive = { ...runningLive, status: "done" };
  check(store.isRunLive(runningLive) === true, "a running record owned by a live process is live");
  check(store.isRunLive(runningDead) === false,
    "a running record whose owner exited is NOT live, so it can be resumed after pi died");
  check(store.isRunLive(doneLive) === false, "a finished record is never live, even if its owner is alive");

  console.log(passed + " passed, 0 failed");
})().catch((error) => { console.error("FAIL " + (error && error.stack || error)); process.exit(1); });
'
