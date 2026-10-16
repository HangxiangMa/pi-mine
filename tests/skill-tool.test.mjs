import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { default: installSkillTool } = await import("../extensions/skill-tool.ts");

const handlers = new Map();
let registeredTool;
const pi = {
	on(name, handler) {
		handlers.set(name, handler);
	},
	registerTool(def) {
		registeredTool = def;
	},
};
const ctx = {};
installSkillTool(pi);

assert.equal(registeredTool.name, "skill");
assert.equal(handlers.size, 1);

const root = await mkdtemp(join(tmpdir(), "pi-mine-skill-tool-"));
try {
	const tddDir = join(root, "tdd");
	const secretDir = join(root, "secret");
	const emptyDir = join(root, "empty");
	await Promise.all([mkdir(tddDir), mkdir(secretDir), mkdir(emptyDir)]);
	const tddFile = join(tddDir, "SKILL.md");
	const secretFile = join(secretDir, "SKILL.md");
	const emptyFile = join(emptyDir, "SKILL.md");
	await Promise.all([
		writeFile(tddFile, "---\nname: tdd\ndescription: d\n---\n\n# Test-driven development\n\nRun the tests first.\n"),
		writeFile(secretFile, "---\nname: secret\ndescription: private\n---\nsecret body\n"),
		writeFile(emptyFile, "---\nname: empty\ndescription: empty\n---\n\n"),
	]);

	const skills = [
		{
			name: "tdd",
			description: "d",
			filePath: tddFile,
			baseDir: tddDir,
			sourceInfo: {},
			disableModelInvocation: false,
		},
		{
			name: "secret",
			description: "private",
			filePath: secretFile,
			baseDir: secretDir,
			sourceInfo: {},
			disableModelInvocation: true,
		},
	];
	const beforeStart = handlers.get("before_agent_start");
	assert.equal(beforeStart({ systemPromptOptions: { skills } }, ctx), undefined);

	const loaded = await registeredTool.execute("test", { name: " TDD " }, undefined, undefined, ctx);
	assert.ok(!loaded.isError);
	assert.match(loaded.content[0].text, /# Test-driven development/);
	assert.doesNotMatch(loaded.content[0].text, /name: tdd/);
	assert.match(loaded.content[0].text, new RegExp(`Base directory for this skill: ${tddDir}`));

	const userOnly = await registeredTool.execute("test", { name: "secret" }, undefined, undefined, ctx);
	assert.equal(userOnly.isError, true);
	assert.match(userOnly.content[0].text, /user-only/);

	const unknown = await registeredTool.execute("test", { name: "nope" }, undefined, undefined, ctx);
	assert.equal(unknown.isError, true);
	assert.match(unknown.content[0].text, /Available:/);
	assert.match(unknown.content[0].text, /tdd/);
	assert.doesNotMatch(unknown.content[0].text, /secret/);

	await beforeStart({
		systemPromptOptions: {
			skills: [
				{
					name: "empty",
					description: "empty",
					filePath: emptyFile,
					baseDir: emptyDir,
					sourceInfo: {},
					disableModelInvocation: false,
				},
			],
		},
	}, ctx);
	const empty = await registeredTool.execute("test", { name: "empty" }, undefined, undefined, ctx);
	assert.equal(empty.isError, true);
	assert.match(empty.content[0].text, /empty body/);
} finally {
	await rm(root, { recursive: true, force: true });
}

console.log("skill tool: passed");
