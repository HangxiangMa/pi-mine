import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type CooldownReason = "throttle" | "rate-limit" | "quota";

export interface CooldownEntry {
	until: number;
	reason: CooldownReason;
	failures: number;
}

export type CooldownMap = Map<string, CooldownEntry>;

export interface CooldownClassification {
	reason: CooldownReason;
	baseMs: number;
}

const TRANSIENT_TTL_MS = 2 * 60 * 1000;
const RATE_LIMIT_TTL_MS = 10 * 60 * 1000;
const QUOTA_TTL_MS = 30 * 60 * 1000;
const MAX_TTL_MS = 60 * 60 * 1000;
const LOCK_RETRIES = 12;
const LOCK_RETRY_MS = 5;
const MALFORMED_LOCK_STALE_MS = 30_000;

const QUOTA_RE =
	/\bquota(?:\s+(?:exceeded|exhausted|limit))?\b|quota[_ -]?(?:exceeded|exhausted|limit)/i;
const RATE_LIMIT_RE =
	/\brate[\s_-]?limit(?:ed|ing)?\b|too\s+many\s+requests|\b(?:status|code|http(?:\s+status)?)\s*[:=]?\s*429\b|\b429\s+(?:error|too\s+many|rate|quota|requests?)\b/i;
const THROTTLE_RE = /\bthrottl(?:e|ed|ing)\b/i;

function healthPath(agentDir = getAgentDir()): string {
	return path.join(agentDir, "router-health.json");
}

function lockPath(file: string): string {
	return `${file}.lock`;
}

function sleepSync(ms: number): void {
	const buffer = new SharedArrayBuffer(4);
	Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function parseHealth(raw: unknown): CooldownMap {
	const map: CooldownMap = new Map();
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return map;
	for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof value === "number" && Number.isFinite(value)) {
			map.set(model, { until: value, reason: "rate-limit", failures: 1 });
			continue;
		}
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		const entry = value as Record<string, unknown>;
		if (typeof entry.until !== "number" || !Number.isFinite(entry.until)) continue;
		const reason = entry.reason;
		map.set(model, {
			until: entry.until,
			reason: reason === "throttle" || reason === "quota" ? reason : "rate-limit",
			failures:
				typeof entry.failures === "number" && Number.isFinite(entry.failures)
					? Math.max(1, Math.floor(entry.failures))
					: 1,
		});
	}
	return map;
}

function readRaw(file: string): CooldownMap {
	try {
		return parseHealth(JSON.parse(fs.readFileSync(file, "utf8")));
	} catch {
		return new Map();
	}
}

function writeMap(file: string, map: CooldownMap): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const serialized: Record<string, CooldownEntry> = {};
	for (const [model, entry] of map) serialized[model] = entry;
	const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
	try {
		fs.writeFileSync(tmp, `${JSON.stringify(serialized, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		fs.renameSync(tmp, file);
	} finally {
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* already renamed */
		}
	}
}

function deadOwnerToken(lock: string): string | undefined {
	try {
		const observed = fs.readFileSync(lock, "utf8");
		const raw = JSON.parse(observed) as { pid?: unknown; token?: unknown };
		if (!Number.isInteger(raw.pid) || (raw.pid as number) <= 0 || typeof raw.token !== "string")
			return undefined;
		try {
			process.kill(raw.pid as number, 0);
			return undefined;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") return undefined;
		}
		return fs.readFileSync(lock, "utf8") === observed ? raw.token : undefined;
	} catch {
		return undefined;
	}
}

function malformedLockFingerprint(lock: string): fs.Stats | undefined {
	try {
		const before = fs.statSync(lock);
		if (Date.now() - before.mtimeMs < MALFORMED_LOCK_STALE_MS) return undefined;
		let raw: { pid?: unknown; token?: unknown };
		try {
			raw = JSON.parse(fs.readFileSync(lock, "utf8")) as {
				pid?: unknown;
				token?: unknown;
			};
		} catch (error) {
			if (!(error instanceof SyntaxError)) return undefined;
			raw = {};
		}
		if (Number.isInteger(raw.pid) && (raw.pid as number) > 0 && typeof raw.token === "string")
			return undefined;
		const after = fs.statSync(lock);
		return sameFile(before, after) ? after : undefined;
	} catch {
		return undefined;
	}
}

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs
	);
}

function withHealthLock<T>(file: string, fn: () => T): T | undefined {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const lock = lockPath(file);
	const token = randomUUID();
	let handle: number | undefined;
	for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
		try {
			const candidate = fs.openSync(lock, "wx", 0o600);
			try {
				fs.writeFileSync(candidate, JSON.stringify({ pid: process.pid, token }), "utf8");
				handle = candidate;
				break;
			} catch (error) {
				try {
					fs.closeSync(candidate);
				} catch {
					/* ignore */
				}
				try {
					fs.unlinkSync(lock);
				} catch {
					/* lock cleanup is best-effort */
				}
				throw error;
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const staleToken = deadOwnerToken(lock);
			if (staleToken !== undefined) {
				try {
					const current = JSON.parse(fs.readFileSync(lock, "utf8")) as { token?: unknown };
					if (current.token === staleToken) fs.unlinkSync(lock);
				} catch {
					/* another contender won */
				}
			} else {
				const staleMalformed = malformedLockFingerprint(lock);
				if (staleMalformed) {
					try {
						if (sameFile(staleMalformed, fs.statSync(lock))) fs.unlinkSync(lock);
					} catch {
						/* another contender won */
					}
				}
			}
			if (attempt + 1 < LOCK_RETRIES) sleepSync(LOCK_RETRY_MS);
		}
	}
	if (handle === undefined) {
		console.warn(`router health lock timeout: ${lock}`);
		return undefined;
	}
	try {
		return fn();
	} finally {
		try {
			fs.closeSync(handle);
		} catch {
			/* ignore */
		}
		try {
			const current = JSON.parse(fs.readFileSync(lock, "utf8")) as { pid?: number; token?: string };
			if (current.pid === process.pid && current.token === token) fs.unlinkSync(lock);
		} catch {
			/* lock already removed or malformed */
		}
	}
}

function prune(map: CooldownMap, now: number): boolean {
	let changed = false;
	for (const [model, entry] of map) {
		if (entry.until <= now) {
			map.delete(model);
			changed = true;
		}
	}
	return changed;
}

/** Read current health. Expired records are removed best-effort. */
export function readCooldowns(agentDir = getAgentDir(), now = Date.now()): CooldownMap {
	const file = healthPath(agentDir);
	const map = readRaw(file);
	if (!prune(map, now)) return map;
	const latest = withHealthLock(file, () => {
		const current = readRaw(file);
		prune(current, now);
		writeMap(file, current);
		return current;
	});
	if (latest) return latest;
	const current = readRaw(file);
	prune(current, now);
	return current;
}

export function coolingModels(agentDir = getAgentDir(), now = Date.now()): CooldownMap {
	return readCooldowns(agentDir, now);
}

export function classifyCooldown(text: string): CooldownClassification | undefined {
	if (QUOTA_RE.test(text)) return { reason: "quota", baseMs: QUOTA_TTL_MS };
	if (RATE_LIMIT_RE.test(text)) return { reason: "rate-limit", baseMs: RATE_LIMIT_TTL_MS };
	if (THROTTLE_RE.test(text)) return { reason: "throttle", baseMs: TRANSIENT_TTL_MS };
	return undefined;
}

export function recordCooldown(
	model: string | undefined,
	text: string,
	agentDir = getAgentDir(),
	now = Date.now(),
): CooldownEntry | undefined {
	if (!model) return undefined;
	const classification = classifyCooldown(text);
	if (!classification) return undefined;
	const file = healthPath(agentDir);
	return (
		withHealthLock(file, () => {
			const map = readRaw(file);
			prune(map, now);
			const previous = map.get(model);
			const failures =
				previous && previous.reason === classification.reason ? previous.failures + 1 : 1;
			const ttl = Math.min(MAX_TTL_MS, classification.baseMs * 2 ** (failures - 1));
			const entry: CooldownEntry = { until: now + ttl, reason: classification.reason, failures };
			map.set(model, entry);
			writeMap(file, map);
			return entry;
		}) ?? undefined
	);
}

export function cooldownText(entry: CooldownEntry): string {
	return `${entry.reason} until ${new Date(entry.until).toISOString()}`;
}

export const __test = {
	parseHealth,
	classifyCooldown,
	prune,
	TRANSIENT_TTL_MS,
	RATE_LIMIT_TTL_MS,
	QUOTA_TTL_MS,
	MAX_TTL_MS,
	MALFORMED_LOCK_STALE_MS,
};
