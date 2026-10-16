#!/usr/bin/env bash
# pi hides pi-background-tasks' own footer dock, because the Tasks panel (task-dock.ts) already shows
# bg tasks. The value is checked against pi-background-tasks' real parseBackgroundTasksConfig, so an
# accepted value is proven, not just a string compared to itself. A value the user already chose wins.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/pi-jiti.sh
source "$here/lib/pi-jiti.sh"
locate_pi_jiti || exit 1

node - "$PI_JITI" "$here/../extensions/bg-dock/policy.ts" "$here/../../pi-background-tasks/src/core/config.ts" "$here/../extensions/index.ts" <<'NODE'
const assert = require("node:assert/strict");
const jiti = require(process.argv[2])(process.cwd(), { interopDefault: true });
const policy = jiti(process.argv[3]);
const config = jiti(process.argv[4]);
const fs = require("node:fs");

// Unset: the background dock widget is hidden, and the real upstream parser accepts off.
{
  const env = {};
  policy.applyBgDockWidgetPolicy(env);
  assert.equal(env.PI_BG_DOCK_WIDGET, "off", "an unset widget switch is turned off");
  const parsed = config.parseBackgroundTasksConfig(env);
  assert.equal(parsed.dockWidget, "off", "upstream parseBackgroundTasksConfig accepts off");
}

// Empty counts as unset, same as the shortcut policy.
{
  const env = { PI_BG_DOCK_WIDGET: "" };
  policy.applyBgDockWidgetPolicy(env);
  assert.equal(env.PI_BG_DOCK_WIDGET, "off", "an empty widget switch is treated as unset");
}

// A value the user chose is kept, including on.
for (const chosen of ["on", "off"]) {
  const env = { PI_BG_DOCK_WIDGET: chosen };
  policy.applyBgDockWidgetPolicy(env);
  assert.equal(env.PI_BG_DOCK_WIDGET, chosen, `a user-set ${chosen} is kept`);
}

// Idempotent: applying twice leaves the same value.
{
  const env = {};
  policy.applyBgDockWidgetPolicy(env);
  policy.applyBgDockWidgetPolicy(env);
  assert.equal(env.PI_BG_DOCK_WIDGET, "off", "applying the policy twice is a no-op");
}

// The policy only matters if the extension entry calls it. A correct function that is never called
// would hide nothing, so check the wiring in the entry source as well.
{
  const entry = fs.readFileSync(process.argv[5], "utf8");
  assert.match(entry, /applyBgDockWidgetPolicy\(process\.env\)/, "extensions/index.ts must call applyBgDockWidgetPolicy(process.env)");
  assert.match(entry, /import \{[^}]*applyBgDockWidgetPolicy[^}]*\} from "\.\/bg-dock\/policy\.ts"/, "the entry must import applyBgDockWidgetPolicy from the policy module");
}

console.log("bg dock widget policy: ok");
NODE
