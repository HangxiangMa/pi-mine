#!/usr/bin/env bash
# Regression: the subagent monitor's footer reserve must follow the dock while the monitor is
# open. Drives the real openSubagentFleetInspector() with a fake ctx.ui.custom, so the real
# SubagentFleetComponent, its 500 ms refresh timer, and pi-tui's overlay options object are all
# exercised. Changes the dock row count and waits for real ticks.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/pi-jiti.sh
source "$here/lib/pi-jiti.sh"
locate_pi_jiti || exit 1

node - "$PI_JITI" \
  "$here/../extensions/subagent/fleet-inspector.ts" \
  "$here/../extensions/task-dock.ts" \
  <<'NODE'
const jiti = require(process.argv[2])(process.cwd(), { interopDefault: true });
const fleet = jiti(process.argv[3]);
const dock = jiti(process.argv[4]);

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
  await opened;
  check(closed, "monitor closes through its own done() path");

  off();
  console.log(`${passed} passed, 0 failed`);
})().catch((error) => {
  off();
  console.error(error);
  process.exit(1);
});
NODE
