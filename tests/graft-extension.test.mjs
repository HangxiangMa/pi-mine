import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const {
	buildArgsFor,
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
