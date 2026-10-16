#!/usr/bin/env bash
# Reproduces "a started bg task does not change the status bar". The bg task is started by
# pi-background-tasks; the dock learns about it only through the status poll. This drives the
# real poll path: session_start issues a status request, a fake pi-background-tasks answers with
# a running snapshot, and the dock must show that row.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/pi-jiti.sh
source "$here/lib/pi-jiti.sh"
locate_pi_jiti || exit 1

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
printf 'exports.getAgentDir=()=>process.env.PI_CORE_INVARIANTS_DIR; exports.CONFIG_DIR_NAME=".pi"; exports.getMarkdownTheme=()=>({}); exports.withFileMutationQueue=async (_key, fn)=>fn();\n' > "$tmp/shim.cjs"
export PI_CORE_INVARIANTS_DIR="$tmp"
export PI_CORE_INVARIANTS_SHIM="$tmp/shim.cjs"

node - "$PI_JITI" "$here/../extensions/task-dock.ts" <<'NODE'
const assert = require("node:assert/strict");
const jiti = require(process.argv[2])(process.cwd(), { interopDefault: true, alias: {
  "@earendil-works/pi-coding-agent": process.env.PI_CORE_INVARIANTS_SHIM,
}});
const dock = jiti(process.argv[3]);

const handlers = new Map();
const busHandlers = new Map();
const emitted = [];
const pi = {
  on(name, handler) { handlers.set(name, handler); },
  registerShortcut() {},
  registerCommand() {},
  registerTool() {},
  events: {
    on(channel, handler) {
      busHandlers.set(channel, handler);
      return () => busHandlers.delete(channel);
    },
    emit(channel, data) {
      emitted.push({ channel, data });
      // pi-background-tasks answers status requests. The fake answers with one running task,
      // the state a freshly started bg task has.
      if (channel === "pi-background-tasks:request:v1" && data.operation === "status") {
        const reply = busHandlers.get("pi-background-tasks:response:v1");
        reply?.({
          request_id: data.request_id,
          ok: true,
          result: {
            tasks: [{ id: "bgtask1", name: "long build", status: "running", startTime: Date.now() }],
          },
        });
      }
    },
  },
  appendEntry() {},
  getActiveTools: () => [],
  setActiveTools() {},
};

const widgets = new Map();
const ctx = {
  hasUI: true,
  ui: {
    setWidget(key, content) { widgets.set(key, content); },
    setStatus() {},
    notify() {},
    theme: { fg: (_c, text) => text },
  },
  isIdle: () => true,
  sessionManager: { getEntries: () => [], getSessionId: () => "s" },
};

dock.default(pi);

(async () => {
// Start the session. This arms the status poll and the dock.
await handlers.get("session_start")({ type: "session_start" }, ctx);

// The poll was issued and answered. The dock must now carry the running bg row.
const requested = emitted.some((e) => e.channel === "pi-background-tasks:request:v1");
assert.ok(requested, "session_start issues a status request to pi-background-tasks");

const entry = dock.__test.peekTask("bg:bgtask1");
assert.ok(entry, "a running bg task from the status poll is registered in the dock");
assert.equal(entry.state, "running", "the registered bg task is running");

const lines = dock.__test.renderLines({ fg: (_c, text) => text }, 200);
const joined = lines.join("\n");
assert.ok(joined.includes("long build"), `the dock draws the running bg task, got:\n${joined}`);

// The bg section header must appear as soon as the bg task starts, and carry the bg key.
const title = lines[0];
assert.equal(
  title,
  "bg tasks · Ctrl+Alt+B",
  `the bg section header carries the Ctrl+Alt+B key, got: ${title}`,
);

console.log("task dock bg start: ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
NODE
