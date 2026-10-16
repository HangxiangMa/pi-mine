// The ↓ picker is an overlay drawn over the live dock. pi composites an overlay by keeping the
// base text in every column the overlay does not cover, so any inset (left margin, or a width
// under 100%) lets dock text leak through as stray fragments such as "bg" or "──". The overlay
// must cover its full row, with no inset, so the screen shows only the picker.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  fileURLToPath(new URL("../extensions/task-dock-picker-view.ts", import.meta.url)),
  "utf8",
);

const match = source.match(/overlayOptions:\s*\{([^}]*)\}/);
assert.ok(match, "the picker must declare overlayOptions");
const options = match[1];

// Full width: a percentage below 100% leaves base text visible in the remaining columns.
assert.match(options, /width:\s*"100%"/, `the overlay must cover the full width, got: ${options.trim()}`);

// No left inset: a left margin leaves the first columns showing base text.
assert.doesNotMatch(options, /left:\s*[1-9]/, `the overlay must not inset from the left edge, got: ${options.trim()}`);

console.log("task dock picker overlay geometry: ok");
