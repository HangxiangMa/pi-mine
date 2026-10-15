#!/usr/bin/env bash
# Contract-level coverage for guard, carry, task-dock ownership, and replan policy.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Locate pi's bundled jiti. A missing piece is NOT RUN and exits non-zero: a suite
# that cannot load the code under test has checked nothing, so it must not pass.
# See tests/lib/pi-jiti.sh for the layouts probed.
# shellcheck source=lib/pi-jiti.sh
source "$here/lib/pi-jiti.sh"
locate_pi_jiti || exit 1

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
printf 'exports.getAgentDir=()=>process.env.PI_CORE_INVARIANTS_DIR; exports.CONFIG_DIR_NAME=".pi"; exports.getMarkdownTheme=()=>({}); exports.withFileMutationQueue=async (_key, fn)=>fn();\n' > "$tmp/shim.cjs"
export PI_CORE_INVARIANTS_DIR="$tmp"
export PI_CORE_INVARIANTS_SHIM="$tmp/shim.cjs"

node - "$PI_JITI" \
  "$here/../extensions/read-guard.ts" \
  "$here/../extensions/session-invariants.ts" \
  "$here/../extensions/subagent/index.ts" \
  "$here/../extensions/task-dock.ts" \
  "$here/../extensions/subagent/fleet-inspector.ts" \
  "$here/../../billion-context-pi/src/fleet-widget.ts" \
  "$here/../../pi-extensions/packages/pi-progress/src/progress-widget.ts" \
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
const fleetInspectorSource = fs.readFileSync(process.argv[7], "utf8");
const fleetSource = fs.readFileSync(process.argv[8], "utf8");
const progressSource = fs.readFileSync(process.argv[9], "utf8");
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
  const chain = [
    { agent: "planner", phase: "reason" },
    { agent: "executor", phase: "execute" },
    { agent: "planner", phase: "reason" },
    { agent: "verifier", phase: "verify" },
  ];
  check(subagent.__test.findReplanReasonStep(chain, 1) === chain[0], "replan uses prior reason step");
  check(subagent.__test.findReplanReasonStep(chain, 3) === chain[2], "replan uses nearest prior reason step");
  check(subagent.__test.findReplanReasonStep(chain, 0) === undefined, "replan does not use future reason step");
  check(
    subagent.__test.fallbackNotice({ routerFallbackFromModel: "breeze/opus", model: "breeze/sonnet" }) ===
      "[router fallback] requested breeze/opus; executed breeze/sonnet",
    "fallback notice exposes requested and executed models",
  );
  check(subagent.__test.isQuotaMessage("HTTP 429 Too Many Requests"), "HTTP 429 is quota-like");
  check(subagent.__test.isQuotaMessage("quota exceeded"), "quota exceeded is quota-like");
  check(!subagent.__test.isQuotaMessage("line 429"), "bare 429 text is not quota-like");
  check(!subagent.__test.isQuotaMessage("token budget exceeded"), "token budget text is not quota-like");

  check(taskDockSource.includes('const WIDGET_OPTIONS = { placement: "belowEditor" }'), "task dock owns below-editor placement");
  check(taskDockSource.includes("const bgFinalized = new Set<string>()"), "background terminal ids are finalized");
  check(taskDockSource.includes("bgFinalized.has(task.id) && !registry.has(id)"), "completed background rows cannot resurrect");
  check(taskDockSource.includes('shortcutHints.add("Shift↓")'), "background task shortcut hint is rendered");
  check(taskDockSource.includes('shortcutHints.add("Ctrl+Alt+I")'), "subagent shortcut hint is rendered");
  check(taskDockSource.includes("widgetRequestRender?.()"), "task dock refreshes without re-registering widget");
  check(taskDockSource.includes("first state transition is visible immediately"), "task dock invalidates after initial widget registration");
  check(taskDockSource.includes("ctx.ui.setWidget("), "task dock owns widget registration");
  check(fleetInspectorSource.includes("handle.focus()"), "inspector owns input focus");
  check(fleetInspectorSource.includes("function frame("), "inspector frames its floating panel");
  check(
    fleetInspectorSource.includes("overlayOptions:") && fleetInspectorSource.includes("monitorOverlayOptions("),
    "inspector sizes its floating panel from the viewport",
  );
  check(fleetInspectorSource.includes("activeInspectorClose"), "inspector shortcut can close the focused overlay");
  // The monitor's last frame row must stay above the footer's first row. The footer bound is an
  // independent literal, not read from FOOTER_CHROME_ROWS: reading it from the constant under
  // test made this check a tautology (shrinking the reserve shrank both sides, so it never failed).
  // Upper bound = Working, blank, separator, Tasks, optional Sub-agents, 6 dock rows, optional
  // "+K more", status, AICP (task-dock.ts render).
  const fleetInspector = jiti(process.argv[7]);
  const dock = jiti(process.argv[6]);
  const FOOTER_MAX_ROWS = 1 + 1 + 1 + 1 + 1 + 6 + 1 + 1 + 1;
  // The footer reserve is now dynamic, so check the bound at the largest footer it can ever be
  // (the independent literal above), not at a constant that could shrink with it.
  for (const [cols, rows] of [[160, 50], [100, 24]]) {
    const o = fleetInspector.monitorOverlayOptions(cols, rows, FOOTER_MAX_ROWS);
    const frameLastRow = rows - o.margin.bottom; // pi-tui clamps the frame to end at or before this row
    const footerFirstRow = rows - FOOTER_MAX_ROWS + 1;
    check(
      frameLastRow < footerFirstRow,
      `monitor ${cols}x${rows} must end above the ${FOOTER_MAX_ROWS}-row footer (last ${frameLastRow}, footer starts ${footerFirstRow})`,
    );
  }
  // The reserve must follow the footer it is given. A fixed reserve passes the bound above and
  // still fails here, which is the regression this change exists to prevent.
  {
    const small = fleetInspector.monitorOverlayOptions(160, 50, 7);
    const large = fleetInspector.monitorOverlayOptions(160, 50, 12);
    check(small.margin.bottom === 7 && large.margin.bottom === 12, `footer reserve follows the dock: got ${small.margin.bottom} and ${large.margin.bottom}`);
    check(large.maxHeight < small.maxHeight, "a taller dock shortens the monitor");
  }
  // footerRowsNow() must follow the dock, not a constant. Read it at two dock sizes so a frozen
  // value cannot pass: it must equal chrome + the live dock count at each size, and move between them.
  {
    const mkRun = (i) => ({ id: `fr-${i}`, source: "routed", label: `run ${i}`, state: "done", startedAt: 2000 + i });
    const readAt = (n) => {
      const runs = Array.from({ length: n }, (_, i) => mkRun(i));
      const off = dock.registerTaskDockProvider(() => runs);
      const footer = fleetInspector.footerRowsNow();
      const chrome = fleetInspector.FOOTER_CHROME_ROWS;
      const counted = dock.dockRowCount();
      off();
      return { footer, chrome, counted };
    };
    const small = readAt(0);
    const large = readAt(6);
    check(
      small.footer === small.chrome + small.counted && large.footer === large.chrome + large.counted,
      `footerRowsNow() must equal chrome + dock rows (got ${small.footer}=${small.chrome}+${small.counted}, ${large.footer}=${large.chrome}+${large.counted})`,
    );
    check(large.footer > small.footer, `footer reserve grows with the dock (${small.footer} empty, ${large.footer} with six runs)`);
  }
  // dockRowCount() must equal the lines the real render() draws for every dock shape, so the
  // monitor's reserve cannot drift from the dock. Covers empty, one, the cap, and past the cap.
  // Sub-agent usage-only rows are not covered here (that state is module-private).
  {
    const theme = { fg: (_c, text) => text };
    const mkRun = (i) => ({ id: `dock-${i}`, source: "routed", label: `run ${i}`, state: "done", startedAt: 1000 + i });
    const shapes = [0, 1, 6, 7, 9];
    for (const n of shapes) {
      const runs = Array.from({ length: n }, (_, i) => mkRun(i));
      const off = dock.registerTaskDockProvider(() => runs);
      const drawn = dock.__test.renderLines(theme, 120).length;
      const counted = dock.dockRowCount();
      off();
      check(counted === drawn, `dockRowCount() ${counted} must equal rendered dock lines ${drawn} for ${n} run(s)`);
    }
  }
  check(fleetInspectorSource.includes("taskTitle(run.task)"), "inspector renders task titles instead of prompts");
  check(!fleetInspectorSource.includes("Task: ${selected.task}"), "inspector does not render raw selected prompts");
  check(fleetSource.includes('const BRIDGE_CHANNEL = "billion-context-pi:delegate:v1"'), "fleet publishes the task-dock bridge");
  check(fleetSource.includes("fleetShortcut"), "fleet publishes its shortcut for the task dock");
  check(taskDockSource.includes("taskTitle(run.task)"), "task dock renders delegate task titles instead of prompts");
  check(taskDockSource.includes("const TASK_SUMMARY_MAX = 48"), "task dock caps preview titles");
  check(progressSource.includes('const WIDGET_OPTIONS = { placement: "aboveEditor" }'), "progress widget uses above-editor placement");
  check(progressSource.includes('ctx.ui.setWidget(WIDGET_KEY,'), "progress widget owns widget registration");
  check(progressSource.includes("completionSummaryHidden"), "progress widget manages completion visibility");
  check(fleetSource.includes("export const delegateStatusWidget"), "delegate status widget remains exported");

  console.log(`${passed} passed, 0 failed`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
NODE
