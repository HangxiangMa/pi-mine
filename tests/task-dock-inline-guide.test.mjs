import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const paths = JSON.parse(
	execFileSync(
		"bash",
		[
			"-c",
			'source tests/lib/pi-jiti.sh; locate_pi_jiti || exit 1; node -e \'console.log(JSON.stringify({jiti:process.env.PI_JITI,tui:process.env.PI_TUI,pkg:process.env.PI_CODING_AGENT_PKG}))\'',
		],
		{ cwd: root, encoding: "utf8" },
	),
);
const jiti = require(paths.jiti)(root, {
	interopDefault: true,
	alias: {
		"@earendil-works/pi-tui": paths.tui,
		"@earendil-works/pi-coding-agent": paths.pkg,
	},
});
const { openSubagentFleetInspector } = jiti(path.join(root, "extensions/subagent/fleet-inspector.ts"));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (id) => ({
	id,
	agent: "worker",
	task: "inline guide test",
	model: "test/model",
	status: "running",
	startedAt: Date.now() - 1000,
	output: "ready",
	stderr: "",
	inputTokens: 0,
	outputTokens: 0,
});

async function open(runValue, actions = {}) {
	let component;
	let resolveOpen;
	const opened = new Promise((resolve) => {
		resolveOpen = resolve;
	});
	const ctx = {
		hasUI: true,
		ui: {
			// The inline guide must never fall back to the modal editor.
			editor() {
				throw new Error("ctx.ui.editor must not be called");
			},
			async custom(factory, options) {
				options.onHandle?.({ focus() {} });
				const tui = { terminal: { rows: 40, columns: 100 }, requestRender() {} };
				const theme = { bold: (text) => text, fg: (_color, text) => text };
				component = await factory(
					tui,
					theme,
					{ matches: (data, binding) => data === "\x1b" && binding === "tui.select.cancel" },
					() => resolveOpen(),
				);
				return opened;
			},
		},
	};
	const pending = openSubagentFleetInspector(ctx, () => [runValue], actions);
	while (!component) await sleep(0);
	return { component, pending };
}

// Native rows submit the text entered after p directly through the guide action.
{
	const calls = [];
	const { component, pending } = await open(run("native-1"), {
		guide: (runId, text) => calls.push([runId, text]),
	});
	component.handleInput("p");
	assert.match(component.render(100).join("\n"), /Enter send · Esc back/);
	for (const key of "focus child") component.handleInput(key);
	component.handleInput("\r");
	await sleep(0);
	assert.deepEqual(calls, [["native-1", "focus child"]]);
	component.handleInput("\x1b");
	assert.match(component.render(100).join("\n"), /Enter send.*↑↓ move.*p guide.*Esc close/);
	component.handleInput("\x1b");
	await pending;
}

// Delegate rows use the same inline action contract; no editor is involved.
{
	const calls = [];
	const { component, pending } = await open(run("delegate:one"), {
		guide: (runId, text) => calls.push([runId, text]),
	});
	component.handleInput("p");
	component.handleInput("x");
	component.handleInput("\r");
	await sleep(0);
	assert.deepEqual(calls, [["delegate:one", "x"]]);
	component.handleInput("\x1b");
	component.handleInput("q");
	await pending;
}

// Background rows are visible/read-only and p must not invoke the guide bridge.
{
	let calls = 0;
	const { component, pending } = await open(run("bg:task-one"), {
		guide: () => calls++,
	});
	assert.match(component.render(100).join("\n"), /bg tasks take no input/);
	component.handleInput("p");
	component.handleInput("x");
	component.handleInput("\r");
	await sleep(0);
	assert.equal(calls, 0);
	component.handleInput("q");
	await pending;
}

console.log("task dock inline guide: ok");
