import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	changedPaths,
	makeGit,
	restoreWorktree,
	snapshotWorktree,
} from "../extensions/checkpoint/git-snapshot.ts";
import {
	findRecord,
	findTurnUserEntryId,
	isTreeId,
	parseRecord,
	pruneRecords,
} from "../extensions/checkpoint/checkpoint-state.ts";

function makeRepo() {
	const repo = mkdtempSync(join(tmpdir(), "checkpoint-test-"));
	const sh = (command) => execFileSync("sh", ["-c", command], { cwd: repo, encoding: "utf8" });
	sh(
		"git init -q . && git config user.email t@t && git config user.name t && " +
			"printf 'ignored.log\\n' > .gitignore && echo a > f.txt && echo keep > g.txt && " +
			"git add . && git commit -qm init",
	);
	return { repo, sh, git: makeGit(repo) };
}

// 1. Restore brings back untracked files, drops files created after the snapshot,
//    leaves ignored files alone, and never touches the real index or stash.
{
	const { repo, sh, git } = makeRepo();
	writeFileSync(join(repo, "u.txt"), "untracked at snapshot\n");
	writeFileSync(join(repo, "ignored.log"), "ignored\n");
	const stashBefore = sh("git stash list | wc -l").trim();
	const indexBefore = sh("git ls-files -s | md5sum").trim();

	const snap = await snapshotWorktree(git);
	assert.ok(isTreeId(snap), "snapshot returns a tree id");

	// Agent-style edits after the snapshot.
	writeFileSync(join(repo, "f.txt"), "CHANGED\n");
	sh("rm u.txt");
	writeFileSync(join(repo, "v.txt"), "created after\n");
	mkdirSync(join(repo, "sub"), { recursive: true });
	writeFileSync(join(repo, "sub/new.txt"), "nested\n");

	const changed = (await changedPaths(git, snap, await snapshotWorktree(git))).sort();
	assert.deepEqual(changed, ["f.txt", "sub/new.txt", "u.txt", "v.txt"]);

	await restoreWorktree(git, snap);
	assert.equal(readFileSync(join(repo, "f.txt"), "utf8"), "a\n", "tracked file is restored");
	assert.equal(readFileSync(join(repo, "g.txt"), "utf8"), "keep\n", "unchanged file is kept");
	assert.ok(existsSync(join(repo, "u.txt")), "untracked file from the snapshot comes back");
	assert.ok(!existsSync(join(repo, "v.txt")), "file created after the snapshot is removed");
	assert.ok(!existsSync(join(repo, "sub/new.txt")), "nested file created after the snapshot is removed");
	assert.equal(readFileSync(join(repo, "ignored.log"), "utf8"), "ignored\n", "ignored file is never touched");
	assert.equal(sh("git stash list | wc -l").trim(), stashBefore, "stash list is unchanged");
	assert.equal(sh("git ls-files -s | md5sum").trim(), indexBefore, "real index is unchanged");
}

// 2. A snapshot of an unchanged worktree is stable, so the same state always
//    produces the same tree id.
{
	const { git } = makeRepo();
	assert.equal(await snapshotWorktree(git), await snapshotWorktree(git), "same state gives the same tree");
}

// 3. A repo with no commits yet can still be snapshotted.
{
	const repo = mkdtempSync(join(tmpdir(), "checkpoint-empty-"));
	execFileSync("git", ["init", "-q", repo]);
	writeFileSync(join(repo, "first.txt"), "first\n");
	const snap = await snapshotWorktree(makeGit(repo));
	assert.ok(isTreeId(snap), "an unborn HEAD still snapshots");
}

// 4. Tree ids must be plain hex, so an id can never inject a git argument.
assert.equal(isTreeId("3385be66978b36235f4d4685b316f97075afc6c2"), true);
assert.equal(isTreeId("--upload-pack=evil"), false, "option-looking input is rejected");
assert.equal(isTreeId("abc; rm -rf /"), false, "shell-looking input is rejected");
assert.equal(isTreeId(""), false);

// 5. Persisted payloads that do not match the shape are ignored, not trusted.
assert.equal(parseRecord(null), undefined);
assert.equal(parseRecord({ entryId: "e1" }), undefined, "missing startTree is rejected");
assert.equal(parseRecord({ entryId: 1, startTree: "x" }), undefined, "non-string entryId is rejected");
assert.deepEqual(
	parseRecord({ entryId: "e1", startTree: "a".repeat(40), endTree: "b".repeat(40) }),
	{ entryId: "e1", startTree: "a".repeat(40), endTree: "b".repeat(40) },
);

// 6. Lookup returns the newest record for a turn, and pruning keeps the newest N.
{
	const records = [
		{ entryId: "e1", startTree: "a" },
		{ entryId: "e2", startTree: "b" },
		{ entryId: "e1", startTree: "c" },
	];
	assert.equal(findRecord(records, "e1").startTree, "c", "the latest record for a turn wins");
	assert.equal(findRecord(records, "missing"), undefined);
	const pruned = pruneRecords(Array.from({ length: 5 }, (_, i) => ({ entryId: `e${i}`, startTree: "x" })), 3);
	assert.deepEqual(pruned.map((r) => r.entryId), ["e2", "e3", "e4"], "pruning keeps the newest records");
}

// 7. The user entry is resolved from the branch after the turn settles. Real sessions
//    show pi appending a system entry BEFORE the user entry (the leaf at turn start
//    points at that system entry). Reading the leaf at message_start returned the wrong
//    entry, so the id must be found by walking back to the start leaf.
{
	const branchAfterTurn = [
		{ id: "s1", type: "thinking_level_change" },
		{ id: "sys1", type: "message", message: { role: "system" } },
		{ id: "user1", type: "message", message: { role: "user" } },
		{ id: "a1", type: "message", message: { role: "assistant" } },
		{ id: "t1", type: "message", message: { role: "toolResult" } },
	];
	assert.equal(
		findTurnUserEntryId(branchAfterTurn, "sys1"),
		"user1",
		"the user entry opened by the turn is found, not the system entry before it",
	);

	// A turn that added no user message (the start leaf is the newest entry) binds to
	// nothing, rather than to a previous turn's user entry.
	const noNewUser = [
		{ id: "user0", type: "message", message: { role: "user" } },
		{ id: "a0", type: "message", message: { role: "assistant" } },
	];
	assert.equal(findTurnUserEntryId(noNewUser, "a0"), undefined, "no user message after the start leaf means no binding");

	// With several turns, only the newest user message after the start leaf counts.
	const twoTurns = [
		{ id: "userOld", type: "message", message: { role: "user" } },
		{ id: "aOld", type: "message", message: { role: "assistant" } },
		{ id: "sysNew", type: "message", message: { role: "system" } },
		{ id: "userNew", type: "message", message: { role: "user" } },
	];
	assert.equal(findTurnUserEntryId(twoTurns, "aOld"), "userNew", "the turn's own user entry, not an older one");
	assert.equal(findTurnUserEntryId([], null), undefined, "an empty branch binds to nothing");
}

// 8. /code-rewind must never overwrite the worktree without confirmation. With no UI
//    there is no way to confirm, so it refuses; with a UI the user can decline.
{
	const { repo, sh, git } = makeRepo();
	const snapStart = await snapshotWorktree(git);
	writeFileSync(join(repo, "f.txt"), "agent wrote this\n");
	const endTree = await snapshotWorktree(git);
	// Simulate a user edit after the turn so the confirm path is exercised.
	writeFileSync(join(repo, "f.txt"), "user edit after turn\n");

	const handlers = new Map();
	const commands = new Map();
	const { default: codeCheckpoint } = await import("../extensions/checkpoint/index.ts");
	codeCheckpoint({
		on(event, handler) {
			handlers.set(event, handler);
		},
		registerCommand(name, options) {
			commands.set(name, options);
		},
		appendEntry() {},
	});
	// Seed one persisted record through the session_start path, then rewind to it.
	const entryId = "user-turn-1";
	const ctxBase = (overrides) => ({
		cwd: repo,
		hasUI: false,
		sessionManager: {
			getBranch: () => [
				{ type: "custom", customType: "code-checkpoint", data: { entryId, startTree: snapStart, endTree } },
			],
			getLeafId: () => null,
		},
		ui: {
			notify() {},
			confirm: async () => true,
		},
		...overrides,
	});
	await handlers.get("session_start")({ type: "session_start" }, ctxBase());

	// No UI: the rewind is refused and the user's edit survives.
	await commands.get("code-rewind").handler(entryId, ctxBase({ hasUI: false }));
	assert.equal(
		readFileSync(join(repo, "f.txt"), "utf8"),
		"user edit after turn\n",
		"without a UI the rewind must not overwrite the worktree",
	);

	// With a UI, the user declines: still no overwrite.
	let asked = false;
	await commands.get("code-rewind").handler(entryId, ctxBase({
		hasUI: true,
		ui: {
			notify() {},
			confirm: async () => {
				asked = true;
				return false;
			},
		},
	}));
	assert.equal(asked, true, "a UI rewind asks before overwriting a user-edited file");
	assert.equal(
		readFileSync(join(repo, "f.txt"), "utf8"),
		"user edit after turn\n",
		"declining the confirmation leaves the user's edit in place",
	);
	void sh;
}

console.log("checkpoint: ok");
