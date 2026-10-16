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
	DEFAULT_RETENTION_DAYS,
	findRecord,
	findTurnUserEntryId,
	isTreeId,
	parseRecord,
	partitionByAge,
	pruneRecords,
	treeRef,
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

// 9. /tree navigation: the code question comes after the conversation target is
//    confirmed, and only "Conversation and code" restores files. A navigation that
//    never reaches session_tree (cancelled) must not touch the worktree.
{
	const { repo, git } = makeRepo();
	const startSnap = await snapshotWorktree(git);
	writeFileSync(join(repo, "f.txt"), "agent wrote this\n");
	const endSnap = await snapshotWorktree(git);

	const { default: codeCheckpoint } = await import("../extensions/checkpoint/index.ts");
	const build = () => {
		const handlers = new Map();
		codeCheckpoint({
			on(event, handler) {
				handlers.set(event, handler);
			},
			registerCommand() {},
			appendEntry() {},
		});
		return handlers;
	};
	const ctxFor = (choice, asked) => ({
		cwd: repo,
		hasUI: true,
		sessionManager: {
			getBranch: () => [
				{ type: "custom", customType: "code-checkpoint", data: { entryId: "turn-9", startTree: startSnap, endTree: endSnap } },
			],
			getLeafId: () => null,
		},
		ui: {
			notify() {},
			select: async (title) => {
				asked.push(title);
				return choice;
			},
			confirm: async () => true,
		},
	});
	const runNavigation = async (choice, { settle = true } = {}) => {
		const asked = [];
		const handlers = build();
		const ctx = ctxFor(choice, asked);
		await handlers.get("session_start")({ type: "session_start" }, ctx);
		await handlers.get("session_before_tree")(
			{ type: "session_before_tree", preparation: { targetId: "turn-9" } },
			ctx,
		);
		if (settle) await handlers.get("session_tree")({ type: "session_tree" }, ctx);
		return asked;
	};

	// Conversation only: asked, and the worktree stays as the agent left it.
	const onlyAsked = await runNavigation("Conversation only");
	assert.equal(onlyAsked.length, 1, "a checkpointed target asks the code question");
	assert.equal(readFileSync(join(repo, "f.txt"), "utf8"), "agent wrote this\n", "conversation only keeps the code");

	// Conversation and code: the worktree returns to the turn's start.
	await runNavigation("Conversation and code");
	assert.equal(readFileSync(join(repo, "f.txt"), "utf8"), "a\n", "conversation and code restores the start state");

	// Cancelled navigation: the restore is armed but session_tree never arrives, so
	// nothing is restored.
	writeFileSync(join(repo, "f.txt"), "agent wrote this\n");
	await runNavigation("Conversation and code", { settle: false });
	assert.equal(readFileSync(join(repo, "f.txt"), "utf8"), "agent wrote this\n", "a cancelled navigation does not restore code");

	// A navigation can also arm the restore and then fail (a summary error skips
	// session_tree). A later turn must clear that armed value, so a stale restore can
	// never fire on an unrelated navigation that reaches session_tree on its own.
	{
		const handlers = build();
		const asked = [];
		const ctx = ctxFor("Conversation and code", asked);
		await handlers.get("session_start")({ type: "session_start" }, ctx);
		await handlers.get("session_before_tree")({ type: "session_before_tree", preparation: { targetId: "turn-9" } }, ctx);
		await handlers.get("before_agent_start")({ type: "before_agent_start" }, ctx);
		writeFileSync(join(repo, "f.txt"), "agent wrote this\n");
		await handlers.get("session_tree")({ type: "session_tree" }, ctx);
		assert.equal(
			readFileSync(join(repo, "f.txt"), "utf8"),
			"agent wrote this\n",
			"an armed restore does not survive into a later turn",
		);
	}
}

// 10. Retention follows Claude Code: a record is kept for 30 days from when its turn
//     started. Older records expire. A record with no createdAt (written before the
//     field existed) is kept, so an upgrade never silently drops a rewind point.
{
	const DAY = 24 * 60 * 60 * 1000;
	const now = 1_000 * DAY;
	assert.equal(DEFAULT_RETENTION_DAYS, 30, "retention defaults to Claude's 30 days");
	const fresh = { entryId: "fresh", startTree: "a".repeat(40), createdAt: now - 2 * DAY };
	const stale = { entryId: "stale", startTree: "b".repeat(40), createdAt: now - 31 * DAY };
	const legacy = { entryId: "legacy", startTree: "c".repeat(40) };
	const { kept, expired } = partitionByAge([fresh, stale, legacy], now);
	assert.deepEqual(kept.map((r) => r.entryId), ["fresh", "legacy"], "fresh and legacy records are kept");
	assert.deepEqual(expired.map((r) => r.entryId), ["stale"], "only the 31-day-old record expires");
}

// 11. Pins are namespaced per turn and side, so deleting one turn's pins never touches another.
{
	assert.equal(treeRef("turn-7", "start"), "refs/pi-checkpoints/turn-7/start");
	assert.equal(treeRef("turn-7", "end"), "refs/pi-checkpoints/turn-7/end");
	assert.notEqual(treeRef("turn-7", "start"), treeRef("turn-8", "start"));
}

// 12. createdAt survives a round trip through the persisted payload, and a missing one
//     stays missing rather than becoming undefined-valued.
{
	const withAge = parseRecord({ entryId: "e", startTree: "a".repeat(40), createdAt: 12345 });
	assert.equal(withAge.createdAt, 12345, "createdAt is carried through");
	const legacy = parseRecord({ entryId: "e", startTree: "a".repeat(40) });
	assert.equal("createdAt" in legacy, false, "a legacy record keeps its exact shape");
	assert.equal(
		parseRecord({ entryId: "e", startTree: "a".repeat(40), createdAt: "nope" }).createdAt,
		undefined,
		"a non-numeric createdAt is ignored",
	);
}

// 13. Real git: a settled turn pins its trees, and a sweep unpins a turn past retention
//     while keeping a fresh one. Without the unpin, an expired turn's objects would be
//     pinned forever and the disk would never be reclaimed.
{
	const DAY = 24 * 60 * 60 * 1000;
	const { repo, sh } = makeRepo();
	const realTree = sh("git rev-parse HEAD^{tree}").trim();
	sh(
		`git update-ref refs/pi-checkpoints/oldturn/start ${realTree} && ` +
			`git update-ref refs/pi-checkpoints/oldturn/end ${realTree}`,
	);
	const branch = [
		{
			id: "oldturn",
			type: "custom",
			customType: "code-checkpoint",
			data: { entryId: "oldturn", startTree: realTree, endTree: realTree, createdAt: Date.now() - 31 * DAY },
		},
	];
	const appended = [];
	const handlers = new Map();
	const { default: codeCheckpoint } = await import("../extensions/checkpoint/index.ts");
	codeCheckpoint({
		on(event, handler) {
			handlers.set(event, handler);
		},
		registerCommand() {},
		appendEntry(_type, data) {
			appended.push(data);
		},
	});
	const ctx = {
		cwd: repo,
		hasUI: false,
		sessionManager: { getBranch: () => branch.slice(), getLeafId: () => "sys0" },
		ui: { notify() {}, confirm: async () => true, select: async () => undefined },
	};
	await handlers.get("session_start")({}, ctx);
	await handlers.get("before_agent_start")({}, ctx);
	writeFileSync(join(repo, "f.txt"), "new turn\n");
	branch.push(
		{ id: "sys0", type: "message", message: { role: "system" } },
		{ id: "newturn", type: "message", message: { role: "user" } },
	);
	await handlers.get("agent_settled")({}, ctx);

	const refs = sh("git for-each-ref refs/pi-checkpoints --format='%(refname)'");
	assert.ok(!refs.includes("oldturn"), "the expired turn's pins are deleted");
	assert.ok(refs.includes("refs/pi-checkpoints/newturn/start"), "the new turn's start tree is pinned");
	assert.ok(refs.includes("refs/pi-checkpoints/newturn/end"), "the new turn's end tree is pinned");
	assert.equal(appended.length, 1, "the new turn is persisted once");
	assert.equal(appended[0].entryId, "newturn");
}

console.log("checkpoint: ok");
