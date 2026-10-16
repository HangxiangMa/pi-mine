#!/usr/bin/env bash
# The task dock must be visible from session start, with no tasks, and show the shortcut hint.
# Before this, ensureTimer() and publish() only ran once a task was registered, so an empty
# session never registered the widget and the hint stayed hidden until the first task.
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
  on(name, handler) {
    handlers.set(name, handler);
  },
  registerShortcut() {},
  registerCommand() {},
  registerTool() {},
  events: { on() {}, emit() {} },
  appendEntry() {},
  getActiveTools: () => [],
  setActiveTools() {},
};

const widgets = new Map();
const ctx = {
  hasUI: true,
  ui: {
    setWidget(key, content, options) {
      widgets.set(key, { content, options });
    },
    setStatus() {},
    notify() {},
    theme: { fg: (_c, text) => text },
  },
  isIdle: () => true,
  sessionManager: { getEntries: () => [], getSessionId: () => "s" },
};

dock.default(pi);
const onStart = handlers.get("session_start");
assert.ok(onStart, "task-dock registers a session_start handler");

// No tasks at all: session start alone must register the widget.
onStart({ type: "session_start" }, ctx);

const widget = widgets.get("task-dock");
assert.ok(widget, "session_start with no tasks registers the task-dock widget");
assert.equal(widget.options?.placement, "belowEditor", "the dock stays below the editor");

// Render the registered component factory with a plain theme and check the title row.
const tui = { requestRender() {} };
const component = widget.content(tui, ctx.ui.theme);
const lines = component.render(200);
assert.equal(lines.length, 1, `empty dock draws one title row, got ${lines.length}`);
for (const hint of ["Shift\u2193", "Ctrl+Alt+I", "/tasks"]) {
  assert.ok(lines[0].includes(hint), `empty dock title shows ${hint}, got: ${lines[0]}`);
}

console.log("task dock empty session: ok");
NODE
