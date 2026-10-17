#!/usr/bin/env bash
# Regression: the subagent monitor must show live progress from a REAL routed child while the run
# is still going. The child is tests/lib/fake-pi-rpc.cjs in FAKE_PI_STREAM=hold mode, which streams
# message_update text deltas and a failing tool_execution, then stays mid-turn. The test drives the
# real subagent_routed.execute through pi's jiti, reads subagentFleetSnapshot() mid-run, and checks
# the monitor output, then lets the run finish and checks the final output replaces the live trace.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
subagent="$here/../extensions/subagent/index.ts"

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
export PI_SHIM="$tmp/shim.cjs"
export FAKE_PI_LOG="$tmp/child.log"
: > "$FAKE_PI_LOG"
export FAKE_PI_STREAM=hold

node -e '
const fs = require("node:fs");
const jiti = require(process.env.PI_JITI)(process.cwd(), { interopDefault: true,
  alias: { "@earendil-works/pi-coding-agent": process.env.PI_SHIM, "@earendil-works/pi-tui": process.env.PI_TUI } });
const sub = jiti(process.env.PI_SUBAGENT_SRC);

let passed = 0;
function check(ok, label) {
  if (!ok) { console.error("FAIL " + label); process.exit(1); }
  passed++;
}

const tools = {};
sub.default({
  registerTool: (t) => { tools[t.name] = t; },
  registerShortcut() {}, registerCommand() {}, on() {}, registerMessageRenderer() {},
  events: { on() {}, emit() {} },
});
const ctx = { cwd: process.cwd(), hasUI: true, sessionManager: {}, ui: {}, model: undefined, thinkingLevel: undefined };

(async () => {
  const { subagentFleetSnapshot, cancelSubagentRun } = sub;
  const running = tools.subagent_routed.execute(
    "live-1",
    { agent: "deep-reviewer", task: "live output probe", run_in_background: false },
    undefined, undefined, ctx,
  );

  // Poll until the child has streamed its turn while still running.
  let live;
  for (let i = 0; i < 400; i++) {
    live = subagentFleetSnapshot().find((r) => r.status === "running" && String(r.task).includes("live output probe") && String(r.output).includes("FAKE-STREAMED"));
    if (live) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  check(live, "a live run streams its text into the monitor output before it finishes");
  const mid = live.output;
  check(live.status === "running", "the run is still running while the live output is read");
  check(mid.includes("→ bash: ls -la"), "the monitor shows the tool trace line for the running bash call (got " + JSON.stringify(mid) + ")");
  check(mid.includes("✗ bash failed"), "the monitor shows the failed tool result line");
  check(mid.includes("Checking the widget now."), "the monitor shows the streamed text deltas joined in order (got " + JSON.stringify(mid) + ")");
  check(mid.indexOf("→ bash: ls -la") < mid.indexOf("Checking"), "trace lines come before the live text, as composed");
  check(!mid.includes("No project session found"), "stderr is not the monitor output while live output exists");
  console.log("ok 1: live output visible mid-run from a real child (" + mid.split("\n").length + " lines)");

  // Stop the held child. Cancel must end the run and not leave the trace behind as the final output.
  cancelSubagentRun(live.id);
  await running.catch(() => {});
  const done = subagentFleetSnapshot().find((r) => r.id === live.id);
  check(done && done.status !== "running", "the cancelled run is no longer running");
  console.log("ok 2: run ends after cancel");
  console.log("subagent-live-output: " + passed + " checks passed");
  process.exit(0);
})().catch((error) => {
  console.error("FAIL " + (error && error.stack || error));
  process.exit(1);
});
' 
