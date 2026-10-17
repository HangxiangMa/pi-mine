#!/usr/bin/env bash
# The bg poll must not swallow real failures. A non-stale error from the poll is reported to the
# user once, and a stale-context error (an ordinary session replacement) stays silent. Neither
# may crash the process.
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

// Build a session whose event bus throws on the bg request, the way a real failure would.
function makeSession(emitError, responseError) {
  const handlers = new Map();
  const responseListeners = new Set();
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerShortcut() {}, registerCommand() {}, registerTool() {},
    events: {
      on(name, listener) {
        if (responseError !== undefined && name === "pi-background-tasks:response:v1") {
          responseListeners.add(listener);
          return () => responseListeners.delete(listener);
        }
        return () => {};
      },
      emit(name, data) {
        if (name !== "pi-background-tasks:request:v1") return;
        if (emitError) throw emitError;
        if (responseError === undefined) return;
        for (const listener of responseListeners) {
          listener({
            schema_version: "pi-background-tasks.extension-response.v1",
            request_id: data.request_id,
            operation: data.operation,
            ok: false,
            error: responseError,
          });
        }
      },
    },
    appendEntry() {}, getActiveTools: () => [], setActiveTools() {},
  };
  const notices = [];
  const ctx = {
    hasUI: true,
    ui: {
      setWidget() {}, setStatus() {},
      notify(message, level) { notices.push({ message, level }); },
      theme: { fg: (_c, text) => text },
      getEditorText: () => "", onTerminalInput: () => () => {},
      custom: () => Promise.resolve(undefined),
    },
    isIdle: () => true,
    sessionManager: { getEntries: () => [], getSessionId: () => "s" },
  };
  dock.default(pi);
  return { handlers, ctx, notices };
}

// 1. A real, non-stale failure is reported to the user, not swallowed.
{
  const session = makeSession(new Error("pi-background-tasks request channel broke"));
  await session.handlers.get("session_start")({ type: "session_start" }, session.ctx);
  assert.equal(
    session.notices.some((n) => /background task status poll failed/i.test(n.message)),
    true,
    "a non-stale poll failure must reach the user through a notice",
  );
}

// 2. The same failure repeated on every poll tick is reported once, not every few seconds.
// The dedupe set is process-wide, so this case uses its own message to stay independent of case 1.
{
  const session = makeSession(new Error("dedupe-case request channel broke"));
  await session.handlers.get("session_start")({ type: "session_start" }, session.ctx);
  await session.handlers.get("session_start")({ type: "session_start" }, session.ctx);
  const pollNotices = session.notices.filter((n) => /background task status poll failed/i.test(n.message));
  assert.equal(pollNotices.length, 1, `a repeated failure must be reported once, got ${pollNotices.length}`);
}

// 3. A stale-context error is an ordinary session replacement and stays silent.
{
  const stale = new Error("This extension ctx is stale after session replacement");
  const session = makeSession(stale);
  await session.handlers.get("session_start")({ type: "session_start" }, session.ctx);
  assert.equal(
    session.notices.some((n) => /background task status poll failed/i.test(n.message)),
    false,
    "a stale-context error must not be reported as a failure",
  );
}

// 4. The startup race is transient and stays silent on the first not-ready response.
{
  const notReady = "pi-background-tasks EventBus service is unavailable before session_start";
  const session = makeSession(undefined, notReady);
  await session.handlers.get("session_start")({ type: "session_start" }, session.ctx);
  assert.equal(
    session.notices.filter((n) => /background task status poll failed/i.test(n.message)).length,
    0,
    "the startup race must be tolerated silently",
  );
  await session.handlers.get("session_shutdown")({ type: "session_shutdown" }, session.ctx);
}

// 5. A persistent not-ready service is reported once after the tolerated streak.
{
  const notReady = "pi-background-tasks EventBus service is unavailable before session_start";
  const session = makeSession(undefined, notReady);
  const priorPollMs = process.env.PI_TASK_DOCK_BG_POLL_MS;
  process.env.PI_TASK_DOCK_BG_POLL_MS = "20";
  await session.handlers.get("session_start")({ type: "session_start" }, session.ctx);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await session.handlers.get("session_shutdown")({ type: "session_shutdown" }, session.ctx);
  const pollNotices = session.notices.filter((n) => /background task status poll failed/i.test(n.message));
  assert.equal(pollNotices.length, 1, `persistent not-ready must be reported once, got ${pollNotices.length}`);
  if (priorPollMs === undefined) delete process.env.PI_TASK_DOCK_BG_POLL_MS;
  else process.env.PI_TASK_DOCK_BG_POLL_MS = priorPollMs;
}

// 6. Any other rejection is reported immediately.
{
  const session = makeSession(undefined, "boom: bus broke");
  await session.handlers.get("session_start")({ type: "session_start" }, session.ctx);
  const pollNotices = session.notices.filter((n) => /background task status poll failed/i.test(n.message));
  assert.equal(pollNotices.length, 1, `an ordinary rejection must be reported once, got ${pollNotices.length}`);
  assert.match(pollNotices[0].message, /boom: bus broke/);
  await session.handlers.get("session_shutdown")({ type: "session_shutdown" }, session.ctx);
}

console.log("task dock poll errors: ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
NODE
