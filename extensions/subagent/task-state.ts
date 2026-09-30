import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
	AcceptanceSpec,
	TaskAttempt,
	TaskControl,
	TaskControlStatus,
	TaskState,
	TakeoverLease,
} from "./packet.ts";

const STATE_DIR_NAME = "subagent-tasks";
const LOCK_RETRIES = 20;
const LOCK_WAIT_MS = 5;

export class TaskStateError extends Error {}

function stateDir(agentDir = getAgentDir()): string {
	return path.join(agentDir, STATE_DIR_NAME);
}

export function taskStatePath(taskId: string, agentDir = getAgentDir()): string {
	return path.join(stateDir(agentDir), `${taskId}.json`);
}

export function isTaskPathAllowed(state: TaskState, candidate: string): boolean {
	const resolved = path.resolve(state.cwd, candidate);
	const relativePath = path.relative(state.cwd, resolved).replaceAll(path.sep, "/");
	if (
		!relativePath ||
		relativePath === ".." ||
		relativePath.startsWith("../") ||
		path.isAbsolute(relativePath)
	)
		return false;
	return state.control.allowedPaths.some((allowed) => {
		const prefix = allowed.replaceAll(path.sep, "/").replace(/^\.\//, "");
		return prefix === "." || relativePath === prefix || relativePath.startsWith(`${prefix}/`);
	});
}

function lockPath(taskId: string, agentDir: string): string {
	return `${taskStatePath(taskId, agentDir)}.lock`;
}

function withLock<T>(taskId: string, agentDir: string, fn: () => T): T {
	fs.mkdirSync(stateDir(agentDir), { recursive: true, mode: 0o700 });
	const lock = lockPath(taskId, agentDir);
	let fd: number | undefined;
	for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
		try {
			fd = fs.openSync(lock, "wx", 0o600);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const until = Date.now() + LOCK_WAIT_MS;
			while (Date.now() < until) {}
		}
	}
	if (fd === undefined) throw new TaskStateError(`Task state is busy: ${taskId}`);
	try {
		return fn();
	} finally {
		try {
			fs.closeSync(fd);
		} catch {}
		try {
			fs.unlinkSync(lock);
		} catch {}
	}
}

function writeAtomic(file: string, value: unknown): void {
	const temp = `${file}.tmp-${process.pid}-${randomUUID()}`;
	try {
		fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		fs.renameSync(temp, file);
	} finally {
		try {
			fs.unlinkSync(temp);
		} catch {}
	}
}

function validateState(value: unknown): TaskState {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new TaskStateError("Invalid task state");
	const state = value as Partial<TaskState>;
	if (
		state.schema !== 1 ||
		typeof state.taskId !== "string" ||
		typeof state.revision !== "number" ||
		typeof state.status !== "string" ||
		typeof state.goal !== "string" ||
		typeof state.cwd !== "string" ||
		!state.control ||
		!Array.isArray(state.attempts)
	)
		throw new TaskStateError("Invalid task state schema");
	return state as TaskState;
}

export function activeTakeoverForCwd(
	cwd: string,
	agentDir = getAgentDir(),
	now = Date.now(),
): TaskState | undefined {
	try {
		for (const entry of fs.readdirSync(stateDir(agentDir), { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			const taskId = entry.name.slice(0, -5);
			const state = readTaskState(taskId, agentDir);
			if (
				state?.status === "lead-writing" &&
				state.lease &&
				state.lease.expiresAt > now &&
				path.resolve(state.cwd) === path.resolve(cwd)
			)
				return state;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

export function readTaskState(taskId: string, agentDir = getAgentDir()): TaskState | undefined {
	try {
		return validateState(JSON.parse(fs.readFileSync(taskStatePath(taskId, agentDir), "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		if (error instanceof TaskStateError) throw error;
		throw new TaskStateError(`Cannot read task state ${taskId}: ${String(error)}`);
	}
}

export function createTaskState(
	goal: string,
	cwd: string,
	control: TaskControl,
	agentDir = getAgentDir(),
): TaskState {
	const taskId = control.taskId ?? randomUUID();
	const state: TaskState = {
		schema: 1,
		taskId,
		revision: 1,
		status: "running",
		goal,
		cwd,
		control: { ...control, taskId },
		reworkCount: 0,
		leadSubmissions: 0,
		attempts: [],
		updatedAt: Date.now(),
	};
	withLock(taskId, agentDir, () => {
		if (readTaskState(taskId, agentDir)) throw new TaskStateError(`Task already exists: ${taskId}`);
		fs.mkdirSync(stateDir(agentDir), { recursive: true, mode: 0o700 });
		writeAtomic(taskStatePath(taskId, agentDir), state);
	});
	return state;
}

export function updateTaskState(
	taskId: string,
	mutate: (state: TaskState) => TaskState,
	agentDir = getAgentDir(),
	expectedRevision?: number,
): TaskState {
	return withLock(taskId, agentDir, () => {
		const current = readTaskState(taskId, agentDir);
		if (!current) throw new TaskStateError(`Unknown task: ${taskId}`);
		if (expectedRevision !== undefined && current.revision !== expectedRevision)
			throw new TaskStateError(
				`Stale task revision for ${taskId}: expected ${expectedRevision}, got ${current.revision}`,
			);
		const next = mutate(structuredClone(current));
		const state = validateState({ ...next, revision: current.revision + 1, updatedAt: Date.now() });
		writeAtomic(taskStatePath(taskId, agentDir), state);
		return state;
	});
}

export function recordTaskAttempt(
	taskId: string,
	attempt: TaskAttempt,
	agentDir = getAgentDir(),
): TaskState {
	return updateTaskState(
		taskId,
		(state) => ({
			...state,
			attempts: [...state.attempts.slice(-15), attempt],
		}),
		agentDir,
	);
}

export function markTakeoverReady(
	taskId: string,
	reason: string,
	agentDir = getAgentDir(),
): TaskState {
	return updateTaskState(
		taskId,
		(state) => ({
			...state,
			status: state.control.allowTakeover ? "takeover-ready" : "needs-user-decision",
			attempts: [
				...state.attempts.slice(-15),
				{ kind: "worker", status: "blocked", reason, at: Date.now() },
			],
		}),
		agentDir,
	);
}

export function acquireTakeover(
	taskId: string,
	owner: string,
	now = Date.now(),
	agentDir = getAgentDir(),
): TaskState {
	return updateTaskState(
		taskId,
		(state) => {
			if (state.status !== "takeover-ready")
				throw new TaskStateError(`Task is not takeover-ready: ${state.status}`);
			if (state.lease && state.lease.expiresAt > now)
				throw new TaskStateError("Task already has an active writer");
			const lease: TakeoverLease = { owner, acquiredAt: now, expiresAt: now + 15 * 60_000 };
			return { ...state, status: "lead-writing", lease };
		},
		agentDir,
	);
}

export function submitTakeover(
	taskId: string,
	owner: string,
	status: "pass" | "fail" | "blocked",
	reason: string | undefined,
	agentDir = getAgentDir(),
): TaskState {
	return updateTaskState(
		taskId,
		(state) => {
			if (state.status !== "lead-writing" || state.lease?.owner !== owner)
				throw new TaskStateError("Takeover lease is not held by this owner");
			const leadSubmissions = state.leadSubmissions + 1;
			const done = status === "pass";
			const exhausted = leadSubmissions >= state.control.maxLeadSubmissions;
			return {
				...state,
				status: done ? "done" : exhausted ? "needs-user-decision" : "takeover-ready",
				leadSubmissions,
				lease: undefined,
				attempts: [
					...state.attempts.slice(-15),
					{ kind: "takeover", status, reason, at: Date.now() },
				],
			};
		},
		agentDir,
	);
}

export function releaseTaskLease(
	taskId: string,
	owner: string,
	agentDir = getAgentDir(),
): TaskState {
	return updateTaskState(
		taskId,
		(state) => {
			if (state.lease?.owner !== owner)
				throw new TaskStateError("Takeover lease is not held by this owner");
			return {
				...state,
				status: state.status === "lead-writing" ? "takeover-ready" : state.status,
				lease: undefined,
			};
		},
		agentDir,
	);
}

export const __test = {
	stateDir,
	validateState,
};
