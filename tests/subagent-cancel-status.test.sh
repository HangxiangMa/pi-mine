#!/usr/bin/env bash
# Regression: a user-cancelled subagent must show as cancelled in the task dock, not
# error, and its row must not be left behind.
#
# Loads the real subagent/index.ts and task-dock.ts through pi's jiti (node cannot
# strip the TypeScript parameter properties in subagent/index.ts), then drives the
# real publishRoutedStatus() and upsertTask() with the result a cancel produces.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
subagent="$here/../extensions/subagent/index.ts"
taskdock="$here/../extensions/task-dock.ts"

# shellcheck source=lib/pi-jiti.sh
source "$here/lib/pi-jiti.sh"
locate_pi_jiti || exit 1

# The shim re-exports the real pi-coding-agent (every runtime name the subagent
# modules import, e.g. parseFrontmatter) and overrides only getAgentDir, so discovery
# reads a temp dir and never the real user config. A hand-written stub missing one
# name would let execute() fail before the path under test.
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/shim.cjs" <<'SHIM'
const real = require(process.env.PI_CODING_AGENT_PKG);
module.exports = { ...real, getAgentDir: () => process.env.PI_ROUTER_TEST_DIR };
SHIM
export PI_ROUTER_TEST_DIR="$tmp"
export PI_CODING_AGENT_PKG
export PI_SHIM="$tmp/shim.cjs"
export PI_SUBAGENT_SRC="$subagent"
export PI_TASK_DOCK_SRC="$taskdock"

# The end-to-end case needs a real agent to resolve, or execute() returns "Unknown agent"
# before it reaches the path under test. Copy the real definition (not a hand-written
# stub) from the parent repo, the same way subagent-router.test.sh reaches pi/agents.
mkdir -p "$tmp/agents"
cp "$here/../../../agents/deep-reviewer.md" "$tmp/agents/deep-reviewer.md"

node -e '
const jiti = require(process.env.PI_JITI)(process.cwd(), { interopDefault: true,
  alias: { "@earendil-works/pi-coding-agent": process.env.PI_SHIM, "@earendil-works/pi-tui": process.env.PI_TUI } });
const sub = jiti(process.env.PI_SUBAGENT_SRC);
const dock = jiti(process.env.PI_TASK_DOCK_SRC);
const { publishRoutedStatus, isFailedResult } = sub.__test;
const { __test: dockTest } = dock;

let passed = 0;
function check(ok, label) {
  if (!ok) { console.error("FAIL " + label); process.exit(1); }
  passed++;
}

// A result shaped like runSingleAgent produces for a user cancel: exitCode 130
// and errorMessage "Subagent was cancelled" (see subagent/index.ts runSingleAgent).
function cancelledResult() {
  return {
    agent: "deep-reviewer", task: "t", exitCode: 130, errorMessage: "Subagent was cancelled",
    stopReason: "aborted", messages: [], stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
  };
}
function failedResult() {
  return { ...cancelledResult(), exitCode: 1, errorMessage: "boom", stopReason: "error" };
}

// Mirror the dock row publishRoutedStatus writes for one item.
function publish(id, results, state) {
  const ctx = { hasUI: true };
  publishRoutedStatus(ctx, id, "single", [{ agent: "deep-reviewer", task: "t" }], results, Date.now(), state);
  return dockTest.peekTask(`sub:${id}:0`);
}

(async () => {
  // 1. A cancelled result is a cancellation, not a failure.
  check(isFailedResult(cancelledResult()) === true, "precondition: a cancel still counts as failed by isFailedResult");
  const cancelled = publish("cancel-1", [cancelledResult()], "running");
  check(cancelled && cancelled.state === "cancelled", "cancelled result shows as cancelled, not error (got " + (cancelled && cancelled.state) + ")");

  // 2. A genuine failure must still show as error (no false cancellation).
  const failed = publish("fail-1", [failedResult()], "running");
  check(failed && failed.state === "error", "genuine failure still shows as error (got " + (failed && failed.state) + ")");

  // 2b. A parallel placeholder (exitCode -1) is a run still in progress: it must show as
  // running, never as error or done. Before the fix, isFailedResult(-1) read it as failed.
  const placeholder = { ...cancelledResult(), exitCode: -1, errorMessage: undefined, stopReason: undefined };
  const running = publish("placeholder-1", [placeholder], "running");
  check(running && running.state === "running", "parallel placeholder shows as running, not error/done (got " + (running && running.state) + ")");
  check(sub.__test.isPlaceholderResult(placeholder) === true, "isPlaceholderResult recognises the -1 sentinel");
  check(sub.__test.isPlaceholderResult(failedResult()) === false, "isPlaceholderResult ignores a real failure");

  // 3. A successful result still shows as done.
  const ok = { ...cancelledResult(), exitCode: 0, errorMessage: undefined, stopReason: "end_turn" };
  const done = publish("ok-1", [ok], "running");
  check(done && done.state === "done", "successful result still shows as done (got " + (done && done.state) + ")");

  // 4. The cancelled row lingers and is removed: it must not stay forever.
  // DONE_LINGER_MS is 15s; wait past it and confirm the row is gone.
  await new Promise((r) => setTimeout(r, 16000));
  check(!dockTest.peekTask("sub:cancel-1:0"), "cancelled row is removed after the linger window");

  // 5. End to end through the real subagent_routed.execute: a setup throw (worktree
  // isolation, which fails before any child spawns) must not leave the status timer
  // alive. The timer rewrites the dock row every second, so a leaked timer would flip
  // the row back to running. Assert it stays error after 3s.
  const tools = {};
  sub.default({ registerTool: (t) => { tools[t.name] = t; }, registerShortcut() {}, registerCommand() {}, on() {}, events: { on() {}, emit() {} }, registerMessageRenderer() {} });
  const ctx = { cwd: process.cwd(), hasUI: true, sessionManager: {}, ui: {} };
  // Synchronous on purpose: this case asserts the setup throw reaches the caller. A background
  // run (the default) reports the same failure through the dock and a follow-up instead.
  const params = { mode: "single", agent: "deep-reviewer", task: "t", run_in_background: false, runtimePolicy: { isolation: "worktree" } };
  let threw = false;
  await tools.subagent_routed.execute("call-e2e", params, undefined, undefined, ctx).catch(() => { threw = true; });
  check(threw, "the setup throw still propagates to the caller");
  check(dockTest.peekTask("sub:call-e2e:0")?.state === "error", "row is error right after the setup throw");
  await new Promise((r) => setTimeout(r, 3000));
  check(dockTest.peekTask("sub:call-e2e:0")?.state === "error", "row stays error: the status timer was stopped, not left running");

  console.log(passed + " passed, 0 failed");
})().catch((error) => { console.error(error.message); process.exit(1); });
'
