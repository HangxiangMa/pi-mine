import assert from "node:assert/strict";
import test from "node:test";

const { formatGraftContext, shouldRetrieve, truncateOutput } = await import(
	"../extensions/graft.ts"
);

test("Graft retrieval skips short and command prompts", () => {
	assert.equal(shouldRetrieve("hi"), false);
	assert.equal(shouldRetrieve("/help with graft"), false);
	assert.equal(shouldRetrieve("where is the auth flow implemented?"), true);
});

test("Graft context is bounded and marked", () => {
	assert.equal(formatGraftContext(""), undefined);
	assert.equal(formatGraftContext("answer"), "<graft-context>\nanswer\n</graft-context>");
	assert.match(truncateOutput("x".repeat(5), 3), /graft output truncated/);
});
