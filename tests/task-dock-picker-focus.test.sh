#!/usr/bin/env bash
# Regression: while a grouped-picker selection window holds focus, the task dock's ↓ listener
# must not consume the key. The real task-dock.ts registers its listener on session_start; the
# real TuiBase delivers input to listeners before the focused component. This drives both with
# real code, so it proves the wiring rather than a hand copy of it.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/pi-jiti.sh
source "$here/lib/pi-jiti.sh"
locate_pi_jiti || exit 1

root="$(cd "$here/.." && pwd)"

node - "$PI_JITI/.." "$PI_TUI" "$root" <<'NODE'
const assert = require("node:assert/strict");
const path = require("node:path");
const [, , jitiParent, piTui, root] = process.argv;
const jiti = require(path.join(jitiParent, "jiti"))(root, { interopDefault: true });

const dock = jiti(path.join(root, "extensions/task-dock.ts")).default;
const { runGroupedPicker } = jiti(path.join(root, "extensions/grouped-picker/grouped-picker.ts"));
const { TuiBase } = jiti(path.join(piTui, "dist/tui.js"));
const { matchesKey } = jiti(path.join(piTui, "dist/keys.js"));

(async () => {
  // Capture the session_start handler the real task-dock registers.
  const handlers = {};
  const pi = {
    on(event, fn) { (handlers[event] ??= []).push(fn); },
    registerCommand() {}, registerShortcut() {}, registerTool() {}, registerMessageRenderer() {},
    appendEntry() {}, getActiveTools: () => [], setActiveTools() {},
    events: { on() { return () => {}; }, emit() {} },
    sendMessage() {}, sendUserMessage() {}, setLabel() {},
  };
  dock(pi);

  // A UI that records the listeners task-dock registers, as pi's real ctx.ui does.
  const listeners = [];
  const term = {
    columns: 80, rows: 24, kittyProtocolActive: false,
    start() {}, stop() {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {},
    clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
    drainInput: async () => {},
  };
  const tui = new TuiBase(term);
  // Rendering is not under test; input routing is. A stopped TUI does not schedule frames.
  tui.stopped = true;
  const theme = { fg: (_role, text) => text };
  let picker;
  const ui = {
    hasUI: true,
    getEditorText: () => "",
    onTerminalInput(fn) { listeners.push(fn); return () => {}; },
    setWidget() {}, setStatus() {}, notify() {},
    custom: (factory) => new Promise((resolve) => {
      picker = factory(tui, theme, null, resolve);
    }),
  };
  const ctx = { hasUI: true, ui, isIdle: () => true, sessionManager: { getEntries: () => [] } };

  // Real task-dock registers its ↓ listener on session_start.
  for (const fn of handlers.session_start ?? []) await fn({}, ctx);
  assert.ok(listeners.length >= 1, "task-dock registered a terminal-input listener");

  // Feed the real TuiBase: listeners run first, then the focused component.
  const seen = [];
  tui.setFocus({ render: () => [], invalidate() {}, handleInput: (d) => seen.push(d) });
  // Give the TUI the same listeners pi gives it.
  for (const fn of listeners) tui.addInputListener(fn);

  // The dock gate only opens with rows present, so give it one background task. Without a row
  // canOpenPicker is false and the test would pass for the wrong reason.
  const dockModule = jiti(path.join(root, "extensions/task-dock.ts"));
  dockModule.upsertTask(ctx, "bg-test-1", { source: "bg", label: "probe", state: "running", startedAt: Date.now() });

  // Open a real selection window and focus it, as ask_user_question does.
  const questions = [{ id: "scope", label: "Scope", options: ["narrow", "broad"] }];
  const pending = runGroupedPicker(ctx, questions);
  tui.setFocus(picker);
  const pickerSeen = [];
  const inner = picker.handleInput.bind(picker);
  picker.handleInput = (d) => { pickerSeen.push(d); inner(d); };

  tui.handleTerminalInput("\x1b[B"); // Down
  tui.handleTerminalInput("\x1b[A"); // Up

  assert.ok(pickerSeen.includes("\x1b[B"), "Down reaches the open selection window, not the dock");
  assert.ok(pickerSeen.includes("\x1b[A"), "Up reaches the open selection window");

  // Closing the window releases the busy flag, so the dock's ↓ works again on the next prompt.
  picker.dispose();
  pendingCancel(pending);
  console.log("task dock picker focus: ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

function pendingCancel(p) {
  // The picker promise is not awaited; resolving it is not needed for the assertions above.
  void p;
}
NODE
