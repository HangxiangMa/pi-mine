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
const LOCK_STALE_MS = 5_000;
const LOCK_RETRIES = 12;
const LOCK_RETRY_MS = 5;

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

function withHealthLock<T>(file: string, fn: () => T): T | undefined {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const lock = lockPath(file);
	let handle: number | undefined;
	for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
		try {
			handle = fs.openSync(lock, "wx", 0o600);
			break;
		} catch {
			try {
				if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.unlinkSync(lock);
			} catch {
				/* lock disappeared or is unavailable */
			}
			if (attempt + 1 < LOCK_RETRIES) sleepSync(LOCK_RETRY_MS);
		}
	}
	if (handle === undefined) return undefined;
	try {
		return fn();
	} finally {
		try {
			fs.closeSync(handle);
		} catch {
			/* ignore */
		}
		try {
			fs.unlinkSync(lock);
		} catch {
			/* ignore */
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
	if (prune(map, now)) {
		withHealthLock(file, () => {
			const latest = readRaw(file);
			prune(latest, now);
			writeMap(file, latest);
		});
	}
	return map;
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
};
