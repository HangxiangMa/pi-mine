#!/usr/bin/env bash
# The task dock is on demand: it is not registered with no tasks, and it appears only while a task
# exists. When it appears, each section header names its own key, for example "subagent tasks · Ctrl+Alt+I".
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

// On demand: with no tasks, session start must NOT leave a resident dock behind.
assert.equal(widgets.get("task-dock"), undefined, "no tasks means no resident dock");

// A running task appears: the dock comes up below the editor, headed by its section key.
dock.upsertTask(ctx, "ondemand1", { source: "delegate", label: "probe", state: "running" });
const widget = widgets.get("task-dock");
assert.ok(widget, "a running task brings the dock up");
assert.equal(widget.options?.placement, "belowEditor", "the dock stays below the editor");

const tui = { requestRender() {} };
const component = widget.content(tui, ctx.ui.theme);
const lines = component.render(200);
// A delegate task is a subagent: its section header carries the Ctrl+Alt+I key, not the bg key.
const title = lines[0];
assert.equal(
  title,
  "subagent tasks · Ctrl+Alt+I",
  `subagent section header carries the Ctrl+Alt+I key, got: ${title}`,
);
assert.ok(!title.includes("Ctrl+Alt+B"), "a subagent section does not carry the bg key");

console.log("task dock on demand: ok");
NODE
