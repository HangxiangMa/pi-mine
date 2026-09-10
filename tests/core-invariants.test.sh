#!/usr/bin/env bash
# Contract-level coverage for guard, carry, task-dock ownership, and replan policy.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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
printf 'exports.getAgentDir=()=>process.env.PI_CORE_INVARIANTS_DIR; exports.CONFIG_DIR_NAME=".pi"; exports.getMarkdownTheme=()=>({}); exports.withFileMutationQueue=async (_key, fn)=>fn();\n' > "$tmp/shim.cjs"
export PI_CORE_INVARIANTS_DIR="$tmp"
export PI_CORE_INVARIANTS_SHIM="$tmp/shim.cjs"

node - "$jiti" \
  "$here/../extensions/read-guard.ts" \
  "$here/../extensions/session-invariants.ts" \
  "$here/../extensions/subagent/index.ts" \
  "$here/../extensions/task-dock.ts" \
  "$here/../../billion-context-pi/src/fleet-widget.ts" \
  <<'NODE'
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const jiti = require(process.argv[2])(process.cwd(), { interopDefault: true, alias: {
  "@earendil-works/pi-coding-agent": process.env.PI_CORE_INVARIANTS_SHIM,
}});
const readGuard = jiti(process.argv[3]);
const invariants = jiti(process.argv[4]);
const subagent = jiti(process.argv[5]);
const taskDockSource = fs.readFileSync(process.argv[6], "utf8");
const fleetSource = fs.readFileSync(process.argv[7], "utf8");
let passed = 0;
const check = (condition, message) => {
  if (!condition) throw new Error(message);
  passed++;
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-core-invariants-"));
try {
  const small = path.join(tmp, "small.txt");
  const big = path.join(tmp, "big.txt");
  fs.writeFileSync(small, "ok");
  fs.writeFileSync(big, "x".repeat(readGuard.BIG_FILE_BYTES + 1));
  check(readGuard.readGuardReason("bash", { path: big }) === undefined, "non-read tool is ignored");
  check(readGuard.readGuardReason("read", { path: small }) === undefined, "small read is allowed");
  check(readGuard.readGuardReason("read", { path: big })?.includes("Pass limit") === true, "large unbounded read is blocked");
  check(readGuard.readGuardReason("read", { path: big, limit: 100 }) === undefined, "bounded large read is allowed");
  check(readGuard.readGuardReason("read", { path: `${tmp}/image.png` }) === undefined, "binary read is allowed");
  const resultDir = path.join(tmp, "123e4567-e89b-12d3-a456-426614174000", "tool-results");
  fs.mkdirSync(resultDir, { recursive: true });
  const resultFile = path.join(resultDir, "output.txt");
  fs.writeFileSync(resultFile, "x".repeat(readGuard.TOOL_RESULT_BYTES + 1));
  check(readGuard.readGuardReason("read", { path: resultFile })?.includes("offloaded tool output") === true, "offloaded result is guarded");

  check(invariants.__test.safeSessionId("a/b") === "a_b", "session id is filesystem-safe");
  const edited = path.join(tmp, "edited.ts");
  const read = path.join(tmp, "read.ts");
  fs.writeFileSync(edited, "export const edited = true;\n");
  fs.writeFileSync(read, "export const read = true;\n");
  const state = invariants.__test.extractFiles([
    { type: "message", message: { content: [
      { type: "toolCall", name: "read", arguments: { path: read } },
      { type: "toolCall", name: "edit", arguments: { file_path: edited } },
    ] } },
  ], tmp);
  check(state.edited.includes("edited.ts"), "carry records edited files");
  check(!state.read.includes("edited.ts"), "edited file is removed from read set");
  check(state.read.includes("read.ts"), "carry preserves independently read files");

  const failedExecute = { exitCode: 1, stopReason: "error", verificationStatus: undefined, needsReplan: false };
  const partialExecute = { exitCode: 0, stopReason: "end", verificationStatus: "partial", needsReplan: false };
  const failedReason = { exitCode: 1, stopReason: "error", verificationStatus: undefined, needsReplan: false };
  const execute = { phase: "execute" };
  const reason = { phase: "reason" };
  check(subagent.__test.isFailedResult(partialExecute), "partial remains a failed stop/report result");
  check(!subagent.__test.shouldReplan(partialExecute, execute), "partial does not trigger replan");
  check(subagent.__test.shouldReplan(failedExecute, execute), "execute failure triggers replan");
  check(!subagent.__test.shouldReplan(failedReason, reason), "reason failure does not trigger replan");
  check(subagent.__test.parseNeedsReplan("NEEDS_REPLAN: true"), "explicit replan marker parses");
  check(subagent.__test.shouldReplan({ ...failedReason, needsReplan: true }, reason), "explicit marker can replan outside execute phase");

  check(taskDockSource.includes('const WIDGET_OPTIONS = { placement: "aboveEditor" }'), "task dock owns above-editor placement");
  check(taskDockSource.includes("const bgFinalized = new Set<string>()"), "background terminal ids are finalized");
  check(taskDockSource.includes("bgFinalized.has(task.id) && !registry.has(id)"), "completed background rows cannot resurrect");
  check(taskDockSource.includes('shortcutHints.add("Shift↓")'), "background task shortcut hint is rendered");
  check(taskDockSource.includes('shortcutHints.add("Ctrl+Alt+I")'), "subagent shortcut hint is rendered");
  check(taskDockSource.includes("widgetRequestRender?.()"), "task dock refreshes without re-registering widget");
  check(taskDockSource.includes("ctx.ui.setWidget("), "task dock owns widget registration");
  check(!fleetSource.includes("setWidget("), "fleet bridge no longer registers a competing widget");
  check(fleetSource.includes("billion-context-pi:delegate:v1"), "fleet bridge remains published");

  console.log(`${passed} passed, 0 failed`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
NODE
