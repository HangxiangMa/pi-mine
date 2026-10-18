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
  "$here/../extensions/grouped-picker/picker-busy.ts" \
  "$PI_TUI" \
  <<'NODE'
const jiti = require(process.argv[2])(process.cwd(), { interopDefault: true });
const fleet = jiti(process.argv[3]);
const dock = jiti(process.argv[4]);
const pickerBusy = jiti(process.argv[5]);
const piTui = jiti(`${process.argv[6]}/dist/index.js`);

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
let activeRuns = [];
const snapshot = () => activeRuns;

(async () => {
  const pickerBusyBeforeOpen = pickerBusy.isPickerBusy();
  check(!pickerBusyBeforeOpen, "picker is idle before the monitor opens");
  // Open the real monitor. Do not await: it resolves only when the monitor closes.
  const opened = fleet.openSubagentFleetInspector(ctx, snapshot, {});

  await sleep(50);
  check(liveOptions !== undefined, "monitor passes one live overlay options object to ui.custom");
  check(component !== undefined, "monitor builds its component through the factory");
  const busyWhileOpen = pickerBusy.isPickerBusy();
  check(busyWhileOpen, "picker is busy while the monitor is open");

  const fifty = fleet.monitorOverlayOptions(50, 50, fleet.FOOTER_CHROME_ROWS);
  const effectiveWidth = Math.floor(50 * Number.parseFloat(fifty.width) / 100);
  check(fifty.width === "80%", `50-column overlay width is 80% (${fifty.width})`);
  check(fifty.maxHeight === "80%", `overlay maxHeight is 80% (${fifty.maxHeight})`);
  check(effectiveWidth === 40, `50-column effective floor width is 40 (${effectiveWidth})`);
  check(
    typeof fifty.capRows === "number" && fifty.capRows === Math.floor(50 * 0.8) - 2,
    `50-row capRows is floor(rows * 0.8) - 2 (${fifty.capRows})`,
  );

  // Dock empty: the reserve is pi chrome only; dock rows may be covered.
  runs = [];
  await sleep(700); // > one 500 ms refresh tick
  const emptyBottom = liveOptions.margin.bottom;
  const emptyMax = liveOptions.capRows;

  // Dock with six rows: the reserve stays fixed through the same object on the next tick.
  runs = Array.from({ length: 6 }, (_, i) => mkRun(i));
  await sleep(700);
  const fullBottom = liveOptions.margin.bottom;
  const fullMax = liveOptions.capRows;

  check(
    emptyBottom === fleet.FOOTER_CHROME_ROWS && fullBottom === fleet.FOOTER_CHROME_ROWS,
    `reserve stays at pi chrome on refresh: bottom ${emptyBottom}/${fullBottom}, chrome ${fleet.FOOTER_CHROME_ROWS}`,
  );
  check(fullBottom === emptyBottom, `reserve is unchanged when the dock fills (${emptyBottom} empty, ${fullBottom} full)`);
  check(fullMax === emptyMax, `monitor height is unchanged when the dock fills (${emptyMax} empty, ${fullMax} full)`);

  // Close through the real path so the refresh timer is cleared.
  component.handleInput("\u0011");
  await waitForClose(opened);
  check(closed, "monitor closes through its own done() path");
  check(!pickerBusy.isPickerBusy(), "picker is idle after the monitor closes");
  check(
    pickerBusy.isPickerBusy() === pickerBusyBeforeOpen,
    "closing through done() restores the picker busy counter",
  );

  // Regression case: emptySnapshotQClosesMonitor.
  closed = false;
  const emptyOpened = fleet.openSubagentFleetInspector(ctx, () => [], {});
  await sleep(50);
  check(component !== undefined, "empty snapshot regression builds the monitor");
  component.handleInput("\u0011");
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

  const openInputCase = async (snapshotRuns, actions = {}, initialRunId) => {
    activeRuns = snapshotRuns;
    closed = false;
    component = undefined;
    const pending = fleet.openSubagentFleetInspector(ctx, snapshot, { ...actions, initialRunId });
    await sleep(20);
    check(component !== undefined, "real component opens for input case");
    return { pending };
  };
  const closeWithCtrlQ = async (pending) => {
    component.handleInput("\u0011");
    await waitForClose(pending);
  };

  // Case 1: printable p is input, not a mode switch.
  {
    const calls = [];
    const { pending } = await openInputCase([mkSubagentRun("case-1", "ready")], {
      guide: (runId, text) => calls.push([runId, text]),
    });
    component.handleInput("p");
    check(component.render(100).join("\n").includes("> p"), "p is typed into the always-focused input");
    component.handleInput("\r");
    await sleep(0);
    check(calls.length === 1 && calls[0][0] === "case-1" && calls[0][1] === "p", "Enter guides the typed p as input");
    await closeWithCtrlQ(pending);
  }

  // Case 2: an empty running input cancels the fixed id once and does not close.
  {
    const cancelled = [];
    const { pending } = await openInputCase([mkSubagentRun("case-2", "ready")], {
      cancel: (runId) => cancelled.push(runId),
    }, "case-2");
    component.handleInput("\x1b");
    check(cancelled.join() === "case-2" && !closed, "empty Esc cancels the bound running id without closing");
    await closeWithCtrlQ(pending);
  }

  // Case 3: nonempty Esc clears only; it neither cancels nor closes.
  {
    const cancelled = [];
    const { pending } = await openInputCase([mkSubagentRun("case-3", "ready")], {
      cancel: (runId) => cancelled.push(runId),
    }, "case-3");
    component.handleInput("x");
    check(component.render(100).join("\n").includes("> x"), "input contains text before Esc");
    component.handleInput("\x1b");
    check(!component.render(100).join("\n").includes("> x") && cancelled.length === 0 && !closed, "nonempty Esc clears only");
    await closeWithCtrlQ(pending);
  }

  // Case 4: a second empty Esc does not close; only ctrl+q closes the component.
  {
    const cancelled = [];
    const { pending } = await openInputCase([mkSubagentRun("case-4", "ready")], {
      cancel: (runId) => cancelled.push(runId),
    }, "case-4");
    component.handleInput("\x1b");
    check(!closed && cancelled.join() === "case-4", "first empty Esc only cancels");
    component.handleInput("\x1b");
    check(!closed && cancelled.length === 1, "second Esc does not close or recancel");
    await closeWithCtrlQ(pending);
  }

  // Case 5: one empty Esc on a non-running run is a no-op.
  {
    const cancelled = [];
    const { pending } = await openInputCase([mkSubagentRun("case-5", "done", { status: "completed", finishedAt: Date.now() })], {
      cancel: (runId) => cancelled.push(runId),
    }, "case-5");
    component.handleInput("\x1b");
    check(!closed && cancelled.length === 0, "empty Esc on a non-running run is a no-op");
    await closeWithCtrlQ(pending);
  }

  // Case 6: multiple snapshot runs cannot replace the fixed initial run; disappearance retains it.
  {
    const first = mkSubagentRun("case-6-first", "first", { agent: "first-agent" });
    const second = mkSubagentRun("case-6-bound", "bound", { agent: "bound-agent" });
    const { pending } = await openInputCase([first, second], {}, "case-6-bound");
    check(component.render(100).join("\n").split("\n").filter((line) => line.includes("│› ")).length === 1, "multiple runs produce one run row");
    activeRuns = [first];
    const ended = component.render(100).join("\n");
    check(ended.includes("Run ended") && ended.includes("case-6-bound") && ended.includes("bound-agent") && !ended.includes("first-agent"), "vanished bound run keeps last-known fields");
    await closeWithCtrlQ(pending);
  }

  // Case 7: ctrl+q closes even when the input is nonempty; q remains ordinary input.
  {
    const { pending } = await openInputCase([mkSubagentRun("case-7", "ready")], {}, "case-7");
    component.handleInput("q");
    check(component.render(100).join("\n").includes("> q"), "q is ordinary input");
    component.handleInput("text");
    component.handleInput("\u0011");
    await waitForClose(pending);
    check(closed, "ctrl+q closes with text in the input");
  }

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
    monitorOptions.capRows = maxHeight - 2;
    const lines = monitor.render(width);
    monitor.handleInput("\u0011");
    await waitForClose(opened);
    return lines;
  };

  // Output window: 40 rows less the title, one run row, four detail rows, and two footer rows
  // leaves 30 output rows, and they are the newest.
  const tall = await frameAt([mkSubagentRun("win", outputLines(40))], 40, 80, plainTheme);
  check(tall.length === 40, `frame is exactly maxHeight rows (${tall.length})`);
  check(
    tall.filter((line) => /line \d\d/.test(line)).length === 30,
    "output window is the height left after the fixed rows, not a fixed ten rows",
  );
  check(
    tall.some((line) => line.includes("line 40")) && !tall.some((line) => line.includes("line 10")),
    "output window keeps the newest lines",
  );

  // A body that fits is returned untrimmed.
  const fits = await frameAt([mkSubagentRun("fit", outputLines(3))], 40, 80, plainTheme);
  check(
    fits.length === 13 && fits.some((line) => line.includes("Selected:")) && fits.some((line) => line.includes("line 03")),
    "a body that fits is returned untrimmed",
  );

  // Overflow: title and list rows stay, the footer stays last, and details go first.
  const six = Array.from({ length: 6 }, (_, i) =>
    mkSubagentRun(`six-${i}`, outputLines(5), { agent: `agent${i}`, status: "completed", finishedAt: Date.now() }),
  );
  const cut = await frameAt(six, 14, 80, plainTheme, { initialRunId: "six-5" });
  check(cut.length === 14, `overflowing frame still fits maxHeight (${cut.length} rows)`);
  check(cut[cut.length - 2].includes("Enter send · Esc interrupt · ctrl+q close"), "footer hint stays the last body row");
  check(
    cut.some((line) => line.includes("Subagent monitor · agent5")) &&
      cut.filter((line) => line.includes("Enter send · Esc interrupt · ctrl+q close")).length === 1 &&
      cut.filter((line) => line.includes("│› ")).length === 1 &&
      cut.some((line) => line.includes("agent5")) &&
      !cut.some((line) => line.includes("agent0")),
    "title, one footer hint, and only the bound run survive the overflow",
  );
  check(cut.filter((line) => line.includes("Selected:")).length === 1, "one Selected header is rendered");

  // A snapshot with many runs remains a single-run frame; the footer still holds.
  const many = Array.from({ length: 12 }, (_, i) =>
    mkSubagentRun(`many-${i}`, "", { agent: `agent${i}`, status: "completed", finishedAt: Date.now() }),
  );
  const windowed = await frameAt(many, 12, 80, plainTheme, { initialRunId: "many-11" });
  check(
    windowed.length === 11 &&
      windowed.filter((line) => line.includes("│› ")).length === 1 &&
      windowed.some((line) => line.includes("agent11")) &&
      !windowed.some((line) => line.includes("agent0")),
    "a snapshot with many runs still renders only the bound run",
  );
  check(windowed[windowed.length - 2].includes("Enter send · Esc interrupt · ctrl+q close"), "footer hint survives a single-run frame");

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

  // The component must use pi-tui's real styleText even when the supplied theme.bold is an identity
  // function; child SGR colour must remain intact alongside the title styling.
  const identityBoldTheme = {
    bold: (text) => text,
    fg: (color, text) => `\x1b[38;5;${palette[color] ?? 250}m${text}\x1b[39m`,
  };
  const styled = await frameAt([noisy], 30, 40, identityBoldTheme);
  const styledJoined = styled.join("\n");
  check(
    styledJoined.includes("\x1b[1mSubagent monitor · worker\x1b[22m"),
    "real styleText keeps the title bold with an identity theme.bold",
  );
  check(styledJoined.includes("\x1b[31mred\x1b[0m"), "child colour remains with real styleText title output");

  off();
  console.log(`${passed} passed, 0 failed`);
})().catch((error) => {
  off();
  console.error(error);
  process.exit(1);
});
NODE
