#!/usr/bin/env bash
# The dock cursor is driven through the real session_start wiring. ↓ selects visible rows,
# ↑ moves toward the top without consuming history, and Esc clears the dock selection.
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

node - "$PI_JITI" "$here/../extensions/task-dock.ts" "$here/../extensions/task-dock-picker.ts" "$here/../extensions/grouped-picker/picker-busy.ts" <<'NODE'
(async () => {
const assert = require("node:assert/strict");
const jiti = require(process.argv[2])(process.cwd(), { interopDefault: true, alias: {
  "@earendil-works/pi-coding-agent": process.env.PI_CORE_INVARIANTS_SHIM,
  "@earendil-works/pi-tui": process.env.PI_TUI,
}});
const { styleText } = jiti("@earendil-works/pi-tui");
const dock = jiti(process.argv[3]);
const { canOpenPicker } = jiti(process.argv[4]);
const { enterPicker, exitPicker } = jiti(process.argv[5]);

const handlers = new Map();
const pi = {
  on(name, handler) { handlers.set(name, handler); },
  registerShortcut() {}, registerCommand() {}, registerTool() {},
  events: { on() {}, emit() {} }, appendEntry() {}, getActiveTools: () => [], setActiveTools() {},
};

let inputListener;
let editorText = "";
let renders = 0;
const theme = {
  fg: (_role, text) => `\x1b[38;5;244m${text}\x1b[39m`,
  underline: (text) => text,
};
const underlined = styleText("X", { underline: true });
assert.ok(underlined.includes("\x1b[4m") && underlined.includes("\x1b[24m"), "styleText underlines with SGR 4 and 24");
const ctx = {
  hasUI: true,
  ui: {
    setWidget(_key, factory) {
      if (typeof factory === "function") factory({ requestRender: () => { renders += 1; } }, theme);
    },
    setStatus() {}, notify() {},
    theme,
    getEditorText: () => editorText,
    onTerminalInput(listener) { inputListener = listener; return () => { inputListener = undefined; }; },
  },
  isIdle: () => true,
  sessionManager: { getEntries: () => [], getSessionId: () => "s" },
};

dock.default(pi);
let openedRowId;
dock.registerSubagentRunOpener(async (_ctx, rowId) => {
  openedRowId = rowId;
});
handlers.get("session_start")({ type: "session_start" }, ctx);
assert.equal(typeof inputListener, "function", "session_start must arm the terminal input listener");

// No rows: ↓ is not ours, so it passes through to the editor.
assert.equal(inputListener("\x1b[B"), undefined, "↓ with no task rows must reach the editor");

const now = Date.now();
dock.upsertTask(ctx, "bg:down-1", { source: "bg", label: "build", state: "running", startedAt: now });
dock.upsertTask(ctx, "bg:down-2", { source: "bg", label: "test", state: "running", startedAt: now + 1 });
const beforeFirstDown = renders;
assert.deepEqual(inputListener("\x1b[B"), { consume: true }, "first ↓ selects row zero");
assert.ok(renders > beforeFirstDown, "first ↓ requests a widget render");
let lines = dock.__test.renderLines(theme, 200);
assert.ok(lines.some((line) => line.includes("build") && line.includes("\x1b[4m") && line.includes("\x1b[24m")), "row zero is underlined");

// ↓ advances in order and clamps at the last visible row.
assert.deepEqual(inputListener("\x1b[B"), { consume: true }, "second ↓ selects the next row");
lines = dock.__test.renderLines(theme, 200);
assert.ok(lines.some((line) => line.includes("test") && line.includes("\x1b[4m")), "second row is selected");
assert.deepEqual(inputListener("\x1b[B"), { consume: true }, "↓ at the last row remains dock-owned");
lines = dock.__test.renderLines(theme, 200);
assert.ok(lines.some((line) => line.includes("test") && line.includes("\x1b[4m")), "last row remains selected");

// Typed text keeps ↓ for the editor and must not move the selection.
editorText = "draft";
assert.equal(inputListener("\x1b[B"), undefined, "↓ with typed text must reach the editor");
lines = dock.__test.renderLines(theme, 200);
assert.ok(lines.some((line) => line.includes("test") && line.includes("\x1b[4m")), "typed ↓ does not move selection");
assert.equal(inputListener("\x1b[A"), undefined, "↑ with typed text must reach the editor");
editorText = "";

// ↑ moves up within the dock and consumes selected cases; at the top it clears selection.
assert.deepEqual(inputListener("\x1b[A"), { consume: true }, "↑ within the dock is consumed");
lines = dock.__test.renderLines(theme, 200);
assert.ok(lines.some((line) => line.includes("build") && line.includes("\x1b[4m")), "↑ selects the previous row");
assert.deepEqual(inputListener("\x1b[A"), { consume: true }, "↑ at the top clears selection");
lines = dock.__test.renderLines(theme, 200);
assert.ok(!lines.some((line) => line.includes("\x1b[4m")), "↑ at the top clears selection");
assert.equal(inputListener("\x1b[A"), undefined, "↑ after clearing selection reaches history");
assert.equal(inputListener("\x1b"), undefined, "Esc without a selection reaches existing handlers");

// Enter opens selected delegate/subagent rows; bg rows and editor-owned input pass through.
assert.equal(inputListener("\r"), undefined, "Enter with no dock cursor reaches the editor");
assert.deepEqual(inputListener("\x1b[B"), { consume: true }, "select a bg row for Enter checks");
editorText = "draft";
assert.equal(inputListener("\r"), undefined, "Enter with typed text reaches the editor");
editorText = "";
assert.equal(inputListener("\r"), undefined, "Enter on a bg row does not open a delegate");
assert.equal(openedRowId, undefined, "bg Enter must not call the subagent opener");

dock.upsertTask(ctx, "delegate:enter-1", {
  source: "delegate",
  label: "planner",
  state: "running",
  startedAt: now + 2,
});
assert.deepEqual(inputListener("\x1b[B"), { consume: true }, "↓ advances to the second bg row");
assert.deepEqual(inputListener("\x1b[B"), { consume: true }, "↓ advances to the delegate row");
assert.deepEqual(inputListener("\r"), { consume: true }, "Enter on a delegate row is consumed");
assert.equal(openedRowId, "delegate:enter-1", "delegate Enter opens the selected row id");

dock.upsertTask(ctx, "sub:enter-1", {
  source: "subagent",
  label: "worker",
  state: "running",
  startedAt: now + 3,
});
openedRowId = undefined;
assert.deepEqual(inputListener("\x1b[B"), { consume: true }, "↓ selects the first row for subagent Enter");
assert.deepEqual(inputListener("\x1b[B"), { consume: true }, "↓ advances to the second row for subagent Enter");
assert.deepEqual(inputListener("\x1b[B"), { consume: true }, "↓ advances to the delegate row for subagent Enter");
assert.deepEqual(inputListener("\x1b[B"), { consume: true }, "↓ advances to the subagent row");
assert.deepEqual(inputListener("\r"), { consume: true }, "Enter on a subagent row is consumed");
assert.equal(openedRowId, "sub:enter-1", "subagent Enter opens the selected row id");

// Esc consumes only a live dock selection and requests a repaint when it clears it.
assert.deepEqual(inputListener("\x1b[B"), { consume: true });
const beforeEscape = renders;
assert.deepEqual(inputListener("\x1b"), { consume: true }, "Esc clears the dock selection");
assert.ok(renders > beforeEscape, "Esc requests a widget render");

// Preserve the gate contract independently of the dock cursor wiring.
const gate = { hasRows: true, editorText: "", browsingHistory: false, overlayOpen: false };
assert.equal(canOpenPicker(gate), true, "empty prompt with rows is allowed");
assert.equal(canOpenPicker({ ...gate, hasRows: false }), false, "no rows are rejected");
assert.equal(canOpenPicker({ ...gate, editorText: "draft" }), false, "typed text is rejected");
assert.equal(canOpenPicker({ ...gate, browsingHistory: true }), false, "history browsing is rejected");
enterPicker();
assert.equal(inputListener("\x1b[B"), undefined, "an open picker keeps ↓ for the overlay");
exitPicker();
assert.equal(canOpenPicker({ ...gate, overlayOpen: true }), false, "an open overlay is rejected");

console.log("task dock down key: ok");
})().catch((error) => { console.error(error); process.exit(1); });
NODE
