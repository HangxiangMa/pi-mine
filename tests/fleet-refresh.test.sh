#!/usr/bin/env bash
# Regression: the subagent monitor's footer reserve must follow the dock while the monitor is
# open. Drives the real openSubagentFleetInspector() with a fake ctx.ui.custom, so the real
# SubagentFleetComponent, its 500 ms refresh timer, and pi-tui's overlay options object are all
# exercised. Changes the dock row count and waits for real ticks. The render checks at the end
# cover the output window, the overflow fit, SGR colour, and row width under a real theme.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/pi-jiti.sh
source "$here/lib/pi-jiti.sh"
locate_pi_jiti || exit 1

node - "$PI_JITI" \
  "$here/../extensions/subagent/fleet-inspector.ts" \
  "$here/../extensions/task-dock.ts" \
  "$PI_TUI" \
  <<'NODE'
const jiti = require(process.argv[2])(process.cwd(), { interopDefault: true });
const fleet = jiti(process.argv[3]);
const dock = jiti(process.argv[4]);
const piTui = jiti(`${process.argv[5]}/dist/index.js`);

let passed = 0;
const check = (condition, message) => {
  if (!condition) throw new Error(message);
  passed++;
};

// Dock rows come from a provider; each call swaps the list the dock reads.
let runs = [];
const off = dock.registerTaskDockProvider(() => runs);
const mkRun = (i) => ({ id: `refresh-${i}`, source: "routed", label: `run ${i}`, state: "done", startedAt: 3000 + i });

// A fake ctx that runs the real factory and hands back the overlay options object pi-tui would
// hold by reference. Only the members the monitor touches are provided.
let liveOptions;
let component;
let closed = false;
const ctx = {
  hasUI: true,
  ui: {
    notify() {},
    custom(factory, opts) {
      liveOptions = opts.overlayOptions;
      const tui = {
        terminal: { rows: 24, columns: 100 },
        requestRender() {},
      };
      const theme = { fg: (_c, text) => text, bold: (text) => text };
      return new Promise((resolve) => {
        const done = () => {
          closed = true;
          resolve(undefined);
        };
        Promise.resolve(factory(tui, theme, { matches: () => false }, done)).then((c) => {
          component = c;
        });
      });
    },
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitForClose = (opened) =>
  Promise.race([
    opened,
    new Promise((_, reject) => setTimeout(() => reject(new Error("monitor did not close")), 5000)),
  ]);
const snapshot = () => [];

(async () => {
  // Open the real monitor. Do not await: it resolves only when the monitor closes.
  const opened = fleet.openSubagentFleetInspector(ctx, snapshot, {});

  await sleep(50);
  check(liveOptions !== undefined, "monitor passes one live overlay options object to ui.custom");
  check(component !== undefined, "monitor builds its component through the factory");

  // Dock empty: the reserve is chrome plus zero dock rows.
  runs = [];
  await sleep(700); // > one 500 ms refresh tick
  const emptyBottom = liveOptions.margin.bottom;
  const emptyMax = liveOptions.maxHeight;

  // Dock with six rows: the reserve must grow, through the same object, on the next tick.
  runs = Array.from({ length: 6 }, (_, i) => mkRun(i));
  await sleep(700);
  const fullBottom = liveOptions.margin.bottom;
  const fullMax = liveOptions.maxHeight;

  check(
    fullBottom === fleet.FOOTER_CHROME_ROWS + dock.dockRowCount(),
    `reserve tracks the dock on refresh: bottom ${fullBottom} must equal chrome ${fleet.FOOTER_CHROME_ROWS} + dock rows`,
  );
  check(fullBottom > emptyBottom, `reserve grows when the dock fills (${emptyBottom} empty, ${fullBottom} full)`);
  check(fullMax < emptyMax, `monitor shrinks when the dock fills (${emptyMax} empty, ${fullMax} full)`);

  // Close through the real path so the refresh timer is cleared.
  component.handleInput("q");
  await waitForClose(opened);
  check(closed, "monitor closes through its own done() path");

  // Regression case: emptySnapshotQClosesMonitor.
  closed = false;
  const emptyOpened = fleet.openSubagentFleetInspector(ctx, () => [], {});
  await sleep(50);
  check(component !== undefined, "empty snapshot regression builds the monitor");
  component.handleInput("q");
  await waitForClose(emptyOpened);
  check(closed, "empty snapshot q calls done() and closes the monitor");

  // Render checks. Each frame comes from the real component over a snapshot of runs. The overlay
  // height is set on the live options object, and render() runs in the same tick, so the refresh
  // timer cannot resize the frame in between.
  const palette = { accent: 208, border: 240, error: 196, muted: 244, success: 40, warning: 214, dim: 242 };
  const plainTheme = { bold: (text) => text, fg: (_c, text) => text };
  const colorTheme = {
    bold: (text) => `\x1b[1m${text}\x1b[22m`,
    fg: (color, text) => `\x1b[38;5;${palette[color] ?? 250}m${text}\x1b[39m`,
  };
  const mkSubagentRun = (id, output, extra = {}) => ({
    id,
    agent: "worker",
    task: "example task",
    status: "running",
    startedAt: Date.now() - 5000,
    output,
    stderr: "",
    inputTokens: 0,
    outputTokens: 0,
    ...extra,
  });
  const outputLines = (count) =>
    Array.from({ length: count }, (_, i) => `line ${String(i + 1).padStart(2, "0")}`).join("\n");
  const frameAt = async (snapshotRuns, maxHeight, width, theme, actions = {}) => {
    let monitor;
    let monitorOptions;
    const monitorCtx = {
      hasUI: true,
      ui: {
        notify() {},
        custom(factory, opts) {
          monitorOptions = opts.overlayOptions;
          const tui = { terminal: { rows: 50, columns: 120 }, requestRender() {} };
          return new Promise((resolve) => {
            const done = () => resolve(undefined);
            Promise.resolve(factory(tui, theme, { matches: () => false }, done)).then((c) => {
              monitor = c;
            });
          });
        },
      },
    };
    const opened = fleet.openSubagentFleetInspector(monitorCtx, () => snapshotRuns, actions);
    await sleep(10);
    monitorOptions.maxHeight = maxHeight;
    const lines = monitor.render(width);
    monitor.handleInput("q");
    await waitForClose(opened);
    return lines;
  };

  // Output window: 40 rows less the title, hint, one run row, four detail rows, and two footer rows
  // leaves 29 output rows, and they are the newest.
  const tall = await frameAt([mkSubagentRun("win", outputLines(40))], 40, 80, plainTheme);
  check(tall.length === 40, `frame is exactly maxHeight rows (${tall.length})`);
  check(
    tall.filter((line) => /line \d\d/.test(line)).length === 29,
    "output window is the height left after the fixed rows, not a fixed ten rows",
  );
  check(
    tall.some((line) => line.includes("line 40")) && !tall.some((line) => line.includes("line 11")),
    "output window keeps the newest lines",
  );

  // A body that fits is returned untrimmed.
  const fits = await frameAt([mkSubagentRun("fit", outputLines(3))], 40, 80, plainTheme);
  check(
    fits.length === 14 && fits.some((line) => line.includes("Selected:")) && fits.some((line) => line.includes("line 03")),
    "a body that fits is returned untrimmed",
  );

  // Overflow: title, key hint, and list rows stay, the footer stays last, and details go first.
  const six = Array.from({ length: 6 }, (_, i) =>
    mkSubagentRun(`six-${i}`, outputLines(5), { agent: `agent${i}`, status: "completed", finishedAt: Date.now() }),
  );
  const cut = await frameAt(six, 14, 80, plainTheme, { initialRunId: "six-5" });
  check(cut.length === 14, `overflowing frame still fits maxHeight (${cut.length} rows)`);
  check(cut[cut.length - 2].includes("↑↓ move"), "footer hint stays the last body row");
  check(
    cut.some((line) => line.includes("Subagent monitor · 6 run(s)")) &&
      cut.some((line) => line.includes("Esc / q close this monitor")) &&
      six.every((_, i) => cut.some((line) => line.includes(`agent${i}`))),
    "title, key hint, and every list row survive the overflow",
  );
  check(!cut.some((line) => line.includes("Selected:")), "detail rows are trimmed before the head");

  // A list too tall for the frame is windowed around the selected run; the footer still holds.
  const many = Array.from({ length: 12 }, (_, i) =>
    mkSubagentRun(`many-${i}`, "", { agent: `agent${i}`, status: "completed", finishedAt: Date.now() }),
  );
  const windowed = await frameAt(many, 12, 80, plainTheme, { initialRunId: "many-11" });
  check(
    windowed.length === 12 &&
      windowed.some((line) => line.includes("agent11")) &&
      !windowed.some((line) => line.includes("agent0")),
    "a list too tall for the frame is windowed around the selected run",
  );
  check(windowed[windowed.length - 2].includes("↑↓ move"), "footer hint survives a windowed list");

  // Real theme: fg() wraps text in ESC[38;5;Nm ... ESC[39m. Child SGR colour survives, other control
  // sequences are dropped, and every coloured row still measures exactly the frame width.
  const noisy = mkSubagentRun(
    "noisy",
    `plain \x1b[31mred\x1b[0m tail\n\x1b]0;window title\x07title-line\n\x1b[2Kerase-line\n\x1b[?25lcursor-line\n${"x".repeat(60)}END`,
  );
  const painted = await frameAt([noisy], 30, 40, colorTheme);
  const joined = painted.join("\n");
  check(joined.includes("\x1b[38;5;244m") && joined.includes("\x1b[39m"), "the real theme's fg() codes reach the frame");
  check(joined.includes("\x1b[31mred\x1b[0m"), "child SGR colour survives into the output rows");
  check(!/window title|\x1b\]0;|\x1b\[2K|\x1b\[\?25l/.test(joined), "other control sequences are stripped from child output");
  check(painted.every((line) => piTui.visibleWidth(line) === 40), "every coloured row measures exactly the frame width");
  check(!joined.includes("END"), "a long coloured output row is cut at the frame width");

  off();
  console.log(`${passed} passed, 0 failed`);
})().catch((error) => {
  off();
  console.error(error);
  process.exit(1);
});
NODE
