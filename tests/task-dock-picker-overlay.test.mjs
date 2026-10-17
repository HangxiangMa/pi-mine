// Geometry contract for the ↓ picker. It is anchored above the prompt/footer, with a bounded width
// and a height cap derived from the rows above the reserved footer margin.
import assert from "node:assert/strict";
import { pickerOverlayOptions } from "../extensions/task-dock-picker-view.ts";

const options = pickerOverlayOptions(160, 50, 4);
assert.equal(options.anchor, "bottom-left");
assert.equal(options.width, 100, "the picker width is capped at 100 columns");
assert.equal(options.margin.bottom, 4, "the prompt/footer rows stay uncovered");
assert.equal(options.maxHeight, 45, "the height fits above the reserved footer");

const narrow = pickerOverlayOptions(70, 24, 7);
assert.equal(narrow.width, 66, "narrow terminals use columns minus side margins");
assert.equal(narrow.maxHeight, 16, "a taller footer shortens the picker");

console.log("task dock picker overlay geometry: ok");
