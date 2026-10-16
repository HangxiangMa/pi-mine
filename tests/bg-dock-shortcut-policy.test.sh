#!/usr/bin/env bash
# pi binds pi-background-tasks' dock shortcut to ctrl+alt+b (the bg section's key). The value is checked
# against pi-background-tasks' real parseBackgroundTasksConfig, so an accepted value is proven,
# not just a string compared to itself. A value the user already chose must be kept.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/pi-jiti.sh
source "$here/lib/pi-jiti.sh"
locate_pi_jiti || exit 1

node - "$PI_JITI" "$here/../extensions/bg-dock/policy.ts" "$here/../../pi-background-tasks/src/core/config.ts" <<'NODE'
const assert = require("node:assert/strict");
const jiti = require(process.argv[2])(process.cwd(), { interopDefault: true });
const policy = jiti(process.argv[3]);
const config = jiti(process.argv[4]);

// Unset: pi binds the dock shortcut to ctrl+alt+b, and the real upstream parser accepts it.
{
  const env = {};
  policy.applyBgDockShortcutPolicy(env);
  assert.equal(env.PI_BG_DOCK_SHORTCUT, "ctrl+alt+b", "an unset shortcut is bound to ctrl+alt+b");
  const parsed = config.parseBackgroundTasksConfig(env);
  assert.equal(parsed.dockShortcut, "ctrl+alt+b", "upstream parseBackgroundTasksConfig accepts ctrl+alt+b");
}

// Empty string counts as unset, so it is also pinned.
{
  const env = { PI_BG_DOCK_SHORTCUT: "" };
  policy.applyBgDockShortcutPolicy(env);
  assert.equal(env.PI_BG_DOCK_SHORTCUT, "ctrl+alt+b", "an empty shortcut is treated as unset");
}

// A value the user chose wins. Pi must not override it.
for (const chosen of ["shift+down", "ctrl+alt+b"]) {
  const env = { PI_BG_DOCK_SHORTCUT: chosen };
  policy.applyBgDockShortcutPolicy(env);
  assert.equal(env.PI_BG_DOCK_SHORTCUT, chosen, `a user-chosen ${chosen} is kept`);
}

// Idempotent: a second call changes nothing.
{
  const env = {};
  policy.applyBgDockShortcutPolicy(env);
  policy.applyBgDockShortcutPolicy(env);
  assert.equal(env.PI_BG_DOCK_SHORTCUT, "ctrl+alt+b", "a second call leaves ctrl+alt+b in place");
}

console.log("bg dock shortcut policy: ok");
NODE
