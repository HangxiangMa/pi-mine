import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const {
	buildArgsFor,
	deinitGraft,
	graftBuildArgs,
	graftBuildCompletions,
	formatBuildProgress,
	formatGraftContext,
	hasPiSkill,
	installPiSkill,
	retrieveGraftContext,
	shouldRetrieve,
	shouldRetrieveSubagent,
	truncateOutput,
	default: graftExtension,
} = await import(
	"../extensions/graft.ts"
);

test("Graft builds isolate submodules unless local config opts in", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-graft-config-"));
	try {
		assert.deepEqual(buildArgsFor(cwd), ["build", "--no-follow-submodules", "--no-follow-nested-repos"]);
		mkdirSync(join(cwd, ".graft"), { recursive: true });
		writeFileSync(join(cwd, ".graft", "config.json"), JSON.stringify({ followSubmodules: true }));
		assert.deepEqual(buildArgsFor(cwd), ["build", "--no-follow-nested-repos"]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("graft-build maps deep, submodule, and include-dir options", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-graft-build-"));
	try {
		assert.deepEqual(graftBuildArgs(cwd, "deep submodule include-dir vendor"), [
			"build",
			"--no-follow-nested-repos",
			"--deep",
			"--follow-submodules",
			"--include-dir",
			"vendor",
		]);
		assert.deepEqual(graftBuildArgs(cwd, "include-dir=src include-dir vendor"), [
			"build",
			"--no-follow-submodules",
			"--no-follow-nested-repos",
			"--include-dir",
			"src",
			"--include-dir",
			"vendor",
		]);
		assert.match(String(graftBuildArgs(cwd, "unknown")), /Usage: \/graft-build/);
		assert.match(String(graftBuildArgs(cwd, "include-dir")), /Usage: \/graft-build/);
		assert.deepEqual(graftBuildCompletions(""), [
			{ value: "deep ", label: "deep", description: "build the deep semantic layer" },
			{ value: "submodule ", label: "submodule", description: "include Git submodules" },
			{ value: "include-dir ", label: "include-dir", description: "include a directory, then enter its path" },
		]);
		assert.deepEqual(graftBuildCompletions("d"), [
			{ value: "deep ", label: "deep", description: "build the deep semantic layer" },
		]);
		assert.deepEqual(graftBuildCompletions("deep ")?.map(({ value, label }) => ({ value, label })), [
			{ value: "deep submodule ", label: "submodule" },
			{ value: "deep include-dir ", label: "include-dir" },
		]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("graft-deinit removes initialization state but retains the graph", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-graft-deinit-"));
	try {
		mkdirSync(join(cwd, ".pi", "skills", "graft"), { recursive: true });
		mkdirSync(join(cwd, ".graft"), { recursive: true });
		mkdirSync(join(cwd, "graft"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "skills", "graft", "SKILL.md"), "skill\n");
		writeFileSync(join(cwd, ".graft", "config.json"), "{}\n");
		writeFileSync(join(cwd, "graft", "INDEX.md"), "graph\n");

		assert.deepEqual(deinitGraft(cwd), [".pi/skills/graft/SKILL.md", ".graft/config.json"]);
		assert.equal(hasPiSkill(cwd), false);
		assert.equal(readFileSync(join(cwd, "graft", "INDEX.md"), "utf8"), "graph\n");
		assert.equal(readFileSync(join(cwd, ".graft", ".pi-deinitialized"), "utf8"), "disabled\n");
		assert.deepEqual(deinitGraft(cwd), []);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("graft-deinit is registered and disables automatic initialization", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-graft-command-"));
	const commands = new Map();
	const events = new Map();
	const notices = [];
	let confirmations = 0;
	try {
		mkdirSync(join(cwd, ".pi", "skills", "graft"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "skills", "graft", "SKILL.md"), "skill\n");
		const pi = {
			registerCommand(name, definition) {
				commands.set(name, definition);
			},
			on(name, handler) {
				events.set(name, handler);
			},
		};
		graftExtension(pi);
		assert.equal(commands.get("graft-deinit").description.includes("Disable"), true);
		await commands.get("graft-deinit").handler("", {
			cwd,
			ui: { notify(message, level) { notices.push({ message, level }); } },
		});
		assert.equal(hasPiSkill(cwd), false);
		assert.equal(notices.at(-1).level, "info");
		assert.match(notices.at(-1).message, /graph retained/);
		await events.get("before_agent_start")({ prompt: "trace the auth callers and locate the implementation" }, {
			cwd,
			hasUI: true,
			ui: {
				confirm() {
					confirmations += 1;
					return true;
				},
			},
		});
		assert.equal(confirmations, 0, "deinit suppresses automatic initialization prompts");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Graft retrieval skips short and command prompts", () => {
	assert.equal(shouldRetrieve("hi"), false);
	assert.equal(shouldRetrieve("/help with graft"), false);
	assert.equal(shouldRetrieve("where is the auth flow implemented?"), true);
});

test("subagent retrieval only targets substantial code tasks", () => {
	assert.equal(shouldRetrieveSubagent("fix it"), false);
	assert.equal(shouldRetrieveSubagent("summarize the README prose for me"), false);
	assert.equal(shouldRetrieveSubagent("trace the auth callers and locate the implementation"), true);
});

test("subagent retrieval skips stale graphs", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-graft-stale-"));
	try {
		mkdirSync(join(cwd, ".pi", "skills", "graft"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "skills", "graft", "SKILL.md"), "skill\n");
		writeFileSync(join(cwd, "graft"), "stale\n");
		assert.equal(await retrieveGraftContext("trace the auth callers and locate the implementation", cwd), undefined);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("build progress is safe for the Pi status line", () => {
	assert.equal(formatBuildProgress("\u001b[2K\rparsed: 12 of 9005 files"), "parsed: 12 of 9005 files");
	assert.equal(formatBuildProgress("\n  "), undefined);
	assert.match(formatBuildProgress("x".repeat(181)), /\.\.\.$/);
});

test("Graft context is bounded and marked", () => {
	assert.equal(formatGraftContext(""), undefined);
	assert.equal(formatGraftContext("answer"), "<graft-context>\nanswer\n</graft-context>");
	assert.match(truncateOutput("x".repeat(5), 3), /graft output truncated/);
});

test("Pi Graft skill installs from an existing generated skill", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-graft-"));
	try {
		const source = join(cwd, ".claude", "skills", "graft", "SKILL.md");
		const expected = "generated skill\n";
		mkdirSync(join(cwd, ".claude", "skills", "graft"), { recursive: true });
		writeFileSync(source, expected);
		const destination = installPiSkill(cwd);
		assert.equal(hasPiSkill(cwd), true);
		assert.equal(readFileSync(destination, "utf8"), expected);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
