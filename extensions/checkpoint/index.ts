/**
 * code-checkpoint — roll the worktree back together with the conversation.
 *
 * Claude Code's /rewind restores code as well as the conversation: each user
 * turn has a file-history checkpoint. pi's ESC rewind only moves the
 * conversation, so after a bad turn the code stays changed.
 *
 * How it works:
 * - before_agent_start: snapshot the worktree (the state before this turn) and
 *   remember the leaf that was current.
 * - agent_settled: once the turn has landed, find the user entry it opened by
 *   walking the branch back to that leaf, then snapshot again (endTree) and save
 *   one record against that id with appendEntry, which survives /resume.
 *   endTree lets later user edits be told apart from the agent's own changes.
 *   The user entry is not reliably persisted before message_start handlers run,
 *   so its id must not be read earlier (see findTurnUserEntryId).
 * - /code-rewind <entryId>: restore the worktree to that turn's startTree. If the
 *   user changed files after the turn, the list is shown and confirmed first.
 *
 * Snapshots are git tree objects built with a temporary index, so the real
 * index, stash, and worktree are never touched while recording.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CHECKPOINT_ENTRY_TYPE,
	type CheckpointRecord,
	DEFAULT_MAX_CHECKPOINTS,
	findRecord,
	findTurnUserEntryId,
	isTreeId,
	parseRecord,
	partitionByAge,
	pruneRecords,
	treeRef,
} from "./checkpoint-state.ts";
import {
	changedPaths,
	findRepoRoot,
	type Git,
	makeGit,
	restoreWorktree,
	snapshotWorktree,
} from "./git-snapshot.ts";
import { clearRestoreHint, showRestoreHint } from "./restore-hint.ts";

export const CODE_REWIND_COMMAND = "code-rewind";

export default function codeCheckpoint(pi: ExtensionAPI) {
	/** The turn in flight: its start snapshot and the leaf that was current before it. */
	let pendingTurn: { startTree: string; startLeafId: string | null; createdAt: number } | undefined;
	/** Records for this session, rebuilt from persisted entries on session start. */
	let records: CheckpointRecord[] = [];
	/**
	 * Set when the user chose to restore code along with a /tree navigation. The
	 * restore runs in session_tree, after the conversation has actually moved, so a
	 * navigation that is cancelled never touches the worktree.
	 */
	let pendingTreeRestore: CheckpointRecord | undefined;

	const gitFor = async (ctx: ExtensionContext): Promise<Git | undefined> => {
		const root = await findRepoRoot(ctx.cwd);
		return root ? makeGit(root) : undefined;
	};

	const loadRecords = (ctx: ExtensionContext): void => {
		const rebuilt = new Map<string, CheckpointRecord>();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== CHECKPOINT_ENTRY_TYPE) continue;
			const parsed = parseRecord(entry.data);
			if (!parsed) continue;
			// A later entry for the same turn carries its endTree. Keep the earliest
			// createdAt, so the age of a turn is when it started, not when it settled.
			const prior = rebuilt.get(parsed.entryId);
			rebuilt.set(parsed.entryId, {
				entryId: parsed.entryId,
				startTree: parsed.startTree,
				endTree: parsed.endTree ?? prior?.endTree,
				createdAt: prior?.createdAt ?? parsed.createdAt,
			});
		}
		// Past-retention records are not restored into memory. Their refs may still exist,
		// and admit() unpins them on the next turn, by reading the refs.
		const { kept } = partitionByAge([...rebuilt.values()], Date.now());
		records = pruneRecords(kept, DEFAULT_MAX_CHECKPOINTS);
	};

	pi.on("session_start", async (_event, ctx) => {
		loadRecords(ctx);
	});

	// /tree navigation to a checkpointed user turn. The target is only known once the
	// user has confirmed it, so this is where the "restore code too?" question goes.
	// The conversation navigation itself is never cancelled here.
	pi.on("session_before_tree", async (event, ctx) => {
		pendingTreeRestore = undefined;
		if (!ctx.hasUI) return;
		const record = findRecord(records, event.preparation.targetId);
		if (!record) return;
		const choice = await ctx.ui.select("Also restore code to before this turn?", [
			"Conversation only",
			"Conversation and code",
		]);
		if (choice === "Conversation and code") pendingTreeRestore = record;
	});

	pi.on("session_tree", async (_event, ctx) => {
		loadRecords(ctx);
		const record = pendingTreeRestore;
		pendingTreeRestore = undefined;
		if (!record) return;
		await restoreTurnCode(record, ctx);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		clearRestoreHint(ctx);
		pendingTurn = undefined;
		// A navigation that failed after its before-hook (for example a summary error) never
		// reaches session_tree. Its armed restore must not survive into the next turn.
		pendingTreeRestore = undefined;
		const git = await gitFor(ctx);
		if (!git) return;
		try {
			pendingTurn = {
				startTree: await snapshotWorktree(git),
				startLeafId: ctx.sessionManager.getLeafId(),
				createdAt: Date.now(),
			};
		} catch {
			// A snapshot failure must never block the user's turn. The turn just
			// goes without a checkpoint.
			pendingTurn = undefined;
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const turn = pendingTurn;
		pendingTurn = undefined;
		if (!turn) return;
		// The turn has fully landed, so the branch now holds its user entry.
		const entryId = findTurnUserEntryId(ctx.sessionManager.getBranch(), turn.startLeafId);
		if (!entryId) return;
		const git = await gitFor(ctx);
		if (!git) return;
		try {
			const endTree = await snapshotWorktree(git);
			const record: CheckpointRecord = {
				entryId,
				startTree: turn.startTree,
				endTree,
				createdAt: turn.createdAt,
			};
			await admit(git, record, ctx);
		} catch {
			// No endTree: the rewind still runs, but it asks before overwriting anything,
			// since it cannot tell user edits apart from the agent's.
			const record: CheckpointRecord = {
				entryId,
				startTree: turn.startTree,
				createdAt: turn.createdAt,
			};
			await admit(git, record, ctx);
		}
	});

	/**
	 * Pin a record's trees, then persist it, then drop what has aged out.
	 *
	 * Pinning comes first. A record that is persisted before its trees are pinned could
	 * outlive them, since `git gc` would be free to remove an unreferenced tree. The
	 * refs are the only thing that keeps a checkpoint's objects alive.
	 */
	const admit = async (
		git: Git,
		record: CheckpointRecord,
		ctx: ExtensionContext,
	): Promise<void> => {
		if (!isTreeId(record.startTree)) throw new Error("refusing to pin a malformed start tree");
		await git.run(["update-ref", treeRef(record.entryId, "start"), record.startTree]);
		if (record.endTree !== undefined) {
			if (!isTreeId(record.endTree)) throw new Error("refusing to pin a malformed end tree");
			await git.run(["update-ref", treeRef(record.entryId, "end"), record.endTree]);
		}
		const live = [...records.filter((r) => r.entryId !== record.entryId), record];
		const { kept } = partitionByAge(live, Date.now());
		records = pruneRecords(kept, DEFAULT_MAX_CHECKPOINTS);
		pi.appendEntry(CHECKPOINT_ENTRY_TYPE, record);
		if (await sweepRefs(git)) await collectGarbage(git);
	};

	/**
	 * Unpin every checkpoint whose turn is no longer live. The sweep reads the refs
	 * themselves rather than the in-memory list, because loadRecords already drops
	 * expired records before admit runs. A list-driven sweep would never see them, so
	 * their refs would pin objects forever. Returns true when anything was unpinned.
	 */
	const sweepRefs = async (git: Git): Promise<boolean> => {
		const listing = await git.run(["for-each-ref", "--format=%(refname)", "refs/pi-checkpoints/"]);
		const liveIds = new Set(records.map((r) => r.entryId));
		let removed = false;
		const turnIds = new Set<string>();
		for (const ref of listing.split("\n")) {
			const match = /^refs\/pi-checkpoints\/(.+)\/(start|end)$/.exec(ref.trim());
			if (match?.[1]) turnIds.add(match[1]);
		}
		for (const turnId of turnIds) {
			if (liveIds.has(turnId)) continue;
			await unpin(git, turnId);
			removed = true;
		}
		return removed;
	};

	/**
	 * Let git reclaim objects no pin references. Runs only after a sweep actually removed
	 * pins, so an ordinary turn never pays for it. `--auto` respects git's own thresholds,
	 * so it may leave the objects for a later run; it never blocks or fails the turn.
	 */
	const collectGarbage = async (git: Git): Promise<void> => {
		try {
			await git.run(["gc", "--auto", "--quiet"]);
		} catch {
			// Leave the objects in place; a later gc collects them.
		}
	};

	/** Remove a record's pins so its trees become collectable. */
	const unpin = async (git: Git, entryId: string): Promise<void> => {
		for (const side of ["start", "end"] as const) {
			try {
				await git.run(["update-ref", "-d", treeRef(entryId, side)]);
			} catch {
				// A ref that is already gone is the goal, so a failed delete is harmless.
			}
		}
	};

	/**
	 * Restore the worktree to a turn's starting state. Shared by /code-rewind and the
	 * /tree path so both apply the same guards. Anything the user changed after the
	 * turn must be confirmed before it is overwritten.
	 */
	const restoreTurnCode = async (
		record: CheckpointRecord,
		ctx: ExtensionContext,
	): Promise<void> => {
		// Restoring can overwrite user work, so it must be confirmed. Without a UI there
		// is no way to confirm, so refuse rather than overwrite silently.
		if (!ctx.hasUI) return;
		if (!isTreeId(record.startTree)) {
			ctx.ui.notify("Checkpoint is corrupt; refusing to restore", "error");
			return;
		}
		const git = await gitFor(ctx);
		if (!git) {
			ctx.ui.notify("Not inside a git repository; nothing to restore", "error");
			return;
		}

		const current = await snapshotWorktree(git);
		if (!record.endTree) {
			// Without endTree the agent's own edits cannot be separated from the user's, so
			// the whole rewind needs confirmation rather than a wrong list.
			const ok = await ctx.ui.confirm(
				"Restore code without a settled checkpoint?",
				"The turn did not record a settled state, so user edits made after it cannot be told apart. Restoring overwrites every file the turn touched.",
			);
			if (!ok) {
				ctx.ui.notify("Code rewind cancelled", "info");
				return;
			}
		} else {
			const userEdited = await changedPaths(git, record.endTree, current);
			if (userEdited.length > 0) {
				const preview = userEdited.slice(0, 20).join("\n");
				const more = userEdited.length > 20 ? `\n...and ${userEdited.length - 20} more` : "";
				const ok = await ctx.ui.confirm(
					"Overwrite files changed after this turn?",
					`These files changed after the turn and will be overwritten:\n${preview}${more}`,
				);
				if (!ok) {
					ctx.ui.notify("Code rewind cancelled", "info");
					return;
				}
			}
		}

		await restoreWorktree(git, record.startTree);
		showRestoreHint(ctx, `Code restored to before turn ${record.entryId}`);
	};

	pi.registerCommand(CODE_REWIND_COMMAND, {
		description: "Restore the worktree to the state before a user turn: /code-rewind <entryId>",
		handler: async (args, ctx) => {
			const entryId = args.trim();
			if (!entryId) {
				ctx.ui.notify("Usage: /code-rewind <entryId>", "error");
				return;
			}
			const record = findRecord(records, entryId);
			if (!record) {
				ctx.ui.notify(`No code checkpoint for turn ${entryId}`, "error");
				return;
			}
			await restoreTurnCode(record, ctx);
		},
	});
}
