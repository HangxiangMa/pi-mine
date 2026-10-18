import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	isCancelKey,
	PROMPT_HINT,
	renderRunLines,
	runIdForRow,
	sendDecision,
	SubagentRunComponent,
	openSubagentRunView,
} from "../extensions/subagent/run-view.ts";

// `c` cancels only on an empty prompt, so a typed `c` is never swallowed as a command.
assert.equal(isCancelKey("c", ""), true, "c on an empty prompt cancels");
assert.equal(isCancelKey("c", "draft"), false, "c while typing is text, not cancel");
assert.equal(isCancelKey("x", ""), false, "other keys never cancel");
assert.match(PROMPT_HINT, /c cancel/, "the hint names the real cancel key");
assert.doesNotMatch(PROMPT_HINT, /Ctrl\+Alt\+I/, "the hint no longer names the removed Ctrl+Alt+I shortcut");

for (const kind of ["sub", "delegate"]) {
	for (const state of ["running", "finished", "missing"]) {
		for (const text of ["", " \t\n"]) assert.equal(sendDecision(kind, state, text).action, "noop");
		const decision = sendDecision(kind, state, "new prompt");
		assert.equal(decision.action, kind === "sub" ? state === "running" ? "steer" : "continue" : state === "running" ? "guide" : "refuse");
		if (decision.action === "refuse") assert.ok(decision.reason.length > 0);
	}
}
const rowRuns = new Map([["sub:call:0", "fleet-a"], ["sub:call:1", "fleet-b"]]);
assert.equal(runIdForRow("sub:call:0", rowRuns), "fleet-a");
assert.equal(runIdForRow("sub:call:1", rowRuns), "fleet-b");
rowRuns.set("sub:call:0", "continued-fleet");
assert.equal(runIdForRow("sub:call:0", rowRuns), "continued-fleet");
assert.equal(runIdForRow("sub:unknown:0", rowRuns), undefined);
assert.equal(runIdForRow("other", rowRuns), undefined);
assert.equal(runIdForRow("delegate:external-run", rowRuns), "external-run");
assert.equal(runIdForRow("delegate:", rowRuns), undefined);

const snapshot = {
	id: "fleet-a", agent: "deep-coder", task: "example", model: "provider/model",
	status: "running", startedAt: 1000, output: Array.from({ length: 15 }, (_, i) => `output-${i}`).join("\n"),
	stderr: "", inputTokens: 1234, outputTokens: 56,
};
const liveSnapshot = { ...snapshot, output: "assistant is still streaming", stderr: "No project session found" };
assert.match(renderRunLines(liveSnapshot, 100).join("\n"), /assistant is still streaming/);
assert.doesNotMatch(renderRunLines(liveSnapshot, 100).join("\n"), /No project session found/);
const prompts = Array.from({ length: 6 }, (_, i) => ({ text: `prompt-${i}`, disposition: i === 5 ? "refused: cancelled" : "queued" }));
const rendered = renderRunLines(snapshot, 100, prompts, 62000).join("\n");
for (const text of ["deep-coder", "provider/model", "running", "1m01s", "↑1,234", "↓56", PROMPT_HINT, "refused: cancelled", "prompt-5"]) assert.ok(rendered.includes(text), text);
assert.ok(!rendered.includes("output-4"));
assert.ok(rendered.includes("output-5") && rendered.includes("output-14"));
assert.ok(!rendered.includes("prompt-2") && rendered.includes("prompt-3"));
assert.match(renderRunLines({ ...snapshot, status: "failed", output: "", stderr: "diagnostic" }, 80).join("\n"), /diagnostic/);
assert.match(renderRunLines(undefined, 80).join("\n"), /missing/);
for (const width of [0, 1, 2, 3, 12, 30, 80]) {
	for (const line of renderRunLines({ ...snapshot, agent: "中🙂文", output: "\x1b[31m中🙂\x1b[0m\x07" }, width)) assert.ok(visibleWidth(line) <= width);
}
for (const width of [3, 12, 30, 80]) {
	for (const height of [0, 1, 4, 7, 8, 9, 24]) {
		assert.ok(renderRunLines(snapshot, width, prompts, 62000, ["> "], height).length <= height);
	}
}

// The `c` key reaches actions.cancel only on an empty prompt, and typed text still reaches Input.
{
	let cancels = 0;
	const live = new SubagentRunComponent({ requestRender: () => {}, terminal: { rows: 30 } }, {
		snapshot: () => snapshot,
		send: () => "queued",
		cancel: () => { cancels++; return "Cancel requested."; },
	}, () => {});
	live.focused = true;
	live.handleInput("c"); // empty prompt: cancel
	assert.equal(cancels, 1, "c on an empty prompt cancels the live run");
	live.handleInput("o"); // now the prompt holds text
	live.handleInput("c"); // typed into the prompt, must not cancel again
	assert.equal(cancels, 1, "c while typing is text, not a second cancel");
	assert.equal(live.render(40).join("\n").includes("oc"), true, "the typed text keeps the c");
	live.dispose();
}

let sends = 0;
let closes = 0;
let renders = 0;
const component = new SubagentRunComponent({ requestRender: () => renders++, terminal: { rows: 30 } }, {
	snapshot: () => snapshot,
	send: (text) => { sends++; assert.equal(text, "cqpkx"); return "queued"; },
}, () => closes++);
component.focused = true;
assert.equal(component.focused, true);
component.handleInput("cqpkx"); // Printable monitor keys must remain input.
component.handleInput("\x01"); // Ctrl+A, then Ctrl+K edits text, never cancels the run.
component.handleInput("\x0b");
component.handleInput("cqpkx");
component.handleInput("\r");
assert.equal(sends, 1);
assert.match(component.render(80).join("\n"), /queued.*cqpkx/);
assert.equal(closes, 0);
const beforeRefresh = renders;
await new Promise((resolve) => setTimeout(resolve, 550));
assert.ok(renders > beforeRefresh, "500 ms live refresh");
component.handleInput("\x1b");
assert.equal(closes, 1);
const afterClose = renders;
await new Promise((resolve) => setTimeout(resolve, 550));
assert.equal(renders, afterClose, "closing disposes refresh timer");

let focused = false;
await openSubagentRunView({ hasUI: true, ui: { custom: async (factory, options) => {
	assert.equal(options.overlay, true);
	options.onHandle({ focus: () => { focused = true; } });
	const ui = factory({ requestRender() {} }, {}, {}, () => {});
	ui.handleInput("\x1b");
} } }, { snapshot: () => snapshot, send: () => "queued" });
assert.ok(focused);
console.log("subagent-run-view: decision, identity, render, input and refresh checks passed");

// Exercise real execute/controllers with protocol-only children and an isolated store.
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const paths = JSON.parse(execFileSync("bash", ["-c", 'source tests/lib/pi-jiti.sh; locate_pi_jiti || exit 1; node -e \'console.log(JSON.stringify({jiti:process.env.PI_JITI,tui:process.env.PI_TUI,pkg:process.env.PI_CODING_AGENT_PKG}))\''], { cwd: root, encoding: "utf8" }));
const temp = mkdtempSync(path.join(tmpdir(), "subagent-run-view-"));
const oldEnv = { ...process.env };
const oldScript = process.argv[1];
let sub;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (predicate, label) => {
	for (let i = 0; i < 200; i++) { if (predicate()) return; await sleep(25); }
	assert.fail(`Timed out: ${label}`);
};
try {
	mkdirSync(path.join(temp, "agents"));
	copyFileSync(path.resolve(root, "../../agents/deep-reviewer.md"), path.join(temp, "agents/deep-reviewer.md"));
	// runSingleAgent reuses process.argv[1] as its CLI; point it at the stand-in, never this test.
	process.argv[1] = path.join(root, "tests/lib/fake-pi-rpc.cjs");
	const shim = path.join(temp, "shim.cjs");
	writeFileSync(shim, `module.exports = { ...require(${JSON.stringify(paths.pkg)}), getAgentDir: () => ${JSON.stringify(temp)} };\n`);
	process.env.PI_SUBAGENT_SESSION_DIR = path.join(temp, "sessions");
	process.env.FAKE_PI_LOG = path.join(temp, "stdin.jsonl");
	process.env.FAKE_PI_ARGV_LOG = path.join(temp, "argv.jsonl");
	delete process.env.FAKE_PI_HOLD;
	delete process.env.FAKE_PI_REPLY_FILE;
	delete process.env.FAKE_PI_REPLY_PARTS;
	writeFileSync(process.env.FAKE_PI_LOG, "");
	writeFileSync(process.env.FAKE_PI_ARGV_LOG, "");
	const jiti = require(paths.jiti)(root, { interopDefault: true, alias: { "@earendil-works/pi-coding-agent": shim, "@earendil-works/pi-tui": paths.tui } });
	sub = jiti(path.join(root, "extensions/subagent/index.ts"));
	const formatToolExecutionStart = sub.formatToolExecutionStart;
	assert.equal(formatToolExecutionStart({ toolName: "bash", args: { command: "ls -la" } }), "→ bash: ls -la");
	assert.equal(formatToolExecutionStart({ toolName: "read", args: { path: "src/foo.ts" } }), "→ read: src/foo.ts");
	const longTrace = formatToolExecutionStart({ toolName: "custom", args: { value: "x".repeat(200), note: "line\nbreak" } });
	assert.ok(longTrace.length <= 120);
	assert.doesNotMatch(longTrace, /[\r\n]/);
	const liveOutput = sub.composeSubagentMonitorOutput("", "live assistant text", ["→ bash: ls -la"], true);
	assert.ok(renderRunLines({ ...snapshot, output: liveOutput }, 100).join("\n").includes("live assistant text"));
	assert.ok(liveOutput.indexOf("→ bash: ls -la") < liveOutput.indexOf("live assistant text"));
	const staleTurn = sub.composeSubagentMonitorOutput("turn1 answer", "turn2 partial", ["→ bash: ls"], true);
	assert.ok(staleTurn.includes("turn2 partial"));
	assert.ok(!staleTurn.includes("turn1 answer"));
	assert.ok(staleTurn.indexOf("→ bash: ls") < staleTurn.indexOf("turn2 partial"));
	const finalOutput = sub.composeSubagentMonitorOutput("final assistant text", "stale live text", ["→ bash: ls -la"], false);
	assert.equal(finalOutput, "final assistant text");
	assert.match(renderRunLines({ ...snapshot, output: finalOutput }, 100).join("\n"), /final assistant text/);
	const dock = jiti(path.join(root, "extensions/task-dock.ts"));
	const tools = {};
	const followUps = [];
	const pi = {
		registerTool: (tool) => { tools[tool.name] = tool; }, registerShortcut() {}, registerCommand() {}, on() {}, registerMessageRenderer() {},
		events: { on() { return () => {}; }, emit() {} },
		sendUserMessage: (...args) => { followUps.push(args); return Promise.resolve(); },
	};
	sub.default(pi);
	const ctx = { cwd: root, hasUI: true, ui: {}, sessionManager: {} };
	const run = (id, params) => tools.subagent_routed.execute(id, params, undefined, undefined, ctx);
	const single = (id) => run(id, { agent: "deep-reviewer", task: id, run_in_background: false });
	const records = (file) => readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
	const argvRecords = () => records(process.env.FAKE_PI_ARGV_LOG);
	const sessionId = ({ argv }) => argv[argv.indexOf("--session-id") + 1];
	await single("view-sync");
	const view = sub.createSubagentRunView(ctx, "sub:view-sync:0");
	assert.equal(view.snapshot().task, "view-sync");
	assert.equal(view.snapshot().status, "completed");
	const firstId = view.snapshot().id;
	const firstSession = sessionId(argvRecords().at(-1));
	assert.equal(view.send("  "), undefined);
	assert.equal(view.send("continue the session"), "continued");
	assert.notEqual(view.snapshot().id, firstId);
	assert.equal(view.snapshot().status, "running");
	await until(() => view.snapshot()?.status === "completed", "view continuation");
	assert.equal(sessionId(argvRecords().at(-1)), firstSession);
	assert.equal(dock.__test.peekTask("sub:view-sync:0").state, "done");
	assert.match(view.snapshot().output, /FAKE-OK/);
	assert.equal(followUps.length, 0, "view continuation must not steer the parent");
	assert.equal(sub.resolveSubagentResume(view.snapshot().id, "next").stableRunId, firstId);

	// An async pre-spawn failure must be visible as failed, not persisted as a success.
	const originalTmpdir = process.env.TMPDIR;
	process.env.TMPDIR = path.join(temp, "missing-tmp-parent");
	assert.equal(view.send("startup failure"), "continued");
	await until(() => dock.__test.peekTask("sub:view-sync:0")?.state === "error", "startup failure reporting");
	assert.equal(view.snapshot().status, "failed");
	assert.match(view.snapshot().stderr, /ENOENT/);
	if (originalTmpdir === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = originalTmpdir;
	assert.equal(followUps.length, 0);

	process.env.FAKE_PI_HOLD = "1";
	assert.equal(view.send("hold continued run"), "continued");
	const runningId = view.snapshot().id;
	assert.equal(view.send("steer this child"), "queued");
	await until(() => records(process.env.FAKE_PI_LOG).some((event) => event.type === "steer" && event.message === "steer this child"), "live steer record");
	assert.equal(view.snapshot().id, runningId, "steer never relaunches");
	assert.equal(followUps.length, 0);
	assert.equal(sub.cancelSubagentRun(runningId), true);
	await until(() => sub.resolveSubagentResume(runningId, "more").reason?.includes("stopped by the user"), "persisted cancellation");
	assert.match(view.send("try cancelled run"), /^refused: .*stopped by the user/);
	delete process.env.FAKE_PI_HOLD;

	await run("view-bg", { agent: "deep-reviewer", task: "background" });
	const bg = sub.createSubagentRunView(ctx, "sub:view-bg:0");
	assert.equal(bg.snapshot().task, "background");
	await until(() => followUps.length === 1, "normal background delivery remains intact");
	await run("view-parallel", { tasks: [{ agent: "deep-reviewer", task: "parallel-a" }, { agent: "deep-reviewer", task: "parallel-b" }] });
	const parallelA = sub.createSubagentRunView(ctx, "sub:view-parallel:0").snapshot();
	const parallelB = sub.createSubagentRunView(ctx, "sub:view-parallel:1").snapshot();
	assert.equal(parallelA.task, "parallel-a");
	assert.equal(parallelB.task, "parallel-b");
	assert.notEqual(parallelA.id, parallelB.id);
	await run("view-chain", { chain: [{ agent: "deep-reviewer", task: "chain-a" }, { agent: "deep-reviewer", task: "chain-b" }] });
	assert.equal(sub.createSubagentRunView(ctx, "sub:view-chain:0").snapshot().task, "chain-a");
	assert.equal(sub.createSubagentRunView(ctx, "sub:view-chain:1").snapshot().task, "chain-b");
	const missing = sub.createSubagentRunView(ctx, "sub:unknown:0");
	assert.equal(missing.snapshot(), undefined);
	assert.match(missing.send("more"), /^refused: No stored session/);

	const controls = [];
	globalThis.__piMineTaskDockControl = (request) => controls.push(request);
	dock.upsertTask(ctx, "delegate:ext", { source: "delegate", label: "external", state: "running" });
	const delegate = sub.createSubagentRunView(ctx, "delegate:ext");
	assert.equal(delegate.send(" guidance "), "queued");
	assert.deepEqual(controls, [{ id: "ext", action: "guide", guidance: "guidance" }]);
	for (const state of ["done", "error", "cancelled"]) {
		dock.upsertTask(ctx, "delegate:ext", { state });
		assert.match(delegate.send("again"), /^refused:/);
	}
	assert.equal(controls.length, 1);
	delete globalThis.__piMineTaskDockControl;

	await single("view-retained");
	const retained = sub.createSubagentRunView(ctx, "sub:view-retained:0");
	const retainedId = retained.snapshot().id;
	const retainedSession = sessionId(argvRecords().at(-1));
	for (let i = 0; i < 13; i++) await single(`view-trim-${i}`);
	assert.ok(!sub.subagentFleetSnapshot().some((entry) => entry.id === retainedId));
	assert.equal(sub.createSubagentRunView(ctx, "sub:view-retained:0").snapshot(), undefined, "stale row mappings are pruned");
	assert.equal(retained.send("resume from disk"), "continued");
	await until(() => retained.snapshot()?.status === "completed", "persisted-only continuation");
	assert.equal(sessionId(argvRecords().at(-1)), retainedSession);
	assert.equal(followUps.length, 1, "only the ordinary background run delivered to the parent");

	let opened = false;
	await dock.__test.openPickedTarget(pi, { ...ctx, ui: { custom: async (factory, options) => {
		assert.equal(options.overlay, true);
		const theme = { fg: (_color, text) => text, bold: (text) => text, underline: (text) => text, inverse: (text) => text };
		const keybindings = { matches: (data, binding) => data === "\x1b" && binding === "tui.select.cancel" };
		const ui = await factory({ requestRender() {} }, theme, keybindings, () => {});
		const lines = ui.render(100).join("\n");
		assert.ok(lines.includes("Subagent monitor"));
		assert.match(lines, /deep-reviewer/);
		assert.match(lines, /^│> /m);
		assert.ok(!lines.includes("Prompt"));
		ui.handleInput("\x1b");
		opened = true;
	} } }, { kind: "subagent", rowId: "sub:view-retained:0" });
	assert.ok(opened, "picker invokes the per-run opener");
	console.log("subagent-run-view: RPC steer/resume, dock identity, pruning, delegate and picker integration passed");
} finally {
	if (sub) {
		for (const entry of sub.subagentFleetSnapshot()) if (entry.status === "running") sub.cancelSubagentRun(entry.id);
		await sleep(100);
	}
	delete globalThis.__piMineTaskDockControl;
	for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
	Object.assign(process.env, oldEnv);
	process.argv[1] = oldScript;
	rmSync(temp, { recursive: true, force: true });
}
