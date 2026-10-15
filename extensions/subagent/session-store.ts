/**
 * Persistent session storage for routed subagent runs (Claude Code resume parity).
 *
 * A routed child used to run with `--no-session`, so an interrupted run had no
 * transcript to continue from. Each run now gets a stable pi session id and a
 * dedicated session directory. Resuming a run reopens the same id, so pi replays
 * the prior context, including the synthetic "Operation aborted" result that pi
 * writes for an interrupted tool call.
 *
 * Rules:
 *   - Session ids are derived from the fleet run id so they always satisfy pi's
 *     id rule (letters, digits, '.', '_', '-'; alphanumeric at both ends).
 *   - A finished run is marked by a sidecar state file. Only finished runs are
 *     pruned, so a running session is never deleted out from under its child.
 *   - At most `keep` finished sessions are retained; the oldest are removed.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const RETAINED_FINISHED_RUNS = 20;

/** Directory that holds every routed subagent session. Kept apart from the main `/resume` list. */
export function subagentSessionDir(): string {
	return process.env.PI_SUBAGENT_SESSION_DIR || path.join(getAgentDir(), "subagent-sessions");
}

/**
 * A pi-valid session id for a fleet run. The fleet run id contains ':' and cannot be used
 * directly, so the id is a short hash. It is stable for the same run id.
 */
export function sessionIdForRun(runId: string): string {
	const digest = createHash("sha256").update(runId).digest("hex").slice(0, 24);
	return `sub-${digest}`;
}

export function sessionStatePath(dir: string, sessionId: string): string {
	return path.join(dir, `${sessionId}.state.json`);
}

export type StoredRunStatus = "running" | "done" | "error" | "cancelled";

export interface StoredRunRecord {
	status: StoredRunStatus;
	at: number;
	/** The fleet run id the user sees in the dock and monitor. Resume names a run by this id. */
	runId: string;
	/** The key the session id was derived from, so a resume reopens the same transcript. */
	sessionKey: string;
	/** The agent the run used. A resume runs the same agent. */
	agent: string;
	/** The pi process that owns a running run. A running record whose owner is gone is not live. */
	pid?: number;
}

/** True when the process that owns a running record still exists. */
export function ownerAlive(
	pid: number | undefined,
	probe: (pid: number) => void = defaultProbe,
): boolean {
	if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		probe(pid);
		return true;
	} catch (error) {
		// EPERM means the process exists but belongs to another user: still alive.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function defaultProbe(pid: number): void {
	process.kill(pid, 0);
}

/** A run is live only while it is running and its owning process is alive. */
export function isRunLive(record: StoredRunRecord, probe?: (pid: number) => void): boolean {
	return record.status === "running" && ownerAlive(record.pid, probe);
}

/** Write the run's status. A run is `running` from start until one terminal status is recorded. */
export function recordSessionStatus(dir: string, sessionId: string, record: StoredRunRecord): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(sessionStatePath(dir, sessionId), JSON.stringify(record));
}

/** Find the stored run for a fleet run id. Returns the session id and its record. */
export function findStoredRun(
	dir: string,
	runId: string,
): { sessionId: string; record: StoredRunRecord } | undefined {
	if (!fs.existsSync(dir)) return undefined;
	for (const file of fs.readdirSync(dir)) {
		if (!file.endsWith(".state.json")) continue;
		const sessionId = file.slice(0, -".state.json".length);
		try {
			const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as StoredRunRecord;
			if (parsed.runId === runId) return { sessionId, record: parsed };
		} catch {
			// Unreadable state is skipped; it cannot be matched to a run.
		}
	}
	return undefined;
}

/** Read the run's status. A missing state file means no stored run; unreadable state is `running`. */
export function readSessionStatus(dir: string, sessionId: string): StoredRunStatus | undefined {
	const file = sessionStatePath(dir, sessionId);
	if (!fs.existsSync(file)) return undefined;
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { status?: unknown };
		if (parsed.status === "done" || parsed.status === "error" || parsed.status === "cancelled")
			return parsed.status;
		return "running";
	} catch {
		return "running";
	}
}

/**
 * Delete the oldest finished sessions beyond `keep`. A session without a state file is
 * still running (or was never finished) and is left alone.
 */
export function pruneFinishedSessions(dir: string, keep = RETAINED_FINISHED_RUNS): string[] {
	if (!fs.existsSync(dir)) return [];
	const finished: { id: string; finishedAt: number }[] = [];
	for (const file of fs.readdirSync(dir)) {
		if (!file.endsWith(".state.json")) continue;
		const id = file.slice(0, -".state.json".length);
		const status = readSessionStatus(dir, id);
		if (status === "running" || status === undefined) continue;
		let at = 0;
		try {
			const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as { at?: unknown };
			at = typeof parsed.at === "number" ? parsed.at : 0;
		} catch {
			at = 0;
		}
		finished.push({ id, finishedAt: at });
	}
	finished.sort((a, b) => b.finishedAt - a.finishedAt || a.id.localeCompare(b.id));
	const removed: string[] = [];
	for (const { id } of finished.slice(Math.max(0, keep))) {
		for (const file of fs.readdirSync(dir)) {
			if (
				file === `${id}.state.json` ||
				(file.endsWith(".jsonl") && file.endsWith(`_${id}.jsonl`))
			) {
				fs.rmSync(path.join(dir, file), { force: true });
			}
		}
		removed.push(id);
	}
	return removed;
}

/**
 * Decide whether a stored run may be resumed. `live` means the run is registered in this
 * process and has not finished. A stored `running` status with no live run belongs to a pi
 * that exited, so it is resumable. A user-cancelled run is never resumed (Claude Code 2.1.286:
 * "was stopped by the user and was not resumed").
 */
export function resumeRefusal(
	stored: StoredRunRecord | undefined,
	live: boolean,
): string | undefined {
	if (!stored) return "No stored session exists for that run id.";
	if (live) return "The subagent is still running. Wait for it to finish or cancel it first.";
	if (stored.status === "cancelled")
		return "The subagent was stopped by the user and was not resumed. Treat its work as cancelled; start a new subagent only if the user asks.";
	return undefined;
}
