// A grouped-picker selection window that is open must stop the task dock's ↓ key from
// opening its own picker on top of it. The dock registers a global terminal-input listener
// that runs before the focused component, so while a selection window holds focus the dock
// would otherwise consume ↓ and the selection window would never see it.
//
// Both modules are loaded through the same extensions/index.ts, but a shared module-level
// variable is not guaranteed across separate loads, so the busy flag lives on globalThis.
import assert from "node:assert/strict";
import { canOpenPicker } from "../extensions/task-dock-picker.ts";
import { enterPicker, exitPicker, isPickerBusy } from "../extensions/grouped-picker/picker-busy.ts";

// Idle: no selection window open, so the flag is clear.
assert.equal(isPickerBusy(), false, "no selection window open: not busy");

// Open one selection window.
enterPicker();
assert.equal(isPickerBusy(), true, "a selection window is open: busy");

// The dock's own gate must refuse ↓ while a selection window holds focus, even with rows
// present and an empty editor. This is the actual reported failure.
const dockGate = (overlayOpen) =>
	canOpenPicker({ hasRows: true, editorText: "", browsingHistory: false, overlayOpen });
assert.equal(dockGate(isPickerBusy()), false, "dock must not open over a selection window");

// Two selection windows nested: closing one must not clear busy while the other is open.
enterPicker();
exitPicker();
assert.equal(isPickerBusy(), true, "one of two selection windows closed: still busy");

// Closing the last one clears the flag, so ↓ works again once the picker is gone.
exitPicker();
assert.equal(isPickerBusy(), false, "all selection windows closed: not busy");
assert.equal(dockGate(isPickerBusy()), true, "dock opens again after the selection window closes");

// An unbalanced exit must not drive the count negative and wedge later opens.
exitPicker();
assert.equal(isPickerBusy(), false, "extra exit stays at zero, not negative");
enterPicker();
assert.equal(isPickerBusy(), true, "a later open is still detected after an extra exit");
exitPicker();

console.log("picker-busy tests passed");
