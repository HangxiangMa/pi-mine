// The key probe records what the selection window receives. It is a diagnostic only: it must
// never consume a key, and it must do nothing unless PI_PICKER_PROBE=1 is set.
import assert from "node:assert/strict";
import { formatProbeLine, probeEnabled } from "../extensions/grouped-picker/picker-key-probe.ts";

// Off by default: no environment variable means no probe, so normal sessions are untouched.
assert.equal(probeEnabled({}), false, "no env var: probe off");
assert.equal(probeEnabled({ PI_PICKER_PROBE: "" }), false, "empty env var: probe off");
assert.equal(probeEnabled({ PI_PICKER_PROBE: "0" }), false, "PI_PICKER_PROBE=0: probe off");
assert.equal(probeEnabled({ PI_PICKER_PROBE: "1" }), true, "PI_PICKER_PROBE=1: probe on");

// One line per key: the raw bytes in a readable form, the action, and the cursor before and after.
const line = formatProbeLine({
	bytes: "\x1b[A",
	action: "cursor-up",
	cursorBefore: 1,
	cursorAfter: 0,
	at: 1000,
});
assert.ok(line.includes("ESC[A"), "raw bytes shown in readable escape form");
assert.ok(line.includes("cursor-up"), "the mapped action is shown");
assert.ok(line.includes("1->0"), "cursor before and after are shown");

// A key that maps to no action still gets a line, so a missing action is visible.
const none = formatProbeLine({ bytes: "x", action: undefined, cursorBefore: 0, cursorAfter: 0, at: 2 });
assert.ok(none.includes("no action"), "an unmapped key is reported, not silently dropped");

console.log("picker-key-probe tests passed");
