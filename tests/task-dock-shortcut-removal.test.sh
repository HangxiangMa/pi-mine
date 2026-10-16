#!/usr/bin/env bash
# ↓ on an empty prompt is the single entry point for background and subagent tasks. The old
# Ctrl+Alt+I and Ctrl+Alt+B bindings must be gone: no shortcut is registered for them, the bg dock
# shortcut defaults to off, and no label on screen names a key that no longer does anything.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/pi-jiti.sh
source "$here/lib/pi-jiti.sh"
locate_pi_jiti || exit 1

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
printf 'exports.getAgentDir=()=>process.env.PI_CORE_INVARIANTS_DIR; exports.CONFIG_DIR_NAME=".pi"; exports.getMarkdownTheme=()=>({}); exports.withFileMutationQueue=async (_key, fn)=>fn();\n' > "$tmp/shim.cjs"
export PI_CORE_INVARIANTS_DIR="$tmp"

node - "$PI_JITI" "$here/.." "$tmp/shim.cjs" <<'NODE'
(async () => {
const assert = require("node:assert/strict");
const path = require("node:path");
const jiti = require(process.argv[2])(process.cwd(), { interopDefault: true, alias: {
  "@earendil-works/pi-coding-agent": process.argv[4],
}});
const root = process.argv[3];
const policy = jiti(path.join(root, "extensions/bg-dock/policy.ts"));
const config = jiti(path.join(root, "../pi-background-tasks/src/core/config.ts"));
const subagentIndex = jiti(path.join(root, "extensions/subagent/index.ts"));
const picker = jiti(path.join(root, "extensions/task-dock-picker-view.ts"));
const dock = jiti(path.join(root, "extensions/task-dock.ts"));

// 1. ctrl+alt+i is no longer registered by the subagent extension.
{
  const registered = [];
  const pi = {
    registerShortcut(key) { registered.push(key); },
    registerCommand() {}, registerTool() {}, on() {}, events: { on() { return () => {}; }, emit() {} },
    registerMessageRenderer() {}, appendEntry() {}, getActiveTools: () => [], setActiveTools() {},
  };
  subagentIndex.default(pi);
  assert.equal(
    registered.includes("ctrl+alt+i"),
    false,
    "ctrl+alt+i must no longer be registered; ↓ is the single entry point",
  );
}

// 2. The bg dock shortcut defaults to off, so ctrl+alt+b is not bound, and the upstream parser accepts it.
{
  const env = {};
  policy.applyBgDockShortcutPolicy(env);
  assert.equal(env.PI_BG_DOCK_SHORTCUT, "off", "an unset bg dock shortcut defaults to off");
  const parsed = config.parseBackgroundTasksConfig(env);
  assert.equal(parsed.dockShortcut, "off", "upstream accepts off and binds no bg shortcut");
}

// 3. A value the user explicitly chose still wins over the default.
{
  const env = { PI_BG_DOCK_SHORTCUT: "ctrl+alt+b" };
  policy.applyBgDockShortcutPolicy(env);
  assert.equal(env.PI_BG_DOCK_SHORTCUT, "ctrl+alt+b", "a user-chosen ctrl+alt+b is kept");
}

// 4. The picker's section headers name no removed key.
{
  const bgHeader = picker.pickerLines([{ kind: "bg", rowId: "bg:x", taskId: "x", label: "t", state: "running", startedAt: 0 }], 0)[0];
  const subHeader = picker.pickerLines([{ kind: "subagent", rowId: "delegate:x", taskId: "x", label: "t", state: "running", startedAt: 0 }], 0)[0];
  for (const header of [bgHeader, subHeader]) {
    assert.equal(/Ctrl\+Alt\+[BI]/.test(header), false, `a picker header must not name a removed key: ${header}`);
  }
}

// 5. The dock's section titles name no removed key. Checked on the real source, so a title that
// is built at runtime from a constant cannot slip past a string comparison.
{
  const taskDockSource = require("node:fs").readFileSync(path.join(root, "extensions/task-dock.ts"), "utf8");
  assert.equal(
    /BG_SHORTCUT\s*=\s*"Ctrl\+Alt\+B"/.test(taskDockSource) || /SUBAGENT_SHORTCUT\s*=\s*"Ctrl\+Alt\+I"/.test(taskDockSource),
    false,
    "task-dock.ts must not define a section key constant for a removed shortcut",
  );
}

console.log("task dock shortcut removal: ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
NODE
