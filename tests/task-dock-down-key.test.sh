#!/usr/bin/env bash
# The dock's ↓ listener, driven through the real session_start wiring. A ↓ on an empty prompt with
# a running task opens the picker and is consumed. With typed text, with no task rows, or with a
# picker already open, ↓ must pass through to the editor untouched.
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
(async () => {
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

// A fake UI that captures the terminal-input listener, so the test can feed it keys directly.
let inputListener;
// Let the stub picker's promise and its .finally run, so the next key sees the picker as closed.
const settle = () => new Promise((resolve) => setImmediate(resolve));
let editorText = "";
let notified;
let custom = 0;
const ctx = {
  hasUI: true,
  ui: {
    setWidget() {}, setStatus() {},
    notify(message) { notified = message; },
    theme: { fg: (_c, text) => text },
    getEditorText: () => editorText,
    onTerminalInput(listener) { inputListener = listener; return () => { inputListener = undefined; }; },
    // The picker resolves at once with no choice, so the test only checks that it was opened.
    custom() { custom += 1; return Promise.resolve(undefined); },
  },
  isIdle: () => true,
  sessionManager: { getEntries: () => [], getSessionId: () => "s" },
};

dock.default(pi);
handlers.get("session_start")({ type: "session_start" }, ctx);
assert.equal(typeof inputListener, "function", "session_start must arm the terminal input listener");

// No rows yet: ↓ is not ours, so it passes through to the editor.
assert.equal(inputListener("\x1b[B"), undefined, "↓ with no task rows must reach the editor");

// A running task: ↓ on an empty prompt opens the picker and is consumed.
dock.upsertTask(ctx, "bg:down-1", { source: "bg", label: "build", state: "running", startedAt: Date.now() });
const opened = inputListener("\x1b[B");
assert.deepEqual(opened, { consume: true }, "↓ on an empty prompt with a task must be consumed");
assert.equal(custom, 1, "the picker overlay must open");
await settle();

// Typed text: ↓ belongs to the editor.
editorText = "draft";
assert.equal(inputListener("\x1b[B"), undefined, "↓ with typed text must reach the editor");

// Any other key is never ours.
editorText = "";
assert.equal(inputListener("a"), undefined, "a printable key must reach the editor");

// ↓ while the picker is already open must not stack a second picker. The stub picker stays open
// until its promise settles, so this check runs before settle().
editorText = "";
const before = custom;
const first = inputListener("\x1b[B");
const second = inputListener("\x1b[B");
assert.deepEqual(first, { consume: true });
assert.equal(second, undefined, "a second ↓ while the picker is open must pass through");
assert.equal(custom, before + 1, "only one picker may open");
await settle();

// The listener is re-armed per session: a new session_start replaces the old one, not stacks it.
handlers.get("session_start")({ type: "session_start" }, ctx);
assert.equal(typeof inputListener, "function", "the listener is re-armed after a new session");

console.log("task dock down key: ok");
})().catch((error) => { console.error(error); process.exit(1); });
NODE
