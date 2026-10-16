import assert from "node:assert/strict";
import { validateAskQuestions } from "../extensions/ask-user-question/validate.ts";

const tests = [];
function it(name, body) {
	tests.push({ name, body });
}

const q = (overrides = {}) => ({
	question: "Which approach should we take?",
	header: "Approach",
	options: [{ label: "Narrow" }, { label: "Broad" }],
	...overrides,
});

it("accepts one valid question and maps it to a picker question", () => {
	const result = validateAskQuestions({ questions: [q()] });
	assert.equal(result.ok, true);
	assert.deepEqual(result.questions, [
		{ id: "q0", label: "Approach", options: ["Narrow", "Broad"] },
	]);
});

it("accepts four questions with distinct ids", () => {
	const questions = [1, 2, 3, 4].map((n) => q({ question: `Question ${n}?`, header: `H${n}` }));
	const result = validateAskQuestions({ questions });
	assert.equal(result.ok, true);
	assert.deepEqual(result.questions.map((item) => item.id), ["q0", "q1", "q2", "q3"]);
});

it("rejects zero questions and more than four", () => {
	assert.equal(validateAskQuestions({ questions: [] }).ok, false);
	const five = [1, 2, 3, 4, 5].map((n) => q({ question: `Q${n}?`, header: `H${n}` }));
	const result = validateAskQuestions({ questions: five });
	assert.equal(result.ok, false);
	assert.match(result.error, /1 to 4/);
});

it("rejects a question list that is not an array", () => {
	const result = validateAskQuestions({ questions: "nope" });
	assert.equal(result.ok, false);
});

it("rejects an empty question or header", () => {
	assert.equal(validateAskQuestions({ questions: [q({ question: "  " })] }).ok, false);
	assert.equal(validateAskQuestions({ questions: [q({ header: "" })] }).ok, false);
});

it("rejects a header longer than 12 characters", () => {
	const result = validateAskQuestions({ questions: [q({ header: "ThirteenChars" })] });
	assert.equal(result.ok, false);
	assert.match(result.error, /12 characters/);
});

it("accepts a header of exactly 12 characters", () => {
	const result = validateAskQuestions({ questions: [q({ header: "TwelveChars!" })] });
	assert.equal(result.ok, true);
});

it("rejects fewer than 2 or more than 4 options", () => {
	assert.equal(validateAskQuestions({ questions: [q({ options: [{ label: "Only" }] })] }).ok, false);
	const five = [1, 2, 3, 4, 5].map((n) => ({ label: `Opt${n}` }));
	assert.equal(validateAskQuestions({ questions: [q({ options: five })] }).ok, false);
});

it("rejects duplicate question texts", () => {
	const result = validateAskQuestions({ questions: [q(), q({ header: "Other" })] });
	assert.equal(result.ok, false);
	assert.match(result.error, /unique/);
});

it("rejects duplicate option labels within one question", () => {
	const result = validateAskQuestions({
		questions: [q({ options: [{ label: "Same" }, { label: "Same" }] })],
	});
	assert.equal(result.ok, false);
	assert.match(result.error, /option labels must be unique/);
});

it("rejects multiSelect instead of silently treating it as single-select", () => {
	const result = validateAskQuestions({ questions: [q({ multiSelect: true })] });
	assert.equal(result.ok, false);
	assert.match(result.error, /multiSelect is not supported/);
});

it("accepts multiSelect false", () => {
	const result = validateAskQuestions({ questions: [q({ multiSelect: false })] });
	assert.equal(result.ok, true);
});

it("rejects a per-option preview instead of dropping it", () => {
	const result = validateAskQuestions({
		questions: [q({ options: [{ label: "A", preview: "x" }, { label: "B" }] })],
	});
	assert.equal(result.ok, false);
	assert.match(result.error, /preview is not supported/);
});

it("rejects an Other option, because the picker already adds its own Other row", () => {
	const result = validateAskQuestions({
		questions: [q({ options: [{ label: "Narrow" }, { label: "Other" }] })],
	});
	assert.equal(result.ok, false);
	assert.match(result.error, /Other.*already/);
});

it("rejects Other in any case, since the match is case-insensitive", () => {
	const result = validateAskQuestions({
		questions: [q({ options: [{ label: "Narrow" }, { label: "OTHER" }] })],
	});
	assert.equal(result.ok, false);
});

it("accepts a label that merely contains the word other", () => {
	const result = validateAskQuestions({
		questions: [q({ options: [{ label: "Other team" }, { label: "Mine" }] })],
	});
	assert.equal(result.ok, true, "only the exact word is reserved");
});

it("reports the first problem with its position", () => {
	const result = validateAskQuestions({
		questions: [q(), q({ question: "Fine?", header: "" })],
	});
	assert.equal(result.ok, false);
	assert.match(result.error, /questions\[1\]\.header/);
});

let failed = 0;
for (const test of tests) {
	try {
		test.body();
		console.log(`ok  ${test.name}`);
	} catch (error) {
		failed += 1;
		console.log(`not ok  ${test.name}\n    ${error.message}`);
	}
}
console.log(`ask-user-question validate: ${tests.length - failed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
