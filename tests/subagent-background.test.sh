#!/usr/bin/env bash
# Regression: a single subagent_routed run is background by default (Claude Code 2.1.286).
# It must (1) return a receipt before the child settles, (2) keep its dock row running until
# the child finishes, (3) deliver the result as a steering message (mid-turn) with
# expandPromptTemplates off, (4) report a cancel as cancelled, and (5) reject run_in_background:true with chain/tasks.
#
# Drives the real subagent_routed.execute through pi's jiti. The child is
# tests/lib/fake-pi-rpc.cjs; FAKE_PI_HOLD=1 keeps it running until cancelled.
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
: > "$FAKE_PI_LOG"

node -e '
const fs = require("node:fs");
const jiti = require(process.env.PI_JITI)(process.cwd(), { interopDefault: true,
  alias: { "@earendil-works/pi-coding-agent": process.env.PI_SHIM, "@earendil-works/pi-tui": process.env.PI_TUI } });
const sub = jiti(process.env.PI_SUBAGENT_SRC);
const { __test: dockTest } = jiti(process.env.PI_TASK_DOCK_SRC);

let passed = 0;
function check(ok, label) {
  if (!ok) { console.error("FAIL " + label); process.exit(1); }
  console.log("ok " + label);
  passed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Capture the messages the background run delivers to the main session (steer, mid-turn).
const followUps = [];
const tools = {};
sub.default({
  registerTool: (t) => { tools[t.name] = t; },
  registerShortcut() {}, registerCommand() {}, on() {}, registerMessageRenderer() {},
  events: { on() {}, emit() {} },
  sendUserMessage(content, options) { followUps.push({ content, options }); return Promise.resolve(); },
});
const ctx = { cwd: process.cwd(), hasUI: true, sessionManager: {}, ui: {}, model: undefined, thinkingLevel: undefined };
const { subagentFleetSnapshot, cancelSubagentRun } = sub;

(async () => {
  // 1. The receipt returns while the child is still running. FAKE_PI_HOLD=1 never settles,
  // so any return before cancellation proves the run was not awaited.
  process.env.FAKE_PI_HOLD = "1";
  const started = Date.now();
  const receipt = await tools.subagent_routed.execute(
    "bg-1", { agent: "deep-reviewer", task: "background task one" }, undefined, undefined, ctx,
  );
  const elapsed = Date.now() - started;
  check(elapsed < 5000, "the receipt returns at once, not after the child settles (took " + elapsed + "ms)");
  check(receipt.details && receipt.details.background === true,
    "the receipt is marked background so the router keeps the dock row running");
  check(String(receipt.content[0].text).includes("Background subagent started"),
    "the receipt says the subagent started in the background");
  check(String(receipt.content[0].text).includes("may write files"),
    "the receipt warns that a background run may write while the main session works");

  // 2. The dock row stays running after the receipt, because no terminal state was published.
  const liveRow = dockTest.peekTask("sub:bg-1:0");
  check(liveRow && liveRow.state === "running",
    "the dock row is running at receipt time (got " + (liveRow && liveRow.state) + ")");
  check(followUps.length === 0, "no follow-up is delivered while the run is still going");

  // 3. Cancelling through the fleet ends the run: the row becomes cancelled and the follow-up
  // says so instead of reporting a failure.
  const bgRun = subagentFleetSnapshot().find((r) => r.status === "running" && String(r.task).includes("background task one"));
  check(bgRun, "the background run is registered in the fleet so dock k can reach it");
  check(cancelSubagentRun(bgRun.id), "the background run can be cancelled through the fleet");
  for (let i = 0; i < 100 && followUps.length === 0; i++) await sleep(50);
  check(followUps.length === 1, "exactly one follow-up is delivered on completion (got " + followUps.length + ")");
  const fu = followUps[0];
  check(fu.options && fu.options.deliverAs === "steer",
    "the result is delivered mid-turn as steer, not after the turn as followUp (got " + JSON.stringify(fu.options) + ")");
  check(fu.options && fu.options.expandPromptTemplates === false,
    "the follow-up does not expand prompt templates, so result text is never run as a command");
  check(String(fu.content).includes("was cancelled"),
    "a user cancel is reported as cancelled, not as a failure (got " + JSON.stringify(String(fu.content).slice(0, 80)) + ")");
  check(!String(fu.content).includes("failed"), "a cancel is not described as a failure");
  check(dockTest.peekTask("sub:bg-1:0")?.state === "cancelled",
    "the dock row ends cancelled (got " + (dockTest.peekTask("sub:bg-1:0")?.state) + ")");
  delete process.env.FAKE_PI_HOLD;

  // 3b. A run that completes normally delivers its real answer and ends done. Without this,
  // the success path (the core promise: the result reaches the main session) is never asserted.
  followUps.length = 0;
  const okReceipt = await tools.subagent_routed.execute(
    "bg-ok", { agent: "deep-reviewer", task: "background task two" }, undefined, undefined, ctx,
  );
  check(okReceipt.details && okReceipt.details.background === true, "the second run also returns a background receipt");
  for (let i = 0; i < 200 && followUps.length === 0; i++) await sleep(50);
  check(followUps.length === 1, "a completed run delivers exactly one follow-up (got " + followUps.length + ")");
  const okText = String(followUps[0] && followUps[0].content);
  check(okText.includes("finished") && okText.includes("FAKE-OK"),
    "the follow-up carries the real answer of the child (got " + JSON.stringify(okText.slice(0, 120)) + ")");
  check(followUps[0].options && followUps[0].options.expandPromptTemplates === false,
    "a completed result is also delivered without template expansion");
  check(dockTest.peekTask("sub:bg-ok:0")?.state === "done",
    "the dock row ends done after a normal completion (got " + (dockTest.peekTask("sub:bg-ok:0")?.state) + ")");

  // 4. chain and parallel tasks reject an explicit run_in_background:true. They never background.
  const chainRejected = await tools.subagent_routed.execute(
    "bg-chain", { chain: [{ agent: "deep-reviewer", task: "a" }], run_in_background: true }, undefined, undefined, ctx,
  );
  check(chainRejected.isError === true && String(chainRejected.content[0].text).includes("single mode only"),
    "chain with run_in_background true is rejected (got " + JSON.stringify(String(chainRejected.content[0].text).slice(0, 80)) + ")");
  const tasksRejected = await tools.subagent_routed.execute(
    "bg-tasks", { tasks: [{ agent: "deep-reviewer", task: "a" }], run_in_background: true }, undefined, undefined, ctx,
  );
  check(tasksRejected.isError === true && String(tasksRejected.content[0].text).includes("single mode only"),
    "parallel tasks with run_in_background true is rejected");

  // 5. A controlled run (control present) never backgrounds. Explicit true with control is
  // rejected rather than silently run in the foreground, so the caller is not misled.
  const controlRejected = await tools.subagent_routed.execute(
    "bg-control",
    { agent: "deep-reviewer", task: "c", run_in_background: true, control: { allowedPaths: ["x"], acceptance: ["y"], allowTakeover: true } },
    undefined, undefined, ctx,
  );
  check(controlRejected.isError === true && String(controlRejected.content[0].text).includes("single mode only"),
    "explicit run_in_background true with control is rejected (got " + JSON.stringify(String(controlRejected.content[0].text).slice(0, 80)) + ")");

  console.log(passed + " passed, 0 failed");
})().catch((error) => { console.error("FAIL " + (error && error.stack || error)); process.exit(1); });
'
