// Behavior test for the code-restore hint shown above the input box.
// Run: node --experimental-strip-types --no-warnings tests/restore-hint.test.mjs
import assert from "node:assert/strict";
import { clearRestoreHint, isPrintableKey, isRestoreHintShown, showRestoreHint } from "../extensions/checkpoint/restore-hint.ts";

function fakeCtx({ hasUI = true, withInput = true } = {}) {
	const widgets = [];
	const inputs = [];
	let unsubscribed = 0;
	const ui = {
		setWidget: (key, content, options) => widgets.push({ key, content, options }),
	};
	if (withInput) {
		ui.onTerminalInput = (handler) => {
			inputs.push(handler);
			return () => {
				unsubscribed += 1;
			};
		};
	}
	return {
		ctx: { hasUI, ui },
		widgets,
		inputs,
		unsubscribedCount: () => unsubscribed,
	};
}

// isPrintableKey: a single visible character counts; control bytes and escape sequences do not.
assert.equal(isPrintableKey("a"), true, "a letter is printable");
assert.equal(isPrintableKey(" "), true, "space is printable");
assert.equal(isPrintableKey("中"), true, "a non-ASCII character is printable");
assert.equal(isPrintableKey("\r"), false, "enter is not printable");
assert.equal(isPrintableKey("\x7f"), false, "backspace is not printable");
assert.equal(isPrintableKey("\x1b[A"), false, "arrow key is not printable");
assert.equal(isPrintableKey("\x03"), false, "ctrl+c is not printable");
assert.equal(isPrintableKey(""), false, "empty input is not printable");

// Showing the hint: one static aboveEditor widget, one keystroke listener.
{
	const { ctx, widgets, inputs } = fakeCtx();
	showRestoreHint(ctx, "Code restored to before turn 744ff68b");
	const shown = widgets.filter((w) => Array.isArray(w.content));
	assert.equal(shown.length, 1, "one hint widget is shown");
	assert.equal(shown[0].options?.placement, "aboveEditor", "hint is placed above the input box");
	assert.ok(shown[0].content[0].includes("Code restored to before turn 744ff68b"), "hint names the turn");
	assert.ok(shown[0].content[0].includes("\x1b[2m"), "hint is dim");
	assert.equal(inputs.length, 1, "a keystroke listener is registered");
	assert.equal(isRestoreHintShown(), true, "hint is recorded as shown");
	clearRestoreHint(ctx);
}

// The first printable keystroke clears the hint and unsubscribes.
{
	const { ctx, widgets, inputs, unsubscribedCount } = fakeCtx();
	showRestoreHint(ctx, "restored");
	const result = inputs[0]("a");
	assert.equal(result, undefined, "the keystroke is observed, not consumed");
	assert.equal(widgets.at(-1).content, undefined, "typing clears the hint widget");
	assert.equal(unsubscribedCount(), 1, "typing unsubscribes the keystroke listener");
	assert.equal(isRestoreHintShown(), false, "hint is no longer shown");
}

// A control key (arrow) does not clear the hint.
{
	const { ctx, widgets, inputs } = fakeCtx();
	showRestoreHint(ctx, "restored");
	inputs[0]("\x1b[A");
	assert.equal(widgets.at(-1).content === undefined, false, "an arrow key keeps the hint");
	assert.equal(isRestoreHintShown(), true, "hint still shown after an arrow key");
	clearRestoreHint(ctx);
}

// Showing again replaces the previous hint and does not stack listeners.
{
	const { ctx, inputs, unsubscribedCount } = fakeCtx();
	showRestoreHint(ctx, "first");
	showRestoreHint(ctx, "second");
	assert.equal(unsubscribedCount(), 1, "the earlier listener is removed before showing again");
	assert.equal(inputs.length, 2, "two listeners were created over two shows");
	clearRestoreHint(ctx);
}

// Clearing with no hint shown is a safe no-op.
{
	const { ctx, widgets } = fakeCtx();
	clearRestoreHint(ctx);
	assert.equal(widgets.at(-1).content, undefined, "clear always removes the widget");
	assert.equal(isRestoreHintShown(), false, "nothing is shown after clear");
}

// No UI means nothing is shown.
{
	const { ctx, widgets } = fakeCtx({ hasUI: false });
	showRestoreHint(ctx, "restored");
	assert.equal(widgets.length, 0, "no widget without a UI");
	assert.equal(isRestoreHintShown(), false, "no hint recorded without a UI");
}

// Without onTerminalInput, the hint still shows and clears by the turn boundary.
{
	const { ctx, widgets } = fakeCtx({ withInput: false });
	showRestoreHint(ctx, "restored");
	assert.ok(widgets.some((w) => Array.isArray(w.content)), "the hint still shows without keystroke support");
	clearRestoreHint(ctx);
}

console.log("restore-hint: ok");
