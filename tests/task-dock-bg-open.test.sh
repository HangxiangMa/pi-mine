#!/usr/bin/env bash
# Choosing a background row in the unified picker must open the upstream task manager for that
# task, through the pi-background-tasks `open` operation, not just show a hint to press Ctrl+Alt+B.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/pi-jiti.sh
source "$here/lib/pi-jiti.sh"
locate_pi_jiti || exit 1

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
printf 'exports.getAgentDir=()=>process.env.PI_CORE_INVARIANTS_DIR; exports.CONFIG_DIR_NAME=".pi"; exports.getMarkdownTheme=()=>({}); exports.withFileMutationQueue=async (_key, fn)=>fn();\n' > "$tmp/shim.cjs"
export PI_CORE_INVARIANTS_DIR="$tmp"

node - "$PI_JITI" "$here/../extensions/task-dock.ts" "$tmp/shim.cjs" <<'NODE'
(async () => {
const assert = require("node:assert/strict");
const jiti = require(process.argv[2])(process.cwd(), { interopDefault: true, alias: {
  "@earendil-works/pi-coding-agent": process.argv[4],
}});
const dock = jiti(process.argv[3]);
assert.equal(typeof dock.__test?.openPickedTarget, "function", "__test.openPickedTarget must be exported for this contract");

// A fake upstream: records every request and answers `open` the way the real service does.
function makeSession({ openOk = true } = {}) {
  const handlers = new Map();
  const subs = new Map();
  const requests = [];
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerShortcut() {}, registerCommand() {}, registerTool() {},
    events: {
      on(name, handler) {
        if (!subs.has(name)) subs.set(name, new Set());
        subs.get(name).add(handler);
        return () => subs.get(name).delete(handler);
      },
      emit(name, data) {
        if (name !== "pi-background-tasks:request:v1") return;
        requests.push(data);
        const reply = data.operation === "open"
          ? (openOk
              ? { schema_version: "x", request_id: data.request_id, operation: "open", ok: true, result: { opened: true, taskId: data.payload.taskId, message: "opened" } }
              : { schema_version: "x", request_id: data.request_id, operation: "open", ok: false, error: "task manager cannot open in this host" })
          : { schema_version: "x", request_id: data.request_id, operation: "status", ok: true, result: { tasks: [] } };
        for (const h of [...(subs.get("pi-background-tasks:response:v1") ?? [])]) h(reply);
      },
    },
    appendEntry() {}, getActiveTools: () => [], setActiveTools() {},
  };
  const notices = [];
  let pickerTarget;
  const ctx = {
    hasUI: true,
    ui: {
      setWidget() {}, setStatus() {},
      notify(message, level) { notices.push({ message, level }); },
      theme: { fg: (_c, text) => text },
      getEditorText: () => "", onTerminalInput: () => () => {},
      // The picker resolves with whichever target the test chose, as if the user pressed Enter.
      custom: () => Promise.resolve(pickerTarget),
    },
    isIdle: () => true,
    sessionManager: { getEntries: () => [], getSessionId: () => "s" },
  };
  dock.default(pi);
  return { handlers, ctx, notices, requests, pi, choose(t) { pickerTarget = t; } };
}

const bgTarget = {
  kind: "bg",
  rowId: "bg:b3796cade",
  taskId: "b3796cade",
  label: "unify-check",
  state: "running",
  startedAt: Date.now(),
};

// 1. Choosing a bg row sends the upstream `open` operation with the bare task id.
{
  const session = makeSession();
  await session.handlers.get("session_start")({ type: "session_start" }, session.ctx);
  dock.upsertTask(session.ctx, "bg:b3796cade", { source: "bg", label: "unify-check", state: "running", startedAt: Date.now() });
  await dock.__test.openPickedTarget(session.pi, session.ctx, bgTarget);
  const open = session.requests.find((r) => r.operation === "open");
  assert.ok(open, "choosing a bg row must send the upstream `open` operation");
  assert.equal(open.payload.taskId, "b3796cade", "the payload must carry the bare task id, not the bg: row id");
  // The hint is no longer the answer for a bg row.
  assert.equal(
    session.notices.some((n) => /open with Ctrl\+Alt\+B/.test(n.message)),
    false,
    "a bg row must open the manager, not only show the Ctrl+Alt+B hint",
  );
}

// 2. A refused open is reported to the user, not silently ignored.
{
  const session = makeSession({ openOk: false });
  await session.handlers.get("session_start")({ type: "session_start" }, session.ctx);
  await dock.__test.openPickedTarget(session.pi, session.ctx, bgTarget);
  assert.equal(
    session.notices.some((n) => n.level === "error" && /cannot open|could not open/i.test(n.message)),
    true,
    "an upstream refusal must reach the user as an error notice",
  );
}

console.log("task dock bg open: ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
NODE
