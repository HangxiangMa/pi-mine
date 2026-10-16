import assert from "node:assert/strict";
import * as precompute from "../extensions/precompact/precompute-state.ts";

// Read through the namespace so a missing export fails only the test that needs it.
const { createPrecompute, reducePrecompute, consumeForCompaction, shouldStartPrecompute, coversBeforeCut, messagesOf, summaryMaxTokens } = precompute;

// Same tiny runner as the picker suites: collect cases, run them, print ok/FAIL, exit non-zero on failure.
const tests = [];
function it(name, body) {
	tests.push({ name, body });
}

// Model of the pre-compaction cache: summarise the history ahead of time while the
// session keeps working, then hand the result to the real compaction when it is due.
// The summary covers history up to `coveredThroughId`; it is reused only while that
// message is still on the active branch.

const WINDOW = 200_000;
const START_AT = 0.6; // begin pre-summarising at 60% of the window
const COMPACT_AT = 0.8; // real compaction threshold (context-budget compactThreshold)

const branch = ["m1", "m2", "m3", "m4", "m5"];

function run(steps, initial = createPrecompute()) {
	return steps.reduce((s, step) => reducePrecompute(s, step), initial);
}

it("starts a pre-summary once context passes the start fraction, not before", () => {
	assert.equal(shouldStartPrecompute({ tokens: 0.59 * WINDOW, window: WINDOW, start: START_AT }), false);
	assert.equal(shouldStartPrecompute({ tokens: 0.6 * WINDOW, window: WINDOW, start: START_AT }), true);
});

it("does not start a second pre-summary while one is already in flight", () => {
	const s = run([{ type: "start", coveredThroughId: "m3" }]);
	assert.equal(s.status, "running");
	const after = reducePrecompute(s, { type: "start", coveredThroughId: "m4" });
	assert.equal(after.coveredThroughId, "m3", "the in-flight attempt is kept, not replaced");
});

it("a finished pre-summary is consumed at compaction time when its prefix is still on the branch", () => {
	const s = run([
		{ type: "start", coveredThroughId: "m3" },
		{ type: "finish", summary: "S", usage: { input: 10 } },
	]);
	const result = consumeForCompaction(s, branch);
	assert.deepEqual(result, { use: true, summary: "S", coveredThroughId: "m3" });
});

it("a pre-summary whose covered message left the branch is discarded, not reused", () => {
	const s = run([
		{ type: "start", coveredThroughId: "m3" },
		{ type: "finish", summary: "S", usage: { input: 10 } },
	]);
	const rewoundBranch = ["m1", "m2"]; // /tree moved the head before m3
	const result = consumeForCompaction(s, rewoundBranch);
	assert.equal(result.use, false);
	assert.equal(result.reason, "covered message left the branch");
});

it("a user interrupt while pre-summarising discards the attempt", () => {
	const s = run([
		{ type: "start", coveredThroughId: "m3" },
		{ type: "abort" },
	]);
	assert.equal(s.status, "idle");
	assert.equal(consumeForCompaction(s, branch).use, false);
});

it("a failed pre-summary is never consumed", () => {
	const s = run([
		{ type: "start", coveredThroughId: "m3" },
		{ type: "fail", error: "rate limited" },
	]);
	assert.equal(s.status, "failed");
	assert.equal(consumeForCompaction(s, branch).use, false);
});

it("consuming a pre-summary resets the cache so the next cycle starts clean", () => {
	const s = run([
		{ type: "start", coveredThroughId: "m3" },
		{ type: "finish", summary: "S", usage: { input: 10 } },
	]);
	const after = reducePrecompute(s, { type: "consumed" });
	assert.equal(after.status, "idle");
	assert.equal(after.summary, undefined);
});

it("no pre-summary is ready when none was started", () => {
	assert.equal(consumeForCompaction(createPrecompute(), branch).use, false);
});

// pi decides the cut (firstKeptEntryId) only when it really compacts, and prepareCompaction is
// not exported from the package entry. A cached summary may therefore only stand in for pi's
// summary when everything it covers lies strictly before pi's cut. Anything at or past the cut
// would drop a kept message or duplicate one.
it("a cached summary covering only messages before pi's cut is usable", () => {
	assert.equal(coversBeforeCut(branch, "m2", "m4"), true, "m2 sits before the cut at m4");
});

it("a cached summary reaching the cut itself is not usable", () => {
	assert.equal(coversBeforeCut(branch, "m4", "m4"), false, "covering up to the cut would drop the kept m4");
});

it("a cached summary reaching past the cut is not usable", () => {
	assert.equal(coversBeforeCut(branch, "m5", "m3"), false, "the cache is ahead of pi's cut, so it would swallow kept messages");
});

it("a cached summary whose covered message is off the branch is not usable", () => {
	assert.equal(coversBeforeCut(branch, "x9", "m4"), false);
});

// A split turn makes pi produce two summaries (history plus the turn prefix) and merge them.
// A cached summary stands in for only one of them, so it would silently drop the other. The
// cache must step aside whenever pi reports a split turn.
it("a split turn never takes the cached summary, even when it is otherwise valid", () => {
	const s = run([
		{ type: "start", coveredThroughId: "m2" },
		{ type: "finish", summary: "S", usage: { input: 10 } },
	]);
	const result = consumeForCompaction(s, branch, { isSplitTurn: true });
	assert.equal(result.use, false);
	assert.equal(result.reason, "split turn needs two summaries");
});

it("a normal turn still takes the cached summary when the flag is false", () => {
	const s = run([
		{ type: "start", coveredThroughId: "m2" },
		{ type: "finish", summary: "S", usage: { input: 10 } },
	]);
	const result = consumeForCompaction(s, branch, { isSplitTurn: false });
	assert.equal(result.use, true);
});

// The summary call is async. If the user interrupts and a new attempt starts, a late result from
// the old attempt must not mark the new attempt ready. Each attempt carries an id; a finish or
// fail is applied only when it matches the attempt in flight.
it("a late result from an interrupted attempt does not overwrite a newer attempt", () => {
	let s = run([{ type: "start", attemptId: 1, coveredThroughId: "m2" }]);
	s = reducePrecompute(s, { type: "abort" });
	s = reducePrecompute(s, { type: "start", attemptId: 2, coveredThroughId: "m4" });
	// The first attempt finishes late, after attempt 2 has started.
	s = reducePrecompute(s, { type: "finish", attemptId: 1, summary: "STALE", usage: { input: 1 } });
	assert.equal(s.status, "running", "attempt 2 is still running, not ready from a stale result");
	assert.equal(s.summary, undefined);
});

it("the current attempt's result is applied normally", () => {
	let s = run([{ type: "start", attemptId: 2, coveredThroughId: "m4" }]);
	s = reducePrecompute(s, { type: "finish", attemptId: 2, summary: "OK", usage: { input: 1 } });
	assert.equal(s.status, "ready");
	assert.equal(s.summary, "OK");
});

// The summary model must see the conversation messages, not the raw session file. Only message
// entries carry conversation text; compaction, model-change and other metadata entries do not.
it("messagesOf keeps only message entries, in order, and returns their message payloads", () => {
	const entries = [
		{ id: "a", type: "model_change", model: "x" },
		{ id: "b", type: "message", message: { role: "user", content: "hi" } },
		{ id: "c", type: "compaction", summary: "old" },
		{ id: "d", type: "message", message: { role: "assistant", content: "yo" } },
	];
	assert.deepEqual(messagesOf(entries), [
		{ role: "user", content: "hi" },
		{ role: "assistant", content: "yo" },
	]);
});

// pi's own summary is capped at 80% of reserveTokens, and never above the model's limit. A cap
// smaller than that truncates long summaries: the summary stops mid-sentence and is discarded.
it("summaryMaxTokens matches pi: 80% of reserveTokens, capped by the model limit", () => {
	assert.equal(summaryMaxTokens({ reserveTokens: 16384, modelMaxTokens: 0 }), 13107);
	assert.equal(summaryMaxTokens({ reserveTokens: 16384, modelMaxTokens: 4096 }), 4096);
	assert.equal(summaryMaxTokens({ reserveTokens: 1000, modelMaxTokens: 8192 }), 800);
});

it("the real compaction threshold stays above the pre-summary start point", () => {
	assert.ok(START_AT < COMPACT_AT, "pre-summarising must begin before compaction is due");
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
console.log(`precompact-state: ${tests.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
