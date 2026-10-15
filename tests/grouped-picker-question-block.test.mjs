import assert from "node:assert/strict";
import { parseQuestionBlock } from "../extensions/grouped-picker/question-block.ts";

const fence = (json) => "Plan is ready.\n\n```question\n" + json + "\n```\n";
const one = { id: "scope", label: "Scope", options: ["narrow", "broad"] };
const wrap = (questions) => JSON.stringify({ questions });

const tests = [];
function it(name, body) {
	tests.push({ name, body });
}

it("parses a valid single question block", () => {
	const block = parseQuestionBlock(fence(wrap([one])));
	assert.deepEqual(block, { questions: [one] });
});

it("parses up to four questions with two to four options each", () => {
	const four = [1, 2, 3, 4].map((n) => ({
		id: `q${n}`,
		label: `Q${n}`,
		options: ["a", "b", "c", "d"],
	}));
	assert.equal(parseQuestionBlock(fence(wrap(four))).questions.length, 4);
});

it("returns undefined when there is no question fence", () => {
	assert.equal(parseQuestionBlock("just prose, no block"), undefined);
});

it("returns undefined for a task-packet fence, which is a different contract", () => {
	assert.equal(parseQuestionBlock("```task-packet\n{}\n```"), undefined);
});

it("returns undefined for malformed JSON instead of throwing", () => {
	assert.equal(parseQuestionBlock(fence("{not json")), undefined);
});

it("rejects an empty question list", () => {
	assert.equal(parseQuestionBlock(fence(wrap([]))), undefined);
});

it("rejects more than four questions", () => {
	const five = [1, 2, 3, 4, 5].map((n) => ({ id: `q${n}`, label: "L", options: ["a", "b"] }));
	assert.equal(parseQuestionBlock(fence(wrap(five))), undefined);
});

it("rejects a question with fewer than two options", () => {
	assert.equal(
		parseQuestionBlock(fence(wrap([{ id: "x", label: "X", options: ["only"] }]))),
		undefined,
	);
});

it("rejects a question with more than four options", () => {
	const opts = ["a", "b", "c", "d", "e"];
	assert.equal(parseQuestionBlock(fence(wrap([{ id: "x", label: "X", options: opts }]))), undefined);
});

it("rejects duplicate question ids", () => {
	const dup = [one, { id: "scope", label: "Again", options: ["x", "y"] }];
	assert.equal(parseQuestionBlock(fence(wrap(dup))), undefined);
});

it("rejects a blank option or blank label rather than keeping it", () => {
	assert.equal(
		parseQuestionBlock(fence(wrap([{ id: "x", label: "X", options: ["ok", "  "] }]))),
		undefined,
	);
	assert.equal(
		parseQuestionBlock(fence(wrap([{ id: "x", label: "", options: ["a", "b"] }]))),
		undefined,
	);
});

it("rejects a non-string option instead of coercing it", () => {
	assert.equal(
		parseQuestionBlock(fence(wrap([{ id: "x", label: "X", options: ["a", 2] }]))),
		undefined,
	);
});

it("does not partially accept a block where one question is invalid", () => {
	const mixed = [one, { id: "bad", label: "Bad", options: ["only"] }];
	assert.equal(parseQuestionBlock(fence(wrap(mixed))), undefined);
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
console.log(`grouped-picker-question-block: ${tests.length - failed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
