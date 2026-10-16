import assert from "node:assert/strict";
import * as gate from "../extensions/idle-recap-gate.ts";

// Read through the namespace so a missing export fails only the test that needs it.
const { conversationFingerprint, shouldForceRecap } = gate;

// The context-threshold trigger fires on every agent_end once usage is high. While the user
// stays idle the conversation does not change, so re-running /recap only spends a model call
// on a summary that is already current. The gate compares a fingerprint of the recent turns.

const turn = (user, assistant) => [
	{ role: "user", content: [{ type: "text", text: user }] },
	{ role: "assistant", content: [{ type: "text", text: assistant }] },
];
const conversation = [...turn("add retry", "done, added retry"), ...turn("now the tests", "tests pass")];

const tests = [];
function it(name, body) {
	tests.push({ name, body });
}

it("the same conversation gives the same fingerprint", () => {
	assert.equal(conversationFingerprint(conversation, 4), conversationFingerprint([...conversation], 4));
});

it("a new assistant reply changes the fingerprint", () => {
	const before = conversationFingerprint(conversation, 4);
	const after = conversationFingerprint([...conversation, ...turn("ok", "ship it")], 4);
	assert.notEqual(before, after);
});

it("a changed message inside the recent window changes the fingerprint", () => {
	const edited = conversation.map((m, i) =>
		i === conversation.length - 1 ? { ...m, content: [{ type: "text", text: "tests FAIL" }] } : m,
	);
	assert.notEqual(conversationFingerprint(conversation, 4), conversationFingerprint(edited, 4));
});

it("the same text under a different role is a different conversation", () => {
	// A user line and an assistant line with identical text must not be confused for each other.
	const asUser = [{ role: "user", content: [{ type: "text", text: "ok" }] }];
	const asAssistant = [{ role: "assistant", content: [{ type: "text", text: "ok" }] }];
	assert.notEqual(conversationFingerprint(asUser, 4), conversationFingerprint(asAssistant, 4));
});

it("swapping two turns with the same text but different order is a change", () => {
	const ab = [{ role: "user", content: "a" }, { role: "assistant", content: "b" }];
	const ba = [{ role: "user", content: "b" }, { role: "assistant", content: "a" }];
	assert.notEqual(conversationFingerprint(ab, 4), conversationFingerprint(ba, 4));
});

it("a new bash result changes the fingerprint even though it has no content field", () => {
	// A bash execution message carries its text in command/output, not content. A new command or a
	// different output is a real change to the conversation and must not be skipped as unchanged.
	const bash = (output) => [
		{ role: "bashExecution", command: "npm test", output, exitCode: 0, cancelled: false, truncated: false },
	];
	assert.notEqual(conversationFingerprint(bash("ok 1"), 4), conversationFingerprint(bash("not ok 1"), 4));
});

it("moving text between command and output is a change, not a collision", () => {
	// Without a separator, command="ab" output="c" would hash the same as command="a" output="bc".
	const run = (command, output) => [{ role: "bashExecution", command, output }];
	assert.notEqual(conversationFingerprint(run("ab", "c"), 4), conversationFingerprint(run("a", "bc"), 4));
});

it("a change older than the window does not change the fingerprint", () => {
	// Only the last `depth` messages are fingerprinted. Editing the very first message, which is
	// outside a window of 2, must not force a new recap while the recent turns are unchanged.
	const longer = [...turn("a", "b"), ...turn("c", "d"), ...turn("e", "f")];
	const oldEdited = longer.map((m, i) => (i === 0 ? { ...m, content: [{ type: "text", text: "CHANGED" }] } : m));
	assert.equal(conversationFingerprint(longer, 2), conversationFingerprint(oldEdited, 2));
});

it("an empty conversation has a stable fingerprint and never forces a recap", () => {
	assert.equal(shouldForceRecap({ fingerprint: conversationFingerprint([], 4), lastFingerprint: undefined }), false);
});

it("the first recap for a non-empty conversation is allowed", () => {
	const fp = conversationFingerprint(conversation, 4);
	assert.equal(shouldForceRecap({ fingerprint: fp, lastFingerprint: undefined }), true);
});

it("an idle user with an unchanged conversation does not force a repeat recap", () => {
	const fp = conversationFingerprint(conversation, 4);
	assert.equal(shouldForceRecap({ fingerprint: fp, lastFingerprint: fp }), false);
});

it("a changed conversation forces a recap again", () => {
	const last = conversationFingerprint(conversation, 4);
	const now = conversationFingerprint([...conversation, ...turn("x", "y")], 4);
	assert.equal(shouldForceRecap({ fingerprint: now, lastFingerprint: last }), true);
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
console.log(`idle-recap-gate: ${tests.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
