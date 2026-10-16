import assert from "node:assert/strict";
import {
	CHECKED_MARK,
	SUBMIT_MARK,
	UNCHECKED_MARK,
	allAnswered,
	createPicker,
	markFor,
	onSubmitTab,
	reducePicker,
	tabCount,
} from "../extensions/grouped-picker/picker-state.ts";

const questions = [
	{ id: "scope", label: "Scope", options: ["narrow", "broad"] },
	{ id: "priority", label: "Priority", options: ["low", "high", "urgent"] },
];

function run(actions, start = createPicker(questions)) {
	return actions.reduce((state, action) => reducePicker(state, { type: action }), start);
}

const tests = [];
function it(name, body) {
	tests.push({ name, body });
}

it("starts on the first question with every question unanswered", () => {
	const state = createPicker(questions);
	assert.equal(state.tab, 0);
	assert.equal(state.cursor, 0);
	assert.equal(state.cancelled, false);
	assert.deepEqual(state.answers, [undefined, undefined]);
	assert.equal(tabCount(state), 3, "two questions plus Submit");
});

it("Tab past the last tab clamps to Submit and does not wrap to the first tab", () => {
	const state = run(["next-tab", "next-tab", "next-tab", "next-tab"]);
	assert.equal(state.tab, 2, "clamped to the Submit tab");
	assert.equal(onSubmitTab(state), true);
});

it("Shift+Tab before the first tab clamps to tab 0 and does not wrap to Submit", () => {
	const state = run(["prev-tab", "prev-tab"]);
	assert.equal(state.tab, 0);
	assert.equal(onSubmitTab(state), false);
});

it("choosing an option records it and advances one tab", () => {
	const state = run(["cursor-down", "choose"]);
	assert.deepEqual(state.answers, [1, undefined]);
	assert.equal(state.tab, 1);
});

it("choosing on the last question leaves the tab on Submit, not past it", () => {
	const state = run(["choose", "cursor-down", "choose"]);
	assert.equal(state.tab, 2);
	assert.equal(onSubmitTab(state), true);
	assert.deepEqual(state.answers, [0, 1]);
});

it("cursor clamps at the first row and at the trailing Other row of each question", () => {
	assert.equal(run(["cursor-up"]).cursor, 0, "no cursor above the first option");
	// Question 0 has two preset options, so its Other row is index 2 and the cursor stops there.
	assert.equal(run(["cursor-down", "cursor-down", "cursor-down", "cursor-down"]).cursor, 2);
	// Question 1 has three preset options, so its Other row is index 3.
	const onSecond = run(["choose"]);
	assert.equal(onSecond.tab, 1);
	assert.equal(run(["cursor-down", "cursor-down", "cursor-down", "cursor-down"], onSecond).cursor, 3);
});

it("cursor actions do nothing on the Submit tab", () => {
	const onSubmit = run(["next-tab", "next-tab"]);
	assert.equal(reducePicker(onSubmit, { type: "cursor-down" }).cursor, onSubmit.cursor);
	assert.equal(reducePicker(onSubmit, { type: "choose" }).answers.join(), onSubmit.answers.join());
});

it("marks: unchecked before an answer, checked after, tick on Submit", () => {
	const before = createPicker(questions);
	assert.equal(markFor(before, 0), UNCHECKED_MARK);
	assert.equal(markFor(before, 2), SUBMIT_MARK);
	const after = run(["choose"]);
	assert.equal(markFor(after, 0), CHECKED_MARK);
	assert.equal(markFor(after, 1), UNCHECKED_MARK);
});

it("escape cancels the whole picker from the option list", () => {
	const state = run(["escape"]);
	assert.equal(state.cancelled, true);
});

it("a cancelled picker ignores later actions", () => {
	const cancelled = run(["escape"]);
	assert.equal(reducePicker(cancelled, { type: "choose" }), cancelled);
	assert.equal(reducePicker(cancelled, { type: "next-tab" }), cancelled);
});

it("allAnswered is false until every question has an answer", () => {
	assert.equal(allAnswered(run(["choose"])), false);
	assert.equal(allAnswered(run(["choose", "choose"])), true);
});

it("returning to an answered tab restores its chosen option as the cursor", () => {
	const state = run(["cursor-down", "choose", "prev-tab"]);
	assert.equal(state.tab, 0);
	assert.equal(state.cursor, 1, "cursor restored to the chosen option, not reset to 0");
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
console.log(`grouped-picker-state: ${tests.length - failed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
