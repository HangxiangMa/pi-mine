import assert from "node:assert/strict";
import { actionForKey, resultFor } from "../extensions/grouped-picker/grouped-picker.ts";
import { answerTask } from "../extensions/grouped-picker/answer-task.ts";
import * as state from "../extensions/grouped-picker/picker-state.ts";

// Read through the namespace so a missing export fails only the test that needs it, not the file.
const { createPicker, reducePicker, allAnswered } = state;
const otherIndex = (question) => state.otherIndex(question);

// Each question gets a trailing "Other" row. Choosing it opens a free-text field; Enter
// submits the typed text as that question's answer, Escape returns to the option list.

const ESC = "\x1b";
const KEY = {
	enter: "\r",
	escape: ESC,
	down: `${ESC}[B`,
	up: `${ESC}[A`,
	backspace: "\x7f",
};

const questions = [
	{ id: "scope", label: "Scope", options: ["narrow", "broad"] },
	{ id: "priority", label: "Priority", options: ["low", "high", "urgent"] },
];


const tests = [];
function it(name, body) {
	tests.push({ name, body });
}

// Unknown actions leave the state unchanged, so a missing reducer case fails the assertion that
// needs it, not an unrelated read of an undefined state.
function run(actions, start = createPicker(questions)) {
	return actions.reduce((current, action) => {
		const next = reducePicker(current, typeof action === "string" ? { type: action } : action);
		return next ?? current;
	}, start);
}

it("the Other row sits after the last option of every question", () => {
	assert.equal(otherIndex(questions[0]), 2, "two options, so Other is index 2");
	assert.equal(otherIndex(questions[1]), 3, "three options, so Other is index 3");
});

it("moving the cursor down reaches Other and clamps there, not past it", () => {
	const state = run(["cursor-down", "cursor-down", "cursor-down", "cursor-down"]);
	assert.equal(state.cursor, otherIndex(questions[0]));
});

it("choosing Other opens the text field and does not advance the tab", () => {
	const state = run(["cursor-down", "cursor-down", "choose"]);
	assert.equal(state.editing, true, "the text field is open");
	assert.equal(state.tab, 0, "still on the same question until text is submitted");
	assert.equal(state.answers[0], undefined, "not answered until text is submitted");
});

it("typed characters accumulate in the open text field", () => {
	const state = run([
		"cursor-down",
		"cursor-down",
		"choose",
		{ type: "text", char: "h" },
		{ type: "text", char: "i" },
	]);
	assert.equal(state.draft, "hi");
});

it("backspace removes the last typed character", () => {
	const state = run([
		"cursor-down",
		"cursor-down",
		"choose",
		{ type: "text", char: "a" },
		{ type: "text", char: "b" },
		{ type: "backspace" },
	]);
	assert.equal(state.draft, "a");
});

it("submitting non-empty text answers the question and advances", () => {
	const state = run([
		"cursor-down",
		"cursor-down",
		"choose",
		{ type: "text", char: "x" },
		"submit-text",
	]);
	assert.equal(state.editing, false);
	assert.equal(state.tab, 1, "advanced to the next question");
	assert.equal(state.typed[0], "x", "the typed text is recorded on its question");
});

it("submitting empty text does not answer the question", () => {
	const state = run(["cursor-down", "cursor-down", "choose", "submit-text"]);
	assert.equal(state.editing, true, "stays in the text field");
	assert.equal(state.answers[0], undefined);
});

it("escape in the text field returns to the option list without cancelling the picker", () => {
	const state = run([
		"cursor-down",
		"cursor-down",
		"choose",
		{ type: "text", char: "x" },
		"escape-text",
	]);
	assert.equal(state.editing, false);
	assert.equal(state.cancelled, false, "the whole picker stays open");
	assert.equal(state.draft, "", "the draft is discarded");
});

it("a typed answer resolves to its text in the result map", () => {
	const state = run([
		"cursor-down",
		"cursor-down",
		"choose",
		{ type: "text", char: "y" },
		"submit-text",
		"choose",
	]);
	assert.equal(allAnswered(state), true);
	assert.deepEqual(resultFor(state).answers, { scope: "y", priority: "low" });
});

it("a typed Other answer reaches the planner resume text as the answer", () => {
	const state = run([
		"cursor-down",
		"cursor-down",
		"choose",
		{ type: "text", char: "m" },
		{ type: "text", char: "e" },
		"submit-text",
		"choose",
	]);
	const answers = resultFor(state).answers;
	assert.deepEqual(answers, { scope: "me", priority: "low" });
	// The planner formats answers as "- label: answer", so the typed text must appear there unchanged.
	const resume = answerTask(questions, answers);
	assert.match(resume, /- Scope: me/);
});

it("a picked preset option still resolves to its label, unchanged", () => {
	const state = run(["choose", "choose"]);
	assert.deepEqual(resultFor(state).answers, { scope: "narrow", priority: "low" });
});

it("Enter in the option list on Other opens the text field (keys map to choose)", () => {
	assert.deepEqual(actionForKey(KEY.enter, false), { type: "choose" });
});

it("while the text field is open, printable keys map to text input", () => {
	assert.deepEqual(actionForKey("q", false, true), { type: "text", char: "q" });
	assert.deepEqual(actionForKey(KEY.backspace, false, true), { type: "backspace" });
	assert.deepEqual(actionForKey(KEY.enter, false, true), { type: "submit-text" });
	assert.deepEqual(actionForKey(KEY.escape, false, true), { type: "escape-text" });
});

it("outside the text field, a printable key is not bound", () => {
	assert.equal(actionForKey("q", false, false), undefined);
});

let failed = 0;
for (const { name, body } of tests) {
	try {
		body();
		console.log(`ok  ${name}`);
	} catch (error) {
		failed += 1;
		console.log(`FAIL ${name}\n     ${error.message.split("\n")[0]}`);
	}
}
console.log(`grouped-picker-other: ${tests.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
