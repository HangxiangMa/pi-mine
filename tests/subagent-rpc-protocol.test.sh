#!/usr/bin/env bash
# Regression: routed subagents run as `pi --mode rpc`, so the parent must (1) send the task
# as the first `prompt` record, (2) dismiss every extension dialog or the child blocks,
# (3) close stdin once `agent_settled` arrives so the child exits, and (4) deliver guidance
# to the live child as `steer` instead of relaunching it.
#
# Drives the real subagent_routed.execute and guideSubagentRun through pi's jiti. The child
# is tests/lib/fake-pi-rpc.cjs on PATH, so every protocol record is controlled and recorded.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
subagent="$here/../extensions/subagent/index.ts"

# shellcheck source=lib/pi-jiti.sh
source "$here/lib/pi-jiti.sh"
locate_pi_jiti || exit 1

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

# Re-export the real pi-coding-agent, overriding only getAgentDir (see subagent-cancel-status).
cat > "$tmp/shim.cjs" <<'SHIM'
const real = require(process.env.PI_CODING_AGENT_PKG);
module.exports = { ...real, getAgentDir: () => process.env.PI_ROUTER_TEST_DIR };
SHIM
export PI_ROUTER_TEST_DIR="$tmp"
export PI_CODING_AGENT_PKG

# A `pi` on PATH that runs the protocol fixture. getPiInvocation falls back to a bare `pi`
# when the process is not a script, so this is what the routed child executes.
mkdir -p "$tmp/bin"
cat > "$tmp/bin/pi" <<PI
#!/usr/bin/env bash
exec node "$here/lib/fake-pi-rpc.cjs" "\$@"
PI
chmod +x "$tmp/bin/pi"
export PATH="$tmp/bin:$PATH"

# The agent must resolve, or execute() returns "Unknown agent" before the path under test.
mkdir -p "$tmp/agents"
cp "$here/../../../agents/deep-reviewer.md" "$tmp/agents/deep-reviewer.md"

export PI_JITI PI_TUI PI_CODING_AGENT_PKG
export PI_SUBAGENT_SRC="$subagent"
export PI_TASK_DOCK_SRC="$here/../extensions/task-dock.ts"
export PI_SHIM="$tmp/shim.cjs"
export FAKE_PI_LOG="$tmp/child.log"
: > "$FAKE_PI_LOG"

node -e '
const fs = require("node:fs");
const jiti = require(process.env.PI_JITI)(process.cwd(), { interopDefault: true,
  alias: { "@earendil-works/pi-coding-agent": process.env.PI_SHIM, "@earendil-works/pi-tui": process.env.PI_TUI } });
const sub = jiti(process.env.PI_SUBAGENT_SRC);
const { __test: dockTest } = jiti(process.env.PI_TASK_DOCK_SRC);
const logPath = process.env.FAKE_PI_LOG;

let passed = 0;
function check(ok, label) {
  if (!ok) { console.error("FAIL " + label); process.exit(1); }
  passed++;
}
const records = () =>
  fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

const tools = {};
sub.default({
  registerTool: (t) => { tools[t.name] = t; },
  registerShortcut() {}, registerCommand() {}, on() {}, registerMessageRenderer() {},
  events: { on() {}, emit() {} },
});
const ctx = { cwd: process.cwd(), hasUI: true, sessionManager: {}, ui: {}, model: undefined, thinkingLevel: undefined };

(async () => {
  // 1-3. One routed run: task arrives as the first prompt, the dialog is dismissed, the
  // child settles, stdin is closed, and the child exits with the answer.
  const result = await tools.subagent_routed.execute(
    "rpc-1",
    { agent: "deep-reviewer", task: "review the widget" },
    undefined, undefined, ctx,
  );
  const text = (result.content?.[0]?.text) ?? "";
  const recs = records();

  const first = recs[0];
  check(first && first.type === "prompt", "the first stdin record is a prompt (got " + (first && first.type) + ")");
  check(first && String(first.message).includes("review the widget"), "the prompt carries the task text");
  check(!recs.some((r) => r.type === "prompt" && r !== first), "the task is sent once, not relaunched");

  check(recs.some((r) => r.type === "_dialog_answered" && r.cancelled === true),
    "the extension dialog is answered with cancelled:true, so the child does not block");
  check(recs.some((r) => r.type === "_stdin_end"), "stdin is closed after agent_settled, so the child exits");
  check(text.includes("FAKE-OK"), "the settled answer is returned (got " + JSON.stringify(text.slice(0, 80)) + ")");
  console.log("ok 1: prompt -> dialog cancelled -> settled -> stdin closed -> result");

  // 4. guidance reaches the LIVE child as steer, not as a second prompt (no relaunch).
  // The fixture holds the turn on its dialog until answered, so this run is still running
  // while guidance arrives: start it without awaiting, then steer it.
  fs.writeFileSync(logPath, "");
  const running = tools.subagent_routed.execute(
    "rpc-2",
    { agent: "deep-reviewer", task: "second task" },
    undefined, undefined, ctx,
  );
  const { subagentFleetSnapshot, guideSubagentRun, cancelSubagentRun } = sub;
  // Poll the fleet registry until this run is live and has a steer handle.
  let runId;
  for (let i = 0; i < 200 && !runId; i++) {
    const live = subagentFleetSnapshot().find((r) => r.status === "running" && String(r.task).includes("second task"));
    if (live) runId = live.id;
    else await new Promise((r) => setTimeout(r, 25));
  }
  check(runId, "the live run is registered in the fleet while it is running");
  const reply = await guideSubagentRun(runId, "focus on the error paths");
  check(String(reply).includes("queued"), "guidance on a running child reports it was queued (got " + reply + ")");
  await running;

  const steps = records();
  const prompts = steps.filter((r) => r.type === "prompt").length;
  const steers = steps.filter((r) => r.type === "steer");
  check(prompts === 1, "guidance does not relaunch: exactly one prompt (got " + prompts + ")");
  check(steers.length === 1 && String(steers[0].message).includes("focus on the error paths"),
    "guidance is delivered as one steer record to the live child");
  console.log("ok 2: guidance steers the live child, no relaunch");

  // 2b. A running child that has streamed a partial result must show as running in the dock,
  // not done. The child emits one assistant message and then keeps working (FAKE_PI_HOLD=partial).
  // The real onUpdate is required: without it the partial never reaches the dock and the check
  // would pass for the wrong reason.
  process.env.FAKE_PI_HOLD = "partial";
  const dockId = "hold-partial-1";
  const partialRun = tools.subagent_routed.execute(
    dockId,
    { agent: "deep-reviewer", task: "hold partial" },
    undefined, () => {}, ctx,
  );
  let holdRunId;
  for (let i = 0; i < 200 && !holdRunId; i++) {
    const live = subagentFleetSnapshot().find((r) => r.status === "running" && String(r.task).includes("hold partial"));
    if (live) holdRunId = live.id;
    else await new Promise((r) => setTimeout(r, 25));
  }
  check(holdRunId, "the partial-streaming run is registered while it is running");
  // Wait until the child has actually streamed its partial, so the dock has seen a result.
  await new Promise((r) => setTimeout(r, 800));
  const dockRow = dockTest.peekTask(`sub:${dockId}:0`);
  check(dockRow && dockRow.state === "running",
    "a running child with a partial result shows as running in the dock, not done (got " + (dockRow && dockRow.state) + ")");
  // End the run through the same path as dock k, so the await below completes.
  check(cancelSubagentRun(holdRunId), "the held run can be cancelled through the fleet");
  await partialRun;
  delete process.env.FAKE_PI_HOLD;
  console.log("ok 2b: a running child with a partial result shows as running");

  // 3. A pre-spawn throw with guidance queued. The child never starts, so the queued guidance
  // cannot be delivered; the thrown error must say how many messages were left undelivered,
  // and no prompt may reach a child.
  fs.writeFileSync(logPath, "");
  const doomedPromise = tools.subagent_routed.execute(
    "rpc-3",
    { agent: "deep-reviewer", task: "third task", runtimePolicy: { cwd: process.cwd(), isolation: "none", permissionMode: "default", mcpServers: ["no-such-server"] } },
    undefined, undefined, ctx,
  ).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e }));
  let doomedId;
  for (let i = 0; i < 2000 && !doomedId; i++) {
    const live = subagentFleetSnapshot().find((r) => r.status === "running" && String(r.task).includes("third task"));
    if (live) doomedId = live.id;
    else await new Promise((r) => setImmediate(r));
  }
  // Fail loudly if the run never registered: otherwise the guidance path is never exercised
  // and the test would pass vacuously.
  check(doomedId, "the pre-spawn run is registered before its setup throws");
  const queuedReply = await guideSubagentRun(doomedId, "queued before spawn");
  check(String(queuedReply).startsWith("Guidance queued"), "guidance is accepted while the run is still starting");
  const doomed = await doomedPromise;
  check(!doomed.ok, "the pre-spawn setup failure surfaces as a thrown error, not a result");
  const doomedMessage = String(doomed.e && doomed.e.message);
  check(doomedMessage.includes("MCP server configuration not found"), "the thrown error keeps the original setup cause");
  check(doomedMessage.includes("1 guidance message(s) were queued but not delivered"),
    "the thrown error names the undelivered guidance (got " + JSON.stringify(doomedMessage) + ")");
  check(!records().some((r) => r.type === "prompt"), "no child was spawned, so no prompt reached one");
  console.log("ok 3: pre-spawn failure names the undelivered guidance; no child spawned");


  console.log(passed + " passed, 0 failed");
})().catch((error) => { console.error("FAIL " + (error && error.stack || error)); process.exit(1); });
'
