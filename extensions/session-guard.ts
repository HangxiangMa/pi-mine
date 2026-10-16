import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";

export type MarkerWriteDecision =
	| { ok: true }
	| { ok: false; reason: "leaf-moved"; fileTailId: string };

export type OwnerRecord = {
	pid: number;
	host: string;
	procStart: string | null;
	sessionFile: string;
	startedAt: number;
};

export type LockAcquire = { status: "acquired" } | { status: "live-other"; owner: OwnerRecord };

type FileEntry = { id: string; type: string; customType?: string };

function readEntries(sessionFile: string | undefined): FileEntry[] {
	if (sessionFile === undefined) return [];
	let text: string;
	try {
		text = readFileSync(sessionFile, "utf8");
	} catch {
		// Advisory only: unavailable files must not prevent an interrupt marker.
		return [];
	}
	const entries: FileEntry[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line);
			if (
				entry &&
				typeof entry.id === "string" &&
				typeof entry.type === "string" &&
				entry.type !== "session"
			) {
				entries.push(entry);
			}
		} catch {
			// Skip malformed/partial lines, without repairing or rewriting the file.
		}
	}
	return entries;
}

/** Compare with physical file order, not timestamps or a stale manager's branch. */
export function markerWriteDecision(input: {
	sessionFile: string | undefined;
	leafId: string | null | undefined;
}): MarkerWriteDecision {
	const tail = readEntries(input.sessionFile).at(-1);
	if (!tail || tail.id === input.leafId) return { ok: true };
	return { ok: false, reason: "leaf-moved", fileTailId: tail.id };
}

function procStart(pid: number): string | null {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const end = stat.lastIndexOf(")");
		if (end === -1) return null;
		// The suffix starts at field 3 (state), so field 22 is index 19.
		const start = stat
			.slice(end + 1)
			.trim()
			.split(/\s+/)[19];
		return start && /^\d+$/.test(start) ? start : null;
	} catch {
		return null;
	}
}

function errorCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | null)?.code;
}

function readOwner(lock: string): OwnerRecord | null {
	try {
		const record = JSON.parse(readFileSync(lock, "utf8"));
		if (
			record &&
			Number.isSafeInteger(record.pid) &&
			record.pid > 0 &&
			typeof record.host === "string" &&
			(record.procStart === null || typeof record.procStart === "string") &&
			typeof record.sessionFile === "string" &&
			typeof record.startedAt === "number" &&
			Number.isFinite(record.startedAt)
		) {
			return record;
		}
	} catch {
		// Invalid or unreadable initial records are stale, per the lock contract.
	}
	return null;
}

function isAlive(owner: OwnerRecord): boolean {
	try {
		process.kill(owner.pid, 0);
	} catch (error) {
		if (errorCode(error) !== "EPERM") return false;
	}
	return owner.procStart === null || owner.procStart === procStart(owner.pid);
}

function createOwner(lock: string, record: OwnerRecord): void {
	const fd = openSync(lock, "wx", 0o600);
	try {
		writeFileSync(fd, JSON.stringify(record));
	} finally {
		closeSync(fd);
	}
}

function unlinkIfPresent(lock: string): void {
	try {
		unlinkSync(lock);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
}

/** Cooperative/advisory ownership only; this does not lock pi's session writer. */
export function acquireOwnerLock(
	sessionFile: string,
	self: { pid: number; host: string } = { pid: process.pid, host: hostname() },
): LockAcquire {
	const lock = `${sessionFile}.owner.lock`;
	const record: OwnerRecord = {
		pid: self.pid,
		host: self.host,
		procStart: procStart(self.pid),
		sessionFile,
		startedAt: Date.now(),
	};
	try {
		createOwner(lock, record);
		return { status: "acquired" };
	} catch (error) {
		if (errorCode(error) !== "EEXIST") throw error;
	}

	const owner = readOwner(lock);
	if (owner?.pid === self.pid) {
		writeFileSync(lock, JSON.stringify(record));
		return { status: "acquired" };
	}
	if (owner && (owner.host !== self.host || isAlive(owner))) {
		return { status: "live-other", owner };
	}

	unlinkIfPresent(lock);
	try {
		createOwner(lock, record);
		return { status: "acquired" };
	} catch (error) {
		if (errorCode(error) !== "EEXIST") throw error;
		// Retry only once. A racing creator may not have finished writing its JSON.
		// pid=0/empty host/startedAt=0 denote an unknown owner, never persisted.
		return {
			status: "live-other",
			owner: readOwner(lock) ?? {
				pid: 0,
				host: "",
				procStart: null,
				sessionFile,
				startedAt: 0,
			},
		};
	}
}

export function releaseOwnerLock(
	sessionFile: string,
	self: { pid: number } = { pid: process.pid },
): void {
	const lock = `${sessionFile}.owner.lock`;
	if (readOwner(lock)?.pid === self.pid) unlinkIfPresent(lock);
}

export function markerOffVisiblePath(input: {
	sessionFile: string | undefined;
	visibleIds: ReadonlySet<string>;
}): boolean {
	const entries = readEntries(input.sessionFile);
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "custom" && entry.customType === "interrupt-marker") {
			return !input.visibleIds.has(entry.id);
		}
	}
	return false;
}

export const CONFLICT_NOTICE_TYPE = "esc-restore-conflict";
const CONFLICT_NOTICE_TEXT =
	"Another pi process may be writing this session file; an interrupt marker may not be visible on reopen; do not claim a marker was recorded unless it is confirmed.";

export function withConflictNotice(messages: readonly unknown[], active: boolean): unknown[] {
	const result = [...messages];
	if (active) {
		result.push({
			role: "custom",
			customType: CONFLICT_NOTICE_TYPE,
			display: false,
			content: [{ type: "text", text: CONFLICT_NOTICE_TEXT }],
			details: {},
			timestamp: Date.now(),
		});
	}
	return result;
}
