import assert from "node:assert/strict";
import { runPlannerRounds } from "../extensions/grouped-picker/planner-rounds.ts";
import { parseQuestionBlock } from "../extensions/grouped-picker/question-block.ts";

const QUESTION = [
	"Plan needs input.",
	"```question",
	'{"questions":[{"id":"scope","label":"Scope","options":["narrow","broad"]}]}',
	"```",
].join("\n");
const PLAIN = "Final plan: step 1, step 2.";

// Fake planner: each resume replaces the output with the next scripted text.
function fakePlanner(initial, scripted = []) {
	const state = { text: initial, resumes: [], asks: 0 };
	const deps = {
		outputOf: () => state.text,
		parseBlock: parseQuestionBlock,
		hasUI: true,
		ask: async () => {
			state.asks += 1;
			if (state.asks > 10) throw new Error("ask loop did not terminate");
			return state.answerNext === undefined ? { scope: "broad" } : state.answerNext;
		},
		resume: async (task) => {
			state.resumes.push(task);
			state.text = scripted.shift() ?? PLAIN;
		},
	};
	return { state, deps };
}

const tests = [];
function it(name, body) {
	tests.push({ name, body });
}

it("returns the text unchanged when there is no question block", async () => {
	const { state, deps } = fakePlanner(PLAIN);
	const out = await runPlannerRounds(deps);
	assert.deepEqual(out, { text: PLAIN, rounds: 0, cancelled: false });
	assert.equal(state.asks, 0);
});

it("returns the text unchanged when the block is malformed, without asking", async () => {
	const { state, deps } = fakePlanner("```question\n{bad json\n```");
	const out = await runPlannerRounds(deps);
	assert.equal(out.rounds, 0);
	assert.equal(state.asks, 0, "a malformed block never reaches the picker");
});

it("without a UI the questions are returned as text and the picker is not shown", async () => {
	const { state, deps } = fakePlanner(QUESTION);
	deps.hasUI = false;
	const out = await runPlannerRounds(deps);
	assert.equal(out.text, QUESTION);
	assert.equal(state.asks, 0);
	assert.equal(state.resumes.length, 0);
});

it("a valid block is asked, answered, and the planner resumed with the answers", async () => {
	const { state, deps } = fakePlanner(QUESTION, [PLAIN]);
	const out = await runPlannerRounds(deps);
	assert.equal(state.asks, 1);
	assert.equal(state.resumes.length, 1);
	assert.ok(state.resumes[0].includes("- Scope: broad"), "the answer reaches the planner");
	assert.deepEqual(out, { text: PLAIN, rounds: 1, cancelled: false });
});

it("cancelling the picker returns the cancelled notice and does not resume the planner", async () => {
	const { state, deps } = fakePlanner(QUESTION);
	state.answerNext = undefined;
	deps.ask = async () => undefined;
	const out = await runPlannerRounds(deps);
	assert.equal(out.cancelled, true);
	assert.ok(out.text.includes("cancelled these questions"));
	assert.equal(state.resumes.length, 0, "no resume after a cancel");
});

it("stops after the round cap even if the planner keeps asking", async () => {
	const { state, deps } = fakePlanner(QUESTION, [QUESTION, QUESTION, QUESTION]);
	const out = await runPlannerRounds(deps);
	assert.equal(out.rounds, 1, "one follow-up round, then stop");
	assert.equal(state.resumes.length, 1, "one answer resume; the cap then stops before asking again");
	assert.equal(out.cancelled, false);
	assert.equal(out.text, QUESTION, "the last question text is returned to the main session");
});

let failed = 0;
for (const { name, body } of tests) {
	try {
		await body();
		console.log(`  ok  ${name}`);
	} catch (error) {
		failed += 1;
		console.log(`  FAIL ${name}\n       ${error.message}`);
	}
}
console.log(`grouped-picker-planner-rounds: ${tests.length - failed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
