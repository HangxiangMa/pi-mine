/**
 * Read-before-write and staleness guard for `edit` and `write`.
 *
 * Background runs may write the same files as the main agent. Without a guard, a
 * whole-file `write` from one side silently discards the other side's edit, because
 * `write` does no staleness check. This extension refuses a write unless the file was
 * fully read and is unchanged since that read. A refused call says to re-read the file.
 *
 * It uses the content hash of the file on disk rather than mtime: mtime can be
 * unchanged after a real edit, and Claude Code falls back to a content compare for the
 * same reason. Records are per process and cleared on session start, so each child
 * process guards its own view. Nothing here holds a lock: the check is optimistic.
 *
 * Every guard failure opens, except a definite staleness verdict. A broken guard must
 * not make every write fail.
 */

import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface ReadRecord {
	hash: string;
	/** True only for an unbounded read that was not truncated. */
	full: boolean;
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function disabled(): boolean {
	return ["1", "true", "yes", "on"].includes(
		(process.env.PI_WRITE_GUARD_OFF ?? "").trim().toLowerCase(),
	);
}

/**
 * Mirror pi's path normalization (strip a leading `@`, unicode spaces, `~`, resolve
 * against cwd) so the same file always maps to the same key. Then resolve symlinks,
 * so two names for one file share a record.
 */
export function recordKey(rawPath: string, cwd: string): string | undefined {
	if (typeof rawPath !== "string" || rawPath.length === 0) return undefined;
	let value = rawPath.replace(UNICODE_SPACES, " ");
	if (value.startsWith("@")) value = value.slice(1);
	const home = process.env.HOME ?? "";
	if (value === "~") value = home;
	else if (value.startsWith("~/")) value = join(home, value.slice(2));
	const absolute = isAbsolute(value) ? normalize(value) : resolve(cwd, value);
	try {
		return realpathSync(absolute);
	} catch {
		// Not yet on disk (a new file): key by the normalized absolute path.
		return absolute;
	}
}

export function hashFile(path: string): string | undefined {
	try {
		if (!statSync(path).isFile()) return undefined;
		return createHash("sha256").update(readFileSync(path)).digest("hex");
	} catch {
		return undefined;
	}
}

/** Whether a finished read counts as having seen the whole file. */
export function isFullRead(input: Record<string, unknown>, details: unknown): boolean {
	if ((input.offset ?? undefined) !== undefined && input.offset !== null) return false;
	if ((input.limit ?? undefined) !== undefined && input.limit !== null) return false;
	const truncation = (details as { truncation?: unknown } | undefined)?.truncation;
	return truncation === undefined || truncation === null;
}

export interface GuardDecision {
	block: true;
	reason: string;
}

/** Decide whether a write-type call may proceed. Returns undefined to allow. */
export function writeGuardReason(
	toolName: "edit" | "write",
	input: Record<string, unknown>,
	cwd: string,
	records: Map<string, ReadRecord>,
	diskHash: (path: string) => string | undefined = hashFile,
): string | undefined {
	const key = recordKey(input.path as string, cwd);
	if (!key) return undefined;
	const onDisk = diskHash(key);
	// A missing file is a new file. `write` may create it; `edit` cannot, and fails on its own.
	if (onDisk === undefined) return undefined;

	const record = records.get(key);
	const name = input.path as string;
	if (!record) {
		return `${toolName} refused: ${name} was not read in this session. Read it first, then retry.`;
	}
	// edit matches an exact oldText and fails on a miss or a duplicate, so a partial read
	// is enough. write replaces the whole file, so it needs the whole file in view.
	if (toolName === "write" && !record.full) {
		return `${toolName} refused: only part of ${name} was read. Read the whole file (no offset or limit, not truncated), then retry.`;
	}
	if (record.hash !== onDisk) {
		return `${toolName} refused: ${name} changed since it was read, probably by another agent. Re-read it, then retry.`;
	}
	return undefined;
}

export default function writeGuard(pi: ExtensionAPI): void {
	if (disabled()) return;
	const records = new Map<string, ReadRecord>();
	// Reads in flight, keyed by toolCallId. A read is recorded only after it succeeds.
	const pendingReads = new Map<string, string>();
	let cwd = process.cwd();

	pi.on("session_start", async (_event, ctx) => {
		records.clear();
		pendingReads.clear();
		cwd = ctx?.cwd ?? cwd;
	});

	pi.on("tool_call", async (event, ctx) => {
		try {
			if (ctx?.cwd) cwd = ctx.cwd;
			if (event.toolName === "read") {
				const input = event.input as Record<string, unknown>;
				const key = recordKey(input.path as string, cwd);
				if (key) pendingReads.set(event.toolCallId, key);
				return;
			}
			if (event.toolName === "edit" || event.toolName === "write") {
				const reason = writeGuardReason(
					event.toolName,
					event.input as Record<string, unknown>,
					cwd,
					records,
				);
				if (reason) return { block: true, reason };
			}
		} catch {
			// fail open: a guard bug must not block every write. Staleness verdicts are above.
		}
	});

	pi.on("tool_result", async (event) => {
		try {
			if (event.toolName === "read") {
				const key = pendingReads.get(event.toolCallId);
				pendingReads.delete(event.toolCallId);
				if (!key || event.isError) return;
				const input = event.input as Record<string, unknown>;
				const hash = hashFile(key);
				if (hash === undefined) return;
				records.set(key, { hash, full: isFullRead(input, event.details) });
				return;
			}
			if (event.toolName === "edit" || event.toolName === "write") {
				if (event.isError) return;
				const key = recordKey(event.input.path as string, cwd);
				if (!key) return;
				const hash = hashFile(key);
				if (hash === undefined) return;
				// The model just wrote this content, so the guard's view is now the disk.
				records.set(key, { hash, full: true });
			}
		} catch {
			// fail open
		}
	});
}

export const __test = { recordKey, hashFile, isFullRead, writeGuardReason };
