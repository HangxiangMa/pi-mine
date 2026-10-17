// Wiring for the pre-compaction cache (#18): the real extension handlers, driven through a fake pi.
// precompact-state.test.mjs covers the pure state machine. This file proves the handler passes pi's own
// cut (event.preparation.firstKeptEntryId) into the consume decision, so a mismatch falls back to pi.
import assert from "node:assert/strict";

// The assertions read the trace, which is emitted only in debug mode. Set it here so the test does not
// depend on the caller's environment.
process.env.PI_PRECOMPACT_DEBUG = "1";

const { default: precompact } = await import("../extensions/precompact/index.ts");

// The branch: the newest real user prompt is the anchor (u2), with one assistant reply after it.
const branch = [
	{ id: "u1", type: "message", message: { role: "user", content: [{ type: "text", text: "first" }] } },
	{ id: "a1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
	{ id: "u2", type: "message", message: { role: "user", content: [{ type: "text", text: "second" }] } },
	{ id: "a2", type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
];

// Context is above the 60% start fraction, so turn_end starts a pre-summary. `percent` is what
// contextFraction reads; the tokens/contextWindow pair is what the start check reads.
function buildHandlers() {
	const handlers = new Map();
	precompact({
		on(event, handler) {
			handlers.set(event, handler);
		},
	});
	return handlers;
}

function makeCtx(traces) {
	return {
		hasUI: true,
		model: { id: "m", maxTokens: 4000 },
		ui: { notify: (message) => traces.push(message) },
		sessionManager: { getBranch: () => branch },
		getContextUsage: () => ({ tokens: 150_000, contextWindow: 200_000, percent: 75 }),
		modelRegistry: {
			complete: async () => ({
				content: [{ type: "text", text: "A usable summary of the first exchange." }],
				stopReason: "stop",
				usage: { input: 10 },
			}),
		},
	};
}

// Drive turn_end until the pre-summary is ready (it runs in the background, so wait for the trace).
async function readyHandlers() {
	const handlers = buildHandlers();
	const traces = [];
	const ctx = makeCtx(traces);
	await handlers.get("session_start")({ type: "session_start" }, ctx);
	await handlers.get("turn_end")({ type: "turn_end" }, ctx);
	for (let i = 0; i < 50 && !traces.some((t) => t.includes("pre-summary ready")); i++) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.ok(traces.some((t) => t.includes("pre-summary ready")), `pre-summary must be ready, got ${traces}`);
	return { handlers, ctx, traces };
}

const tests = [];
function it(name, body) {
	tests.push({ name, body });
}

it("pi's cut equal to the entry after the anchor uses the pre-summary", async () => {
	const { handlers, ctx, traces } = await readyHandlers();
	const result = await handlers.get("session_before_compact")(
		{
			type: "session_before_compact",
			branchEntries: branch,
			customInstructions: undefined,
			preparation: { firstKeptEntryId: "a2", isSplitTurn: false, tokensBefore: 150_000 },
		},
		ctx,
	);
	assert.ok(result?.compaction, `expected a compaction result, got ${JSON.stringify(result)}`);
	assert.equal(result.compaction.firstKeptEntryId, "a2");
	assert.equal(result.compaction.summary, "A usable summary of the first exchange.");
	assert.ok(traces.some((t) => t.includes("pre-summary used for compaction")));
});

it("pi's cut on the anchor itself falls back to pi (no pre-summary used)", async () => {
	const { handlers, ctx, traces } = await readyHandlers();
	const result = await handlers.get("session_before_compact")(
		{
			type: "session_before_compact",
			branchEntries: branch,
			customInstructions: undefined,
			preparation: { firstKeptEntryId: "u2", isSplitTurn: false, tokensBefore: 150_000 },
		},
		ctx,
	);
	assert.equal(result, undefined, "a mismatched cut must not return a compaction");
	assert.ok(traces.some((t) => t.includes("pre-summary not used")), "the fallback is traced");
});

let failed = 0;
for (const { name, body } of tests) {
	try {
		await body();
		console.log(`ok  ${name}`);
	} catch (error) {
		failed += 1;
		console.log(`FAIL ${name}\n     ${error.message.split("\n")[0]}`);
	}
}
console.log(`precompact-wiring: ${tests.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
