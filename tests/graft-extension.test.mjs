import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const {
	buildArgsFor,
	formatBuildProgress,
	formatGraftContext,
	hasPiSkill,
	installPiSkill,
	shouldRetrieve,
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

test("Graft retrieval skips short and command prompts", () => {
	assert.equal(shouldRetrieve("hi"), false);
	assert.equal(shouldRetrieve("/help with graft"), false);
	assert.equal(shouldRetrieve("where is the auth flow implemented?"), true);
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
