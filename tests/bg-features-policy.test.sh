#!/usr/bin/env bash
# pi turns off pi-background-tasks' attested feature because the office uses a company relay and
# traffic management, not subscription OAuth. The value is checked against pi-background-tasks'
# real parseBackgroundTasksConfig, so an accepted value is proven, not just a string compared to
# itself. A value the user already chose must be kept.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/pi-jiti.sh
source "$here/lib/pi-jiti.sh"
locate_pi_jiti || exit 1

node - "$PI_JITI" "$here/../extensions/bg-dock/features-policy.ts" "$here/../../pi-background-tasks/src/core/config.ts" "$here/../extensions/index.ts" <<'NODE'
const assert = require("node:assert/strict");
const jiti = require(process.argv[2])(process.cwd(), { interopDefault: true });
const policy = jiti(process.argv[3]);
const config = jiti(process.argv[4]);
const fs = require("node:fs");

function assertFeatures(parsed, message) {
  assert.equal(parsed.process, true, `${message}: process is enabled`);
  assert.equal(parsed.delegate, true, `${message}: delegate is enabled`);
  assert.equal(parsed.fusion, true, `${message}: fusion is enabled`);
  assert.equal(parsed.attested, false, `${message}: attested is disabled`);
  assert.equal(parsed.attribution, true, `${message}: attribution is enabled`);
}

// Unset: attested is disabled, and the real upstream parser accepts the policy value.
{
  const env = {};
  policy.applyBgFeaturesPolicy(env);
  assert.equal(env.PI_BG_FEATURES, "process,delegate,fusion,attribution", "an unset features value omits attested");
  assertFeatures(config.parseBackgroundTasksConfig(env).features, "an unset features value");
  console.log("unset bg features: ok");
}

// Empty counts as unset, so it receives the same policy value.
{
  const env = { PI_BG_FEATURES: "" };
  policy.applyBgFeaturesPolicy(env);
  assert.equal(env.PI_BG_FEATURES, "process,delegate,fusion,attribution", "an empty features value omits attested");
  assertFeatures(config.parseBackgroundTasksConfig(env).features, "an empty features value");
  console.log("empty bg features: ok");
}

// A value the user chose is kept, including attested.
{
  const chosen = "process,delegate,fusion,attested,attribution";
  const env = { PI_BG_FEATURES: chosen };
  policy.applyBgFeaturesPolicy(env);
  assert.equal(env.PI_BG_FEATURES, chosen, "a user-chosen features value is kept");
  assert.deepEqual(config.parseBackgroundTasksConfig(env).features, {
    process: true,
    delegate: true,
    fusion: true,
    attested: true,
    attribution: true,
  });
  console.log("user bg features: ok");
}

// Idempotent: a second call leaves the policy value unchanged.
{
  const env = {};
  policy.applyBgFeaturesPolicy(env);
  policy.applyBgFeaturesPolicy(env);
  assert.equal(env.PI_BG_FEATURES, "process,delegate,fusion,attribution", "a second call leaves the policy value in place");
  console.log("idempotent bg features: ok");
}

// The policy only matters if the extension entry calls it before pi.registerCommand.
{
  const entry = fs.readFileSync(process.argv[5], "utf8");
  assert.match(entry, /import \{ applyBgFeaturesPolicy \} from "\.\/bg-dock\/features-policy\.ts"/, "the entry must import applyBgFeaturesPolicy");
  assert.match(entry, /applyBgDockWidgetPolicy\(process\.env\);\s*applyBgFeaturesPolicy\(process\.env\);\s*\/\/ Shows the feature switches,[\s\S]*?pi\.registerCommand/, "the entry must apply the policy before pi.registerCommand");
  console.log("wiring: ok");
}

console.log("bg features policy: ok");
NODE
