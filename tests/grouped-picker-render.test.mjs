import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import * as picker from "../extensions/grouped-picker/grouped-picker.ts";
import { createPicker, reducePicker } from "../extensions/grouped-picker/picker-state.ts";

// Plain paint: keeps the text, so assertions read the layout, not colour codes.
const plain = (text) => text;
// Strip ANSI escape sequences so layout assertions see only visible characters.
const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

const questions = [
	{ id: "scope", label: "Scope", options: ["narrow", "broad"] },
	{ id: "priority", label: "Priority", options: ["low", "high", "urgent"] },
];

const tests = [];
function it(name, body) {
	tests.push({ name, body });
}

// Accepts action objects or bare type strings; an unknown action leaves the state unchanged.
function run(actions, start = createPicker(questions)) {
	return actions.reduce((current, action) => {
		const next = reducePicker(current, typeof action === "string" ? { type: action } : action);
		return next ?? current;
	}, start);
}

it("each question renders inside a rounded card", () => {
	const lines = picker.renderQuestionCard(questions[0], createPicker(questions), plain, 40);
	assert.equal(lines[0].startsWith("╭"), true, "top-left corner is rounded");
	assert.equal(lines.at(-1).startsWith("╰"), true, "bottom-left corner is rounded");
	assert.equal(
		lines.slice(1, -1).every((line) => line.startsWith("│")),
		true,
		"every interior row carries the left border",
	);
});

it("the card ends with the Other row after the last preset option", () => {
	const lines = picker.renderQuestionCard(questions[0], createPicker(questions), plain, 40);
	const body = lines
		.slice(2, -1)
		.map((line) => stripAnsi(line).replace(/[│╭╮╰╯─]/g, "").trim());
	// The cursor starts on the first option, so its row carries the pointer. The rest do not.
	assert.deepEqual(body, ["› narrow", "broad", "Other: type your own answer"]);
});

it("the focused row carries the pointer", () => {
	const state = run(["cursor-down"]);
	const lines = picker.renderQuestionCard(questions[0], state, plain, 40);
	const focused = lines.find((line) => line.includes("›"));
	assert.ok(focused, "a row is marked with the pointer");
	assert.ok(focused.includes("broad"), "the pointer sits on the cursor row");
});

it("an open text field shows the draft under the Other row", () => {
	const state = run(["cursor-down", "cursor-down", "choose", { type: "text", char: "h" }]);
	const lines = picker.renderQuestionCard(questions[0], state, plain, 40);
	const joined = lines.join("\n");
	assert.ok(joined.includes("h"), "the typed draft is visible");
	assert.ok(joined.includes("Enter to submit"), "the field says how to submit");
});

it("the tab strip keeps the answered and unanswered marks", () => {
	const state = run(["choose"]);
	const tabs = picker.renderTabs(state, plain);
	assert.ok(tabs.includes("☒"), "answered question shows the checked mark");
	assert.ok(tabs.includes("☐"), "unanswered question shows the empty mark");
	assert.ok(tabs.includes("√"), "Submit shows the tick");
});

it("the review page shows the typed text for an Other answer, not undefined", () => {
	const state = run([
		"cursor-down",
		"cursor-down",
		"choose",
		{ type: "text", char: "o" },
		{ type: "text", char: "k" },
		"submit-text",
	]);
	// Only one question here, so the picker is on the Submit tab after the typed answer.
	const lines = picker.renderReview(state, plain).map(stripAnsi);
	const row = lines.find((line) => line.includes("Scope:"));
	assert.ok(row, "the review lists the Scope answer");
	assert.match(row, /Scope: ok/, "the typed text is shown");
	assert.doesNotMatch(row, /undefined/, "never the raw undefined from an out-of-range option");
});

it("the card fits the requested width", () => {
	const lines = picker.renderQuestionCard(questions[1], createPicker(questions), plain, 24);
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 24, `"${stripAnsi(line)}" is wider than 24 columns`);
	}
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
console.log(`grouped-picker-render: ${tests.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
