import assert from "node:assert/strict";
import {
	MAX_PLANNER_ROUNDS,
	answerTask,
	cancelledNotice,
} from "../extensions/grouped-picker/answer-task.ts";

const questions = [
	{ id: "scope", label: "Scope", options: ["narrow", "broad"] },
	{ id: "priority", label: "Priority", options: ["low", "urgent"] },
];

const tests = [];
function it(name, body) {
	tests.push({ name, body });
}

it("answerTask lists every answer in the original question order", () => {
	const text = answerTask(questions, { scope: "broad", priority: "urgent" });
	const scopeAt = text.indexOf("- Scope: broad");
	const priorityAt = text.indexOf("- Priority: urgent");
	assert.ok(scopeAt >= 0 && priorityAt > scopeAt, "both answers present, scope first");
});

it("answerTask names an unanswered question instead of dropping it", () => {
	const text = answerTask(questions, { scope: "narrow" });
	assert.ok(text.includes("- Priority: (no answer)"), "the missing answer is explicit");
});

it("answerTask tells the planner not to re-ask the same questions", () => {
	assert.ok(answerTask(questions, { scope: "narrow" }).includes("Do not ask the same questions again"));
});

it("cancelledNotice names every cancelled question and says no plan was resumed", () => {
	const text = cancelledNotice(questions);
	assert.ok(text.includes("Scope, Priority"));
	assert.ok(text.includes("No plan was resumed"));
});

it("the planner round cap is one round, matching planner.md", () => {
	assert.equal(MAX_PLANNER_ROUNDS, 1);
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
console.log(`grouped-picker-answer-task: ${tests.length - failed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
