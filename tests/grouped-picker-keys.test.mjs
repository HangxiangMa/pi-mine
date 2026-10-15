import assert from "node:assert/strict";
import { actionForKey, resultFor } from "../extensions/grouped-picker/grouped-picker.ts";
import { createPicker, reducePicker } from "../extensions/grouped-picker/picker-state.ts";

const ESC = "\x1b";
const KEY = {
	tab: "\t",
	shiftTab: `${ESC}[Z`,
	right: `${ESC}[C`,
	left: `${ESC}[D`,
	up: `${ESC}[A`,
	down: `${ESC}[B`,
	enter: "\r",
	escape: ESC,
};

const questions = [
	{ id: "scope", label: "Scope", options: ["narrow", "broad"] },
	{ id: "priority", label: "Priority", options: ["low", "high", "urgent"] },
];

const tests = [];
function it(name, body) {
	tests.push({ name, body });
}

it("Tab and Right map to next-tab", () => {
	assert.deepEqual(actionForKey(KEY.tab, false), { type: "next-tab" });
	assert.deepEqual(actionForKey(KEY.right, false), { type: "next-tab" });
});

it("Shift+Tab and Left map to prev-tab", () => {
	assert.deepEqual(actionForKey(KEY.shiftTab, false), { type: "prev-tab" });
	assert.deepEqual(actionForKey(KEY.left, false), { type: "prev-tab" });
});

it("Up and Down move the cursor", () => {
	assert.deepEqual(actionForKey(KEY.up, false), { type: "cursor-up" });
	assert.deepEqual(actionForKey(KEY.down, false), { type: "cursor-down" });
});

it("Enter chooses on a question tab", () => {
	assert.deepEqual(actionForKey(KEY.enter, false), { type: "choose" });
});

it("Enter on the Submit tab is not a choose action", () => {
	assert.equal(actionForKey(KEY.enter, true), undefined);
});

it("Escape cancels from any tab", () => {
	assert.deepEqual(actionForKey(KEY.escape, false), { type: "escape" });
	assert.deepEqual(actionForKey(KEY.escape, true), { type: "escape" });
});

it("an unbound key maps to nothing", () => {
	assert.equal(actionForKey("x", false), undefined);
});

it("resultFor returns undefined when the picker was cancelled", () => {
	const cancelled = reducePicker(createPicker(questions), { type: "escape" });
	assert.deepEqual(resultFor(cancelled), { answers: undefined });
});

it("resultFor returns undefined when a question is still unanswered", () => {
	const partial = reducePicker(createPicker(questions), { type: "choose" });
	assert.deepEqual(resultFor(partial), { answers: undefined });
});

it("resultFor maps each question id to its chosen option text", () => {
	// Scope: cursor-down then choose -> "broad". Priority: cursor-down twice then choose -> "urgent".
	let state = createPicker(questions);
	state = reducePicker(state, { type: "cursor-down" });
	state = reducePicker(state, { type: "choose" });
	state = reducePicker(state, { type: "cursor-down" });
	state = reducePicker(state, { type: "cursor-down" });
	state = reducePicker(state, { type: "choose" });
	assert.deepEqual(resultFor(state), { answers: { scope: "broad", priority: "urgent" } });
});

let failed = 0;
for (const { name, body } of tests) {
	try {
		body();
		console.log(`  ok  ${name}`);
	} catch (error) {
		failed += 1;
		console.log(`  FAIL ${name}\n       ${error.message}`);
	}
}
console.log(`grouped-picker-keys: ${tests.length - failed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
