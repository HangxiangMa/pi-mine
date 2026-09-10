#!/usr/bin/env bash
# Exercise Claude-shaped hook payloads through the real hooks extension.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
hooks="$here/../extensions/hooks.ts"
pi_bin="$(command -v pi || true)"
[[ -n "$pi_bin" ]] || { echo "SKIP: pi not on PATH"; exit 0; }
cli="$(readlink -f "$pi_bin")"
pkgname="@earendil-works/pi-coding-agent"
jiti=""
for cand in \
  "$(dirname "$cli")/../../node_modules/jiti" \
  "$(cd "$(dirname "$cli")/.." 2>/dev/null && pwd)/node_modules/jiti" \
  "$(dirname "$cli")/node_modules/$pkgname/node_modules/jiti" \
  "$(dirname "$pi_bin")/node_modules/$pkgname/node_modules/jiti" \
  "$(dirname "$pi_bin")/../lib/node_modules/$pkgname/node_modules/jiti"; do
  [[ -d "$cand" ]] && { jiti="$cand"; break; }
done
[[ -n "$jiti" ]] || { echo "SKIP: pi package jiti not found"; exit 0; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
printf 'exports.getAgentDir = () => process.env.PI_HOOK_TEST_DIR;\n' > "$tmp/shim.cjs"
export PI_HOOK_TEST_DIR="$tmp"
export PI_HOOK_TEST_OUTPUT="$tmp/payload.json"
export PI_HOOK_TEST_STOP_OUTPUT="$tmp/stop.json"

node - "$jiti" "$hooks" "$tmp/shim.cjs" <<'NODE'
const jiti = require(process.argv[2])(process.cwd(), { interopDefault: true, alias: {
  "@earendil-works/pi-coding-agent": process.argv[4],
}});
const fs = require("node:fs");
const path = require("node:path");
const hooks = jiti(process.argv[3]).default;
const dir = process.env.PI_HOOK_TEST_DIR;
const output = process.env.PI_HOOK_TEST_OUTPUT;
const stopOutput = process.env.PI_HOOK_TEST_STOP_OUTPUT;
const command = `cat > "$PI_HOOK_TEST_OUTPUT"`;
const stopCommand = `cat > "$PI_HOOK_TEST_STOP_OUTPUT"`;
fs.writeFileSync(path.join(dir, "hooks.json"), JSON.stringify({
  session_before_compact: [{ hooks: [{ type: "command", command }] }],
  session_compact: [{ hooks: [{ type: "command", command }] }],
  session_compact_failed: [{ hooks: [{ type: "command", command }] }],
  notification: [{ hooks: [{ type: "command", command }] }],
  agent_settled: [{ hooks: [{ type: "command", command: stopCommand }] }],
}));
const handlers = {};
hooks({ on: (event, handler) => { handlers[event] = handler; } });
const ctx = { cwd: "/tmp/hook-test", sessionManager: { getSessionId: () => "session-test" } };
let passed = 0;
const check = (condition, message) => {
  if (!condition) throw new Error(message);
  passed++;
};
const readPayload = (file = output) => JSON.parse(fs.readFileSync(file, "utf8"));
const invoke = async (event, value) => {
  fs.rmSync(event === "agent_settled" ? stopOutput : output, { force: true });
  await handlers[event](value, ctx);
  return readPayload(event === "agent_settled" ? stopOutput : output);
};

(async () => {
  let payload = await invoke("session_before_compact", {
    reason: "threshold", willRetry: false, branchEntries: [],
    preparation: { firstKeptEntryId: "entry-1", isSplitTurn: false, tokensBefore: 100, fileOps: [] },
    customInstructions: undefined,
  });
  check(payload.claude_event_name === "PreCompact", "PreCompact event name");
  check(payload.equivalence === "closest_pi_lifecycle_equivalent", "PreCompact equivalence");

  payload = await invoke("session_compact", {
    reason: "threshold", willRetry: false, fromExtension: false,
    compactionEntry: { summary: "summary" },
  });
  check(payload.claude_event_name === "PostCompact", "PostCompact event name");
  check(payload.equivalence === "closest_pi_lifecycle_equivalent", "PostCompact equivalence");

  payload = await invoke("session_compact_failed", {
    reason: "error", aborted: true, willRetry: true, fromExtension: false,
    errorMessage: "compact failed",
  });
  check(payload.claude_event_name === "PostCompact", "failed PostCompact event name");
  check(payload.equivalence === "closest_pi_lifecycle_equivalent", "failed PostCompact equivalence");

  payload = await invoke("ui_prompt_start", { kind: "user", title: "Prompt" });
  check(payload.claude_event_name === "Notification", "waiting Notification event name");
  check(payload.notification_type === "waiting", "waiting notification type");
  check(payload.equivalence === "normalized_pi_lifecycle_adapter", "waiting equivalence");

  payload = await invoke("ui_prompt_end", { kind: "user", title: "Prompt" });
  check(payload.claude_event_name === "Notification", "ready Notification event name");
  check(payload.notification_type === "ready", "ready notification type");
  check(payload.equivalence === "normalized_pi_lifecycle_adapter", "ready equivalence");

  payload = await invoke("agent_settled", {});
  check(payload.claude_event_name === "Stop", "Stop event name");
  check(payload.equivalence === "composed_pi_lifecycle_adapter", "Stop equivalence");

  console.log(`${passed} passed, 0 failed`);
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
NODE
