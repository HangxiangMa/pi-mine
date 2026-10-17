import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as precompute from "../extensions/precompact/precompute-state.ts";

// Read through the namespace so a missing export fails only the test that needs it.
const {
	createPrecompute,
	reducePrecompute,
	consumeForCompaction,
	shouldStartPrecompute,
	messagesOf,
	anchorIndexOf,
	summaryInputOf,
	summaryMaxTokens,
	summaryRequestText,
	summaryPreview,
} = precompute;

// Same tiny runner as the picker suites: collect cases, run them, print ok/FAIL, exit non-zero on failure.
const tests = [];
function it(name, body) {
	tests.push({ name, body });
}

// Model of the pre-compaction cache, following Claude Code's native precomputed compact (2.1.286).
// The summary covers the branch up to an anchor (the newest user prompt at start time). The cache
// records the branch prefix through the anchor, and is reused only while that prefix is still on
// the active branch. Everything after the anchor is kept verbatim; pi's own cut does not decide it.

const WINDOW = 200_000;
const START_AT = 0.6; // begin pre-summarising at 60% of the window
const COMPACT_AT = 0.8; // real compaction threshold (context-budget compactThreshold)

const branch = ["m1", "m2", "m3", "m4", "m5"];

// The prefix a pre-summary anchored at `id` records: every branch id through that anchor.
function prefixThrough(id, ids = branch) {
	return ids.slice(0, ids.indexOf(id) + 1);
}

function startAt(id, extra = {}) {
	return { type: "start", coveredThroughId: id, prefix: prefixThrough(id), ...extra };
}

function run(steps, initial = createPrecompute()) {
	return steps.reduce((s, step) => reducePrecompute(s, step), initial);
}

function readyAt(id, extra = {}) {
	return run([startAt(id, extra), { type: "finish", summary: "S", usage: { input: 10 } }]);
}

it("starts a pre-summary once context passes the start fraction, not before", () => {
	assert.equal(shouldStartPrecompute({ tokens: 0.59 * WINDOW, window: WINDOW, start: START_AT }), false);
	assert.equal(shouldStartPrecompute({ tokens: 0.6 * WINDOW, window: WINDOW, start: START_AT }), true);
});

it("does not start a second pre-summary while one is already in flight", () => {
	const s = run([startAt("m3")]);
	assert.equal(s.status, "running");
	const after = reducePrecompute(s, startAt("m4"));
	assert.deepEqual(after.prefix, prefixThrough("m3"), "the in-flight attempt is kept, not replaced");
});

it("a finished pre-summary is consumed when its prefix is still on the branch, keeping everything after the anchor", () => {
	const result = consumeForCompaction(readyAt("m3"), branch, { piFirstKeptEntryId: "m4" });
	assert.deepEqual(result, { use: true, summary: "S", coveredThroughId: "m3", firstKeptEntryId: "m4" });
});

it("an anchor in the middle keeps every later entry verbatim, starting right after it", () => {
	const result = consumeForCompaction(readyAt("m2"), branch, { piFirstKeptEntryId: "m3" });
	assert.equal(result.use, true);
	assert.equal(result.firstKeptEntryId, "m3", "m3..m5 are kept, m1..m2 are in the summary");
});

it("a pre-summary whose anchor left the branch is discarded, not reused", () => {
	const rewoundBranch = ["m1", "m2"]; // /tree moved the head before m3
	const result = consumeForCompaction(readyAt("m3"), rewoundBranch);
	assert.equal(result.use, false);
	assert.equal(result.reason, "covered message left the branch");
});

it("a pre-summary is not usable when the branch prefix before the anchor changed", () => {
	const edited = ["m1", "X", "m3", "m4", "m5"]; // m2 was replaced on the branch
	const result = consumeForCompaction(readyAt("m3"), edited);
	assert.equal(result.use, false);
	assert.equal(result.reason, "branch prefix changed");
});

it("a pre-summary is not usable when the anchor is the last entry, leaving nothing to keep", () => {
	const result = consumeForCompaction(readyAt("m5"), branch);
	assert.equal(result.use, false);
	assert.equal(result.reason, "no entry after the anchor");
});

it("a pre-summary is not usable when the custom instructions differ", () => {
	const s = readyAt("m3", { instructions: "focus on tests" });
	const result = consumeForCompaction(s, branch, { instructions: "focus on docs" });
	assert.equal(result.use, false);
	assert.equal(result.reason, "custom instructions changed");
});

it("a pre-summary built without instructions is not used for a compact with instructions", () => {
	const result = consumeForCompaction(readyAt("m3"), branch, { instructions: "focus on docs" });
	assert.equal(result.use, false);
	assert.equal(result.reason, "custom instructions changed");
});

it("a user interrupt while pre-summarising discards the attempt", () => {
	const s = run([startAt("m3"), { type: "abort" }]);
	assert.equal(s.status, "idle");
	assert.equal(consumeForCompaction(s, branch).use, false);
});

it("a failed pre-summary is never consumed", () => {
	const s = run([startAt("m3"), { type: "fail", error: "rate limited" }]);
	assert.equal(s.status, "failed");
	assert.equal(consumeForCompaction(s, branch).use, false);
});

it("consuming a pre-summary resets the cache so the next cycle starts clean", () => {
	const after = reducePrecompute(readyAt("m3"), { type: "consumed" });
	assert.equal(after.status, "idle");
	assert.equal(after.summary, undefined);
});

it("no pre-summary is ready when none was started", () => {
	assert.equal(consumeForCompaction(createPrecompute(), branch).use, false);
});

// A user message must not discard a finished pre-summary. The anchor and prefix checks already reject
// a cache that no longer fits, so the only reason to drop a ready cache is one of those checks.
it("a ready pre-summary survives a user message: a user message cancels only an attempt in flight", () => {
	const s = readyAt("m3");
	const afterMessage = reducePrecompute(s, { type: "userMessage" });
	assert.equal(afterMessage.status, "ready", "the finished summary must not be wiped by a user message");
	assert.equal(consumeForCompaction(afterMessage, branch, { piFirstKeptEntryId: "m4" }).use, true);
});

it("a user message still cancels an attempt that is in flight", () => {
	const s = run([startAt("m3")]);
	const afterMessage = reducePrecompute(s, { type: "userMessage" });
	assert.equal(afterMessage.status, "idle", "the in-flight attempt is cancelled");
});

// A late result from an interrupted attempt must not mark a newer attempt ready. Each attempt carries
// an id; a finish or fail is applied only when it matches the attempt in flight.
it("a late result from an interrupted attempt does not overwrite a newer attempt", () => {
	let s = run([startAt("m2", { attemptId: 1 })]);
	s = reducePrecompute(s, { type: "abort" });
	s = reducePrecompute(s, startAt("m4", { attemptId: 2 }));
	s = reducePrecompute(s, { type: "finish", attemptId: 1, summary: "STALE", usage: { input: 1 } });
	assert.equal(s.status, "running", "attempt 2 is still running, not ready from a stale result");
	assert.equal(s.summary, undefined);
});

it("the current attempt's result is applied normally", () => {
	let s = run([startAt("m4", { attemptId: 2 })]);
	s = reducePrecompute(s, { type: "finish", attemptId: 2, summary: "OK", usage: { input: 1 } });
	assert.equal(s.status, "ready");
	assert.equal(s.summary, "OK");
});

// The summary model sees conversation messages, not the raw session file. Only message entries carry text.
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

// The anchor is the newest real user prompt. Tool results and assistant turns are not prompts.
it("the anchor is the newest user prompt, skipping assistant and tool-result messages", () => {
	const entries = [
		{ id: "m1", type: "message", message: { role: "user", content: "a" } },
		{ id: "m2", type: "message", message: { role: "assistant", content: "b" } },
		{ id: "m3", type: "message", message: { role: "toolResult", content: "c" } },
		{ id: "m4", type: "message", message: { role: "assistant", content: "d" } },
	];
	assert.equal(anchorIndexOf(entries), 0);
});

it("there is no anchor on a branch with no user prompt", () => {
	assert.equal(anchorIndexOf([{ id: "m1", type: "message", message: { role: "assistant" } }]), -1);
	assert.equal(anchorIndexOf([]), -1);
});

// Without a previous compaction, the input is every message up to and including the anchor.
it("the summary input with no previous compaction is the branch through the anchor", () => {
	const entries = [
		{ id: "m1", type: "message", message: { role: "user", content: "a" } },
		{ id: "m2", type: "message", message: { role: "assistant", content: "b" } },
		{ id: "m3", type: "message", message: { role: "user", content: "c" } },
		{ id: "m4", type: "message", message: { role: "assistant", content: "d" } },
	];
	const input = summaryInputOf(entries, 2);
	assert.equal(input.previousSummary, undefined);
	assert.deepEqual(messagesOf(input.entries).map((m) => m.content), ["a", "b", "c"]);
});

// After a compaction, pi's projection carries the previous summary plus the retained tail from its
// firstKeptEntryId. The tail was never summarised, so it belongs in the next input; the earlier
// messages were summarised into the previous summary and must not be sent again.
it("after a compaction the input is the previous summary plus the retained tail through the anchor, no duplicates", () => {
	const entries = [
		{ id: "m1", type: "message", message: { role: "user", content: "m1" } },
		{ id: "m2", type: "message", message: { role: "assistant", content: "m2" } },
		{ id: "m3", type: "message", message: { role: "user", content: "m3" } },
		{ id: "m4", type: "message", message: { role: "assistant", content: "m4" } },
		{ id: "c1", type: "compaction", summary: "PREV", firstKeptEntryId: "m3" },
		{ id: "m5", type: "message", message: { role: "user", content: "m5" } },
		{ id: "m6", type: "message", message: { role: "assistant", content: "m6" } },
		{ id: "m7", type: "message", message: { role: "user", content: "m7" } },
	];
	const input = summaryInputOf(entries, anchorIndexOf(entries));
	assert.equal(input.previousSummary, "PREV");
	assert.deepEqual(
		messagesOf(input.entries).map((m) => m.content),
		["m3", "m4", "m5", "m6", "m7"],
		"m1 and m2 were summarised into PREV and must not be sent again",
	);
});

it("the summary input is unavailable when the kept tail of the previous compaction is gone", () => {
	const entries = [
		{ id: "m2", type: "message", message: { role: "user", content: "m2" } },
		{ id: "c1", type: "compaction", summary: "PREV", firstKeptEntryId: "gone" },
		{ id: "m3", type: "message", message: { role: "user", content: "m3" } },
	];
	assert.equal(summaryInputOf(entries, 2), undefined);
});

it("summaryMaxTokens matches pi: 80% of reserveTokens, capped by the model limit", () => {
	assert.equal(summaryMaxTokens({ reserveTokens: 16384, modelMaxTokens: 0 }), 13107);
	assert.equal(summaryMaxTokens({ reserveTokens: 16384, modelMaxTokens: 4096 }), 4096);
	assert.equal(summaryMaxTokens({ reserveTokens: 1000, modelMaxTokens: 8192 }), 800);
});

// The pure rules above are only useful if index.ts uses them. A unit test cannot see that wiring.
it("the pre-summary is built from pi's projection through the anchor, and its prefix is recorded", () => {
	const source = readFileSync(new URL("../extensions/precompact/index.ts", import.meta.url), "utf8");
	assert.match(source, /anchorIndexOf\(/, "the anchor is the newest user prompt");
	assert.match(source, /summaryInputOf\(/, "the input comes from pi's projection, not raw messages");
	assert.match(source, /const prefix = branch\.slice\(0, anchor \+ 1\)/, "the prefix through the anchor is computed from the branch");
	assert.match(source, /\n\t\t\tprefix,\n/, "the prefix is passed into the start action");
});

// Replaced a source-text check: the framing now lives in summaryRequestText, and the behaviour is
// asserted by the 'previous summary is framed' request-shape test below.
it("the pre-summary request is built by summaryRequestText, which the extension calls", () => {
	const source = readFileSync(new URL("../extensions/precompact/index.ts", import.meta.url), "utf8");
	assert.match(source, /summaryRequestText\(conversation,\s*input\.previousSummary\)/, "the request text comes from the tested builder");
});

it("the consume decision supplies the cut from the anchor, and the custom instructions are passed in", () => {
	const source = readFileSync(new URL("../extensions/precompact/index.ts", import.meta.url), "utf8");
	assert.match(source, /firstKeptEntryId:\s*decision\.firstKeptEntryId/, "the cut comes from the cache decision");
	assert.doesNotMatch(source, /firstKeptEntryId:\s*event\.preparation\.firstKeptEntryId/, "pi's own cut is no longer used");
	assert.match(source, /instructions:\s*event\.customInstructions/, "custom instructions must match the summary");
});

it("a user message handler cancels only an attempt in flight, not a ready cache", () => {
	const source = readFileSync(new URL("../extensions/precompact/index.ts", import.meta.url), "utf8");
	assert.match(source, /type: "userMessage"/, "the user message is reported as its own action");
	assert.doesNotMatch(source, /message_start[\s\S]*?abortInFlight\(\);\s*\}\s*catch/, "message_start must not reset a ready cache");
});

it("the real compaction threshold stays above the pre-summary start point", () => {
	assert.ok(START_AT < COMPACT_AT, "pre-summarising must begin before compaction is due");
});

// User decision (2026-10-16): match native Claude Code, which fails a summary only when it is empty
// (errorKind 'empty_summary'). No invented length floor. The echo defence is the request framing
// (summaryRequestText), which live run 4 showed turns the reply into a real summary.
it("an empty or blank pre-summary reply is rejected, as native does", () => {
	assert.equal(typeof precompute.isUsableSummary, "function", "isUsableSummary is exported");
	assert.equal(precompute.isUsableSummary(""), false, "an empty reply is not a summary");
	assert.equal(precompute.isUsableSummary("   \n\t  "), false, "a blank reply is not a summary");
});

// Known limit, stated on purpose: a short non-empty reply is accepted under the native rule. Live run 2
// showed the summariser echoing a 2-char instruction reply. That is now prevented by the request framing,
// not by a length floor. This test pins the accepted behaviour so the trade-off stays visible.
it("a short non-empty reply is accepted under the native rule (known trade-off)", () => {
	assert.equal(precompute.isUsableSummary("收到"), true, "native accepts any non-empty summary text");
});

it("a real multi-paragraph summary is accepted as usable", () => {
	assert.equal(typeof precompute.isUsableSummary, "function", "isUsableSummary is exported");
	const real =
		"## Goal\nFinish the precompact fix so a pre-summary is used on /compact with the anchor rule.\n\n" +
		"## Decisions\n- The anchor is the newest real user prompt, so no tool call is split from its result.\n" +
		"- The cache is consumed only when the recorded prefix is still on the branch.\n\n" +
		"## Files touched\n- extensions/precompact/index.ts and precompute-state.ts, plus their tests.\n\n" +
		"## Open next steps\n- Verify use:true in a live pi session with gpt-6-luna.\n" +
		"- Check the summary reply length guard against a real summariser reply.";
	assert.ok(real.length >= 200, `fixture is a realistic summary length (${real.length})`);
	assert.equal(precompute.isUsableSummary(real), true);
});

// Live finding (2026-10-16, run 2): the summariser answered the transcript's last user message ('只回复一个词：收到')
// with '收到'. The request sent the transcript bare, with the summarise instruction only in the system prompt.
// The fix frames the request the way pi does: the transcript in <conversation> tags, then the instruction.
it("the summary request wraps the transcript in <conversation> tags, as pi does", () => {
	const text = summaryRequestText("[User]: 只回复一个词：收到\n[Assistant]: 收到", undefined);
	assert.match(text, /^<conversation>\n/, "the transcript starts inside <conversation>");
	assert.match(text, /\n<\/conversation>/, "the transcript is closed by </conversation>");
});

it("the summary instruction comes after the transcript, so it is the last thing the model reads", () => {
	const text = summaryRequestText("[User]: 只回复一个词：收到", undefined);
	const close = text.indexOf("</conversation>");
	const instruction = text.search(/summar/i);
	assert.ok(close > 0, "the transcript is closed");
	assert.ok(instruction > close, "the summarise instruction follows the transcript");
});

it("a previous summary is framed as <previous-summary> before the transcript, as pi does", () => {
	const text = summaryRequestText("[User]: next", "the earlier summary");
	const prev = text.indexOf("<previous-summary>");
	const conv = text.indexOf("<conversation>");
	assert.ok(prev >= 0, "the previous summary is framed");
	assert.ok(prev < conv, "the previous summary comes before the transcript");
	assert.match(text, /the earlier summary/, "the previous summary text is kept");
});

// Live finding (run 3): the failure trace showed only the reply length (95), so the content could not be
// judged. The preview lets a debug run show what the summariser actually returned.
it("the summary preview collapses whitespace so it reads on one trace line", () => {
	assert.equal(summaryPreview("line one\n\n  line   two\n", 80), "line one line two");
});

it("the summary preview is cut to the requested length", () => {
	const preview = summaryPreview("a".repeat(500), 120);
	assert.equal(preview.length, 120);
});

it("a short reply is kept whole in the preview", () => {
	assert.equal(summaryPreview("收到", 120), "收到");
});

// Follow pi's own cut (#18, user decision). The cache is used only when pi would keep exactly the
// entry after the anchor. Otherwise pi's kept range and the cached summary would disagree, and the
// messages between them would be lost or duplicated.
it("a pre-summary is used when pi's own cut is the entry right after the anchor", () => {
	const result = consumeForCompaction(readyAt("m3"), branch, { piFirstKeptEntryId: "m4" });
	assert.deepEqual(result, { use: true, summary: "S", coveredThroughId: "m3", firstKeptEntryId: "m4" });
});

it("a pre-summary is not used when pi would keep the anchor itself, so the cached summary is incomplete", () => {
	const result = consumeForCompaction(readyAt("m3"), branch, { piFirstKeptEntryId: "m3" });
	assert.equal(result.use, false);
	assert.equal(result.reason, "pi's cut differs from the entry after the anchor");
});

it("a pre-summary is not used when pi's cut is further along than the entry after the anchor", () => {
	const result = consumeForCompaction(readyAt("m2"), branch, { piFirstKeptEntryId: "m4" });
	assert.equal(result.use, false);
	assert.equal(result.reason, "pi's cut differs from the entry after the anchor");
});

it("a pre-summary is not used when pi gives no cut to compare against", () => {
	const result = consumeForCompaction(readyAt("m3"), branch, {});
	assert.equal(result.use, false);
	assert.equal(result.reason, "pi's cut differs from the entry after the anchor");
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
