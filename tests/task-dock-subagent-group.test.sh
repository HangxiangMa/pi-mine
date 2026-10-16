#!/usr/bin/env bash
# A routed subagent row (source "subagent") must sit under the "subagent tasks" header, the same as
# a delegate row. Single background, parallel and chain runs all write source "subagent"; before
# this fix they fell outside the subagent section, so the dock showed no header for them.
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
const pi = {
  on(name, handler) { handlers.set(name, handler); },
  registerShortcut() {}, registerCommand() {}, registerTool() {},
  events: { on() {}, emit() {} }, appendEntry() {}, getActiveTools: () => [], setActiveTools() {},
};
const widgets = new Map();
const ctx = {
  hasUI: true,
  ui: {
    setWidget(key, content, options) { widgets.set(key, { content, options }); },
    setStatus() {}, notify() {}, theme: { fg: (_c, text) => text },
  },
  isIdle: () => true,
  sessionManager: { getEntries: () => [], getSessionId: () => "s" },
};
dock.default(pi);
handlers.get("session_start")({ type: "session_start" }, ctx);

const theme = { fg: (_c, text) => text };
const draw = () => dock.__test.renderLines(theme, 200);

// A single background routed run: source "subagent", exactly as publishRoutedStatus writes it.
dock.upsertTask(ctx, "sub:single-1:0", {
  source: "subagent", label: "deep-reviewer", state: "running", startedAt: Date.now() - 2000,
});

const lines = draw();
assert.equal(
  lines[0],
  "subagent tasks",
  `a subagent row must open the subagent section, got: ${JSON.stringify(lines[0])}`,
);
assert.ok(lines[1] && lines[1].includes("deep-reviewer"), `the row sits under the subagent header, got: ${JSON.stringify(lines[1])}`);
assert.equal(lines.length, dock.dockRowCount(), `drawn lines ${lines.length} must equal dockRowCount() ${dock.dockRowCount()}`);

console.log("task dock subagent group: ok");
NODE
