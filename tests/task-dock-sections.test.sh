#!/usr/bin/env bash
# The dock groups rows by source: bg tasks first (Ctrl+Alt+B), then subagent tasks (Ctrl+Alt+I).
# Each section has one header and its own rows. The drawn line count must equal dockRowCount(),
# because the subagent monitor reserves footer rows from that count.
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
  on(name, handler) { handlers.set(name, handler); },
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
    setWidget(key, content, options) { widgets.set(key, { content, options }); },
    setStatus() {},
    notify() {},
    theme: { fg: (_c, text) => text },
  },
  isIdle: () => true,
  sessionManager: { getEntries: () => [], getSessionId: () => "s" },
};

dock.default(pi);
handlers.get("session_start")({ type: "session_start" }, ctx);

const theme = { fg: (_c, text) => text };
// Read the dock's own renderer (the same entry core-invariants uses), not the fake UI fixture.
const draw = () => dock.__test.renderLines(theme, 200);

// Both sections: one bg task and one subagent task.
dock.upsertTask(ctx, "bg:sec1", { source: "bg", label: "build", state: "running", startedAt: Date.now() - 5000 });
dock.upsertTask(ctx, "sub:sec1", { source: "delegate", label: "review", state: "running", startedAt: Date.now() - 3000 });

const both = draw();
assert.equal(both[0], "bg tasks · Ctrl+Alt+B", `bg header comes first with its key, got: ${both[0]}`);
const subHeader = both.findIndex((line) => line === "subagent tasks · Ctrl+Alt+I");
assert.ok(subHeader > 0, `subagent header carries its own key, got:\n${both.join("\n")}`);
assert.ok(subHeader > 1, "the subagent header comes after the bg rows");
assert.ok(both[1].includes("build"), `the bg row sits under the bg header, got: ${both[1]}`);
assert.ok(both[subHeader + 1].includes("review"), "the subagent row sits under its header");
assert.equal(both.length, dock.dockRowCount(), `drawn lines ${both.length} must equal dockRowCount() ${dock.dockRowCount()}`);

// Only subagent: the bg header disappears, the subagent header stays.
// Drop the bg row explicitly: a finished row would otherwise linger for DONE_LINGER_MS.
dock.removeTask("bg:sec1");
const subOnly = draw();
assert.ok(!subOnly.some((line) => line.startsWith("bg tasks")), "no bg header when there are no bg rows");
assert.equal(subOnly[0], "subagent tasks · Ctrl+Alt+I", `subagent-only dock opens on its header, got: ${subOnly[0]}`);
assert.equal(subOnly.length, dock.dockRowCount(), "subagent-only line count matches dockRowCount()");

// Nothing running: the whole dock goes away.
dock.removeTask("sub:sec1");
assert.equal(dock.dockRowCount(), 0, "no rows means zero reserved footer rows");
assert.equal(draw().length, 0, "no rows draws no dock");

console.log("task dock sections: ok");
NODE
