/**
 * Pure checkpoint bookkeeping, kept free of pi and git so it can be unit tested.
 *
 * Each user turn gets one record:
 * - startTree: worktree snapshot taken before the agent ran (the code to rewind to).
 * - endTree: worktree snapshot taken once the agent settled. Anything that differs
 *   from endTree at rewind time was changed by the user after the turn, and
 *   restoring over it would silently lose that work.
 */

export interface CheckpointRecord {
	readonly entryId: string;
	readonly startTree: string;
	readonly endTree?: string;
}

/** Custom session entry type used to persist records across /resume. */
export const CHECKPOINT_ENTRY_TYPE = "code-checkpoint";

export const DEFAULT_MAX_CHECKPOINTS = 50;

/** Keep only the newest `max` records, returned oldest-first. */
export function pruneRecords(
	records: readonly CheckpointRecord[],
	max = DEFAULT_MAX_CHECKPOINTS,
): CheckpointRecord[] {
	return records.length <= max ? [...records] : records.slice(records.length - max);
}

/** Find the record for a user entry, or undefined if that turn was never checkpointed. */
export function findRecord(
	records: readonly CheckpointRecord[],
	entryId: string,
): CheckpointRecord | undefined {
	for (let i = records.length - 1; i >= 0; i--) {
		if (records[i]?.entryId === entryId) return records[i];
	}
	return undefined;
}

/**
 * Parse one persisted custom-entry payload. Anything that does not match the
 * expected shape is ignored rather than trusted, so a corrupt entry cannot
 * drive a restore.
 */
export function parseRecord(data: unknown): CheckpointRecord | undefined {
	if (!data || typeof data !== "object") return undefined;
	const record = data as Record<string, unknown>;
	if (typeof record.entryId !== "string" || typeof record.startTree !== "string") return undefined;
	const endTree = typeof record.endTree === "string" ? record.endTree : undefined;
	return { entryId: record.entryId, startTree: record.startTree, endTree };
}

interface BranchEntry {
	readonly id: string;
	readonly type: string;
	readonly message?: { readonly role?: string };
}

/**
 * Find the user message that opened the turn: the newest user message added after
 * `startLeafId`, the leaf that was current when the turn began.
 *
 * This is deliberately not based on timestamps or on the leaf at message_start.
 * The user entry is only persisted after message_start handlers run, so reading
 * the leaf there returns the entry before it (esc-restore.ts documents the same
 * trap). Once the turn has settled, the branch holds the user entry, and walking
 * back to the start leaf finds it exactly.
 *
 * Returns undefined when the turn added no user message, so a checkpoint is never
 * bound to a previous turn's entry.
 */
export function findTurnUserEntryId(
	branch: readonly BranchEntry[],
	startLeafId: string | null,
): string | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (!entry) continue;
		if (entry.id === startLeafId) return undefined;
		if (entry.type === "message" && entry.message?.role === "user") return entry.id;
	}
	return undefined;
}

const TREE_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** A git object id as produced by `git write-tree`. Guards against injected arguments. */
export function isTreeId(value: string): boolean {
	return TREE_ID.test(value);
}
