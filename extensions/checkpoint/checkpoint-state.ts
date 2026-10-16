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
	/** Epoch ms when the record was written. Absent on records from older versions. */
	readonly createdAt?: number;
}

/** Custom session entry type used to persist records across /resume. */
export const CHECKPOINT_ENTRY_TYPE = "code-checkpoint";

export const DEFAULT_MAX_CHECKPOINTS = 50;

/**
 * How long a checkpoint is kept, matching Claude Code's transcript and file-history
 * retention (cleanupPeriodDays, default 30; binary var wdn=30). Age, not turn count,
 * is what decides it.
 */
export const DEFAULT_RETENTION_DAYS = 30;

/** Refs that pin a record's trees so `git gc` cannot remove them while the record lives. */
export function treeRef(entryId: string, side: "start" | "end"): string {
	return `refs/pi-checkpoints/${entryId}/${side}`;
}

/**
 * Split records into the ones still inside the retention window and the ones past it.
 * A record with no createdAt (written before this field existed) is kept rather than
 * dropped, so an upgrade never silently removes a rewind point.
 */
export function partitionByAge(
	records: readonly CheckpointRecord[],
	now: number,
	retentionDays = DEFAULT_RETENTION_DAYS,
): { kept: CheckpointRecord[]; expired: CheckpointRecord[] } {
	const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
	const kept: CheckpointRecord[] = [];
	const expired: CheckpointRecord[] = [];
	for (const record of records) {
		if (record.createdAt !== undefined && record.createdAt < cutoff) expired.push(record);
		else kept.push(record);
	}
	return { kept, expired };
}

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
	const parsed: CheckpointRecord = {
		entryId: record.entryId,
		startTree: record.startTree,
		endTree,
	};
	// Omitted, not undefined, when absent: records written before createdAt existed keep their exact shape.
	if (typeof record.createdAt === "number" && Number.isFinite(record.createdAt)) {
		return { ...parsed, createdAt: record.createdAt };
	}
	return parsed;
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
