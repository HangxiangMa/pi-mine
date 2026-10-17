// Whether a grouped-picker selection window is open. The task dock reads this before it lets ↓
// open its own picker: the dock's terminal-input listener runs before the focused component, so
// without this flag it would consume ↓ while a selection window holds focus.
//
// The count lives on globalThis under a Symbol.for key, not in a module variable. The picker and
// the dock are reached through separate imports, and a module-level variable is not guaranteed
// to be one shared instance across separate loads.

const KEY = Symbol.for("pi-mine.grouped-picker.open-count");

type Holder = { [KEY]?: number };

function holder(): Holder {
	return globalThis as Holder;
}

/** Call when a selection window opens. Nested windows stack. */
export function enterPicker(): void {
	holder()[KEY] = (holder()[KEY] ?? 0) + 1;
}

/** Call when a selection window closes. Extra calls never drive the count below zero. */
export function exitPicker(): void {
	const next = (holder()[KEY] ?? 0) - 1;
	holder()[KEY] = next > 0 ? next : 0;
}

/** True while at least one selection window is open. */
export function isPickerBusy(): boolean {
	return (holder()[KEY] ?? 0) > 0;
}
