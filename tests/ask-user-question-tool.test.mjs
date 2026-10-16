import assert from "node:assert/strict";

// Exercises the registered tool's execute() with fake pi and ctx. The picker itself is covered by
// the grouped-picker tests; here the picker's answer is faked through ctx.ui.custom.
const { default: askUserQuestion, ASK_USER_QUESTION_TOOL_NAME } = await import(
	"../extensions/ask-user-question/index.ts"
);

let registered;
askUserQuestion({
	registerTool(def) {
		registered = def;
	},
});
assert.ok(registered, "the extension registers a tool");
assert.equal(registered.name, ASK_USER_QUESTION_TOOL_NAME);
assert.equal(ASK_USER_QUESTION_TOOL_NAME, "ask_user_question");
assert.ok(Array.isArray(registered.promptGuidelines) && registered.promptGuidelines.length > 0, "promptGuidelines are set");

const question = {
	question: "Which library should we use for date formatting?",
	header: "Library",
	options: [{ label: "date-fns (Recommended)" }, { label: "dayjs" }],
};

const run = (ctx, params = { questions: [question] }) =>
	registered.execute("call-1", params, undefined, undefined, ctx);

const tests = [];
function it(name, body) {
	tests.push({ name, body });
}

it("returns ui_unavailable without a UI, so the model asks in plain text", async () => {
	const result = await run({ hasUI: false, ui: {} });
	assert.equal(result.details.cancelled, true);
	assert.equal(result.details.reason, "ui_unavailable");
	assert.match(result.content[0].text, /interactive UI is not available/);
});

it("maps the picked answer back to the question text", async () => {
	const ctx = {
		hasUI: true,
		ui: {
			// Resolve the picker with the first option chosen for q0.
			custom: async () => ({ answers: { q0: "date-fns (Recommended)" } }),
		},
	};
	const result = await run(ctx);
	assert.equal(result.details.cancelled, false);
	assert.deepEqual(result.details.answers, {
		"Which library should we use for date formatting?": "date-fns (Recommended)",
	});
	assert.equal(
		result.content[0].text,
		'User has answered your questions: "Which library should we use for date formatting?"="date-fns (Recommended)". You can now continue with the user\'s answers in mind.',
	);
});

it("reports a cancelled picker as cancelled, not as an answer", async () => {
	const ctx = { hasUI: true, ui: { custom: async () => ({ answers: undefined }) } };
	const result = await run(ctx);
	assert.equal(result.details.cancelled, true);
	assert.equal(result.details.reason, "cancelled");
	assert.match(result.content[0].text, /cancelled the questions without answering/);
});

it("rejects invalid input before any picker opens", async () => {
	let opened = false;
	const ctx = {
		hasUI: true,
		ui: {
			custom: async () => {
				opened = true;
				return { answers: undefined };
			},
		},
	};
	const result = await run(ctx, { questions: [{ ...question, multiSelect: true }] });
	assert.equal(result.details.reason, "invalid_input");
	assert.match(result.content[0].text, /multiSelect is not supported/);
	assert.equal(opened, false, "no picker is shown for invalid input");
});

let failed = 0;
for (const test of tests) {
	try {
		await test.body();
		console.log(`ok  ${test.name}`);
	} catch (error) {
		failed += 1;
		console.log(`not ok  ${test.name}\n    ${error.message}`);
	}
}
console.log(`ask-user-question tool: ${tests.length - failed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
