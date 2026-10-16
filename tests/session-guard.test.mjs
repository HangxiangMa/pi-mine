import { spawn } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/index.js";

// Keep the runner dependency-free and report every named case even when the module is absent.
const cases = [];
function test(name, run) {
	cases.push({ name, run });
}
function assert(condition, message = "assertion failed") {
	if (!condition) throw new Error(message);
}
function equal(actual, expected) {
	assert(
		JSON.stringify(actual) === JSON.stringify(expected),
		`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
	);
}
function user() {
	return { role: "user", content: [{ type: "text", text: "u" }], timestamp: Date.now() };
}
function seed(dir) {
	const manager = SessionManager.create(dir, dir);
	manager.appendMessage(user());
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "a" }],
		api: "x",
		provider: "x",
		model: "x",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
	const sessionFile = manager.getSessionFile();
	assert(existsSync(sessionFile), "the lazy session fixture must actually be persisted");
	return { manager, sessionFile };
}
function procStart(pid) {
	// An independent regex oracle: state is field 3, followed by 18 fields, then field 22.
	const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
	const match = stat.match(/^\d+ \(.*\) \S+(?: \S+){18} (\d+)(?: |$)/);
	assert(match, "expected Linux /proc stat with a start-time field");
	return match[1];
}
function owner(sessionFile, overrides = {}) {
	return {
		pid: process.pid,
		host: hostname(),
		procStart: procStart(process.pid),
		sessionFile,
		startedAt: Date.now(),
		...overrides,
	};
}
function putOwner(sessionFile, record) {
	writeFileSync(`${sessionFile}.owner.lock`, JSON.stringify(record), { mode: 0o600 });
}
async function withChild(run) {
	const child = spawn(
		process.execPath,
		[
			"-e",
			'process.title = "guard ) child"; process.stdout.write("ready\\n"); setTimeout(() => {}, 60000);',
		],
		{ stdio: ["ignore", "pipe", "ignore"] },
	);
	try {
		await new Promise((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", () => reject(new Error("child exited before readiness")));
			child.stdout.once("data", resolve);
		});
		await run(child.pid);
	} finally {
		if (child.pid && child.exitCode === null && child.signalCode === null) {
			await new Promise((resolve) => {
				child.once("exit", resolve);
				child.kill();
			});
		}
	}
}
function visibleIds(sessionFile) {
	return new Set(
		SessionManager.open(sessionFile)
			.getBranch()
			.map((entry) => entry.id),
	);
}

test("a1 two-writer leaf-moved", ({ markerWriteDecision }, dir) => {
	const { sessionFile } = seed(dir);
	const writerB = SessionManager.open(sessionFile);
	const writerA = SessionManager.open(sessionFile);
	const fileTailId = writerA.appendMessage(user());
	equal(markerWriteDecision({ sessionFile, leafId: writerB.getLeafId() }), {
		ok: false,
		reason: "leaf-moved",
		fileTailId,
	});
});
test("a2 single writer", ({ markerWriteDecision }, dir) => {
	const { manager, sessionFile } = seed(dir);
	equal(markerWriteDecision({ sessionFile, leafId: manager.getLeafId() }), { ok: true });
});
test("a3 missing file", ({ markerWriteDecision }, dir) => {
	equal(markerWriteDecision({ sessionFile: join(dir, "missing.jsonl"), leafId: "old" }), {
		ok: true,
	});
});
test("a4 undefined file", ({ markerWriteDecision }) => {
	equal(markerWriteDecision({ sessionFile: undefined, leafId: null }), { ok: true });
});
test("a5 empty and header-only file", ({ markerWriteDecision }, dir) => {
	const sessionFile = join(dir, "empty.jsonl");
	writeFileSync(sessionFile, "");
	equal(markerWriteDecision({ sessionFile, leafId: null }), { ok: true });
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: "header-not-leaf" })}\n`);
	equal(markerWriteDecision({ sessionFile, leafId: null }), { ok: true });
});
test("a6 null leaf", ({ markerWriteDecision }, dir) => {
	const { manager, sessionFile } = seed(dir);
	equal(markerWriteDecision({ sessionFile, leafId: null }), {
		ok: false,
		reason: "leaf-moved",
		fileTailId: manager.getLeafId(),
	});
});
test("a7 undefined leaf", ({ markerWriteDecision }, dir) => {
	const { manager, sessionFile } = seed(dir);
	equal(markerWriteDecision({ sessionFile, leafId: undefined }), {
		ok: false,
		reason: "leaf-moved",
		fileTailId: manager.getLeafId(),
	});
});
test("a8 read error fails open", ({ markerWriteDecision }, dir) => {
	// EISDIR is deterministic even when the tests run as root; chmod(000) is not.
	let code;
	try {
		readFileSync(dir, "utf8");
	} catch (error) {
		code = error.code;
	}
	equal(code, "EISDIR");
	equal(markerWriteDecision({ sessionFile: dir, leafId: "old" }), { ok: true });
});
test("a9 malformed lines ignored", ({ markerWriteDecision }, dir) => {
	const { manager, sessionFile } = seed(dir);
	appendFileSync(sessionFile, '\nnot json\nnull\n{}\n{"type":"message"');
	equal(markerWriteDecision({ sessionFile, leafId: manager.getLeafId() }), { ok: true });
});

test("b1 first acquire and metadata", ({ acquireOwnerLock }, dir) => {
	const { sessionFile } = seed(dir);
	const before = Date.now();
	equal(acquireOwnerLock(sessionFile), { status: "acquired" });
	const lock = `${sessionFile}.owner.lock`;
	assert(!lock.endsWith(".jsonl"));
	equal(statSync(lock).mode & 0o777, 0o600);
	const record = JSON.parse(readFileSync(lock, "utf8"));
	equal(Object.keys(record).sort(), ["host", "pid", "procStart", "sessionFile", "startedAt"]);
	equal(record.pid, process.pid);
	equal(record.host, hostname());
	equal(record.procStart, procStart(process.pid));
	equal(record.sessionFile, sessionFile);
	assert(record.startedAt >= before && record.startedAt <= Date.now());
});
test("b2 same pid overwrites", ({ acquireOwnerLock }, dir) => {
	const { sessionFile } = seed(dir);
	putOwner(sessionFile, owner(sessionFile, { host: "other-host", procStart: "0", startedAt: 1 }));
	equal(acquireOwnerLock(sessionFile, { pid: process.pid, host: hostname() }), {
		status: "acquired",
	});
	const record = JSON.parse(readFileSync(`${sessionFile}.owner.lock`, "utf8"));
	equal(record.host, hostname());
	equal(record.procStart, procStart(process.pid));
	assert(record.startedAt > 1);
});
test("b3 live child", async ({ acquireOwnerLock }, dir) => {
	const { sessionFile } = seed(dir);
	await withChild((pid) => {
		const record = owner(sessionFile, { pid, procStart: procStart(pid) });
		putOwner(sessionFile, record);
		const before = readFileSync(`${sessionFile}.owner.lock`);
		equal(acquireOwnerLock(sessionFile), { status: "live-other", owner: record });
		assert(before.equals(readFileSync(`${sessionFile}.owner.lock`)));
	});
});
test("b4 live child without procStart", async ({ acquireOwnerLock }, dir) => {
	const { sessionFile } = seed(dir);
	await withChild((pid) => {
		const record = owner(sessionFile, { pid, procStart: null });
		putOwner(sessionFile, record);
		equal(acquireOwnerLock(sessionFile), { status: "live-other", owner: record });
	});
});
test("b5 reused pid start mismatch", async ({ acquireOwnerLock }, dir) => {
	const { sessionFile } = seed(dir);
	await withChild((pid) => {
		putOwner(
			sessionFile,
			owner(sessionFile, { pid, procStart: String(BigInt(procStart(pid)) + 1n) }),
		);
		equal(acquireOwnerLock(sessionFile), { status: "acquired" });
	});
});
test("b6 dead pid reclaimed", ({ acquireOwnerLock }, dir) => {
	const { sessionFile } = seed(dir);
	putOwner(sessionFile, owner(sessionFile, { pid: 999999999, procStart: null }));
	equal(acquireOwnerLock(sessionFile), { status: "acquired" });
	equal(JSON.parse(readFileSync(`${sessionFile}.owner.lock`, "utf8")).pid, process.pid);
});
test("b7 corrupt JSON reclaimed", ({ acquireOwnerLock }, dir) => {
	const { sessionFile } = seed(dir);
	writeFileSync(`${sessionFile}.owner.lock`, "{broken");
	equal(acquireOwnerLock(sessionFile), { status: "acquired" });
});
test("b8 invalid record reclaimed", ({ acquireOwnerLock }, dir) => {
	const { sessionFile } = seed(dir);
	putOwner(sessionFile, { pid: 999999999 });
	equal(acquireOwnerLock(sessionFile), { status: "acquired" });
});
test("b9 remote host protected", ({ acquireOwnerLock }, dir) => {
	const { sessionFile } = seed(dir);
	const record = owner(sessionFile, {
		pid: 999999999,
		host: `${hostname()}-remote`,
		procStart: "0",
	});
	putOwner(sessionFile, record);
	equal(acquireOwnerLock(sessionFile), { status: "live-other", owner: record });
});
test("b10 EPERM counts as alive", ({ acquireOwnerLock }, dir) => {
	const { sessionFile } = seed(dir);
	const record = owner(sessionFile, { pid: 999999999, procStart: null });
	putOwner(sessionFile, record);
	const kill = process.kill;
	process.kill = (pid, signal) => {
		equal(pid, record.pid);
		equal(signal, 0);
		throw Object.assign(new Error("permission denied"), { code: "EPERM" });
	};
	try {
		equal(acquireOwnerLock(sessionFile), { status: "live-other", owner: record });
	} finally {
		process.kill = kill;
	}
});
test("b11 non-owner release preserves lock", ({ acquireOwnerLock, releaseOwnerLock }, dir) => {
	const { sessionFile } = seed(dir);
	acquireOwnerLock(sessionFile);
	const before = readFileSync(`${sessionFile}.owner.lock`);
	releaseOwnerLock(sessionFile, { pid: 999999999 });
	assert(before.equals(readFileSync(`${sessionFile}.owner.lock`)));
});
test("b12 owner release removes lock", ({ acquireOwnerLock, releaseOwnerLock }, dir) => {
	const { sessionFile } = seed(dir);
	acquireOwnerLock(sessionFile);
	releaseOwnerLock(sessionFile);
	assert(!existsSync(`${sessionFile}.owner.lock`));
});
test("b13 missing release is harmless", ({ releaseOwnerLock }, dir) => {
	releaseOwnerLock(join(dir, "missing.jsonl"));
});
test("b14 corrupt release preserves lock", ({ releaseOwnerLock }, dir) => {
	const { sessionFile } = seed(dir);
	writeFileSync(`${sessionFile}.owner.lock`, "{broken");
	releaseOwnerLock(sessionFile);
	equal(readFileSync(`${sessionFile}.owner.lock`, "utf8"), "{broken");
});

test("c1 marker off branch", ({ markerOffVisiblePath }, dir) => {
	const { manager, sessionFile } = seed(dir);
	const base = manager.getLeafId();
	const marker = manager.appendCustomEntry("interrupt-marker", { at: 1 });
	manager.branch(base);
	manager.appendMessage(user());
	const ids = visibleIds(sessionFile);
	assert(!ids.has(marker));
	equal(markerOffVisiblePath({ sessionFile, visibleIds: ids }), true);
});
test("c2 marker on branch", ({ markerOffVisiblePath }, dir) => {
	const { manager, sessionFile } = seed(dir);
	const marker = manager.appendCustomEntry("interrupt-marker", { at: 1 });
	manager.appendMessage(user());
	const ids = visibleIds(sessionFile);
	assert(ids.has(marker));
	equal(markerOffVisiblePath({ sessionFile, visibleIds: ids }), false);
});
test("c3 no marker", ({ markerOffVisiblePath }, dir) => {
	const { sessionFile } = seed(dir);
	equal(markerOffVisiblePath({ sessionFile, visibleIds: new Set() }), false);
});
test("c4 latest of two off branch", ({ markerOffVisiblePath }, dir) => {
	const { manager, sessionFile } = seed(dir);
	const first = manager.appendCustomEntry("interrupt-marker", { at: 1 });
	const base = manager.appendMessage(user());
	const latest = manager.appendCustomEntry("interrupt-marker", { at: 2 });
	manager.branch(base);
	manager.appendMessage(user());
	const ids = visibleIds(sessionFile);
	assert(ids.has(first) && !ids.has(latest));
	equal(markerOffVisiblePath({ sessionFile, visibleIds: ids }), true);
});
test("c5 latest on branch older off", ({ markerOffVisiblePath }, dir) => {
	const { manager, sessionFile } = seed(dir);
	const base = manager.getLeafId();
	const first = manager.appendCustomEntry("interrupt-marker", { at: 1 });
	manager.branch(base);
	const latest = manager.appendCustomEntry("interrupt-marker", { at: 2 });
	const ids = visibleIds(sessionFile);
	assert(!ids.has(first) && ids.has(latest));
	equal(markerOffVisiblePath({ sessionFile, visibleIds: ids }), false);
});
test("c6 absent or unreadable file", ({ markerOffVisiblePath }, dir) => {
	for (const sessionFile of [undefined, join(dir, "missing.jsonl"), dir]) {
		equal(markerOffVisiblePath({ sessionFile, visibleIds: new Set() }), false);
	}
});
test("c7 custom_message is not marker", ({ markerOffVisiblePath }, dir) => {
	const { sessionFile } = seed(dir);
	appendFileSync(
		sessionFile,
		`${JSON.stringify({ type: "custom_message", customType: "interrupt-marker", id: "not-marker" })}\n`,
	);
	equal(markerOffVisiblePath({ sessionFile, visibleIds: new Set() }), false);
});

test("d1 active notice immutable", ({ withConflictNotice, CONFLICT_NOTICE_TYPE }) => {
	const message = Object.freeze({ role: "user", content: "hello" });
	const messages = Object.freeze([message]);
	const before = Date.now();
	const result = withConflictNotice(messages, true);
	assert(result !== messages && result[0] === message);
	equal(messages, [message]);
	equal(result.length, 2);
	equal(CONFLICT_NOTICE_TYPE, "esc-restore-conflict");
	const notice = result[1];
	assert(notice.timestamp >= before && notice.timestamp <= Date.now());
	equal(notice, {
		role: "custom",
		customType: "esc-restore-conflict",
		display: false,
		content: [
			{
				type: "text",
				text: "Another pi process may be writing this session file; an interrupt marker may not be visible on reopen; do not claim a marker was recorded unless it is confirmed.",
			},
		],
		details: {},
		timestamp: notice.timestamp,
	});
});
test("d2 inactive shallow copy", ({ withConflictNotice }) => {
	const message = Object.freeze({ role: "user", content: "hello" });
	const messages = Object.freeze([message]);
	const result = withConflictNotice(messages, false);
	assert(result !== messages && result[0] === message);
	equal(result, messages);
	equal(withConflictNotice([], false), []);
});

test("e1 readers preserve session bytes", ({ markerWriteDecision, markerOffVisiblePath }, dir) => {
	const { manager, sessionFile } = seed(dir);
	const stale = manager.getLeafId();
	manager.appendCustomEntry("interrupt-marker", { at: 1 });
	const before = readFileSync(sessionFile);
	equal(markerWriteDecision({ sessionFile, leafId: stale }).ok, false);
	equal(markerOffVisiblePath({ sessionFile, visibleIds: new Set() }), true);
	const after = readFileSync(sessionFile);
	equal(after.byteLength, before.byteLength);
	assert(after.equals(before));
});
test("e2 locks preserve session bytes", ({ acquireOwnerLock, releaseOwnerLock }, dir) => {
	const { sessionFile } = seed(dir);
	const before = readFileSync(sessionFile);
	acquireOwnerLock(sessionFile);
	releaseOwnerLock(sessionFile);
	assert(readFileSync(sessionFile).equals(before));
});
test("f exact runtime exports", (guard) => {
	equal(Object.keys(guard).sort(), [
		"CONFLICT_NOTICE_TYPE",
		"acquireOwnerLock",
		"markerOffVisiblePath",
		"markerWriteDecision",
		"releaseOwnerLock",
		"withConflictNotice",
	]);
});

let failed = 0;
for (const { name, run } of cases) {
	const dir = mkdtempSync(join(tmpdir(), "pi-session-guard-test-"));
	try {
		const guard = await import("../extensions/session-guard.ts");
		await run(guard, dir);
		console.log(`PASS ${name}`);
	} catch (error) {
		failed++;
		console.error(`FAIL ${name}: ${error.code ?? error.name}: ${error.message}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
console.log(`session-guard: ${cases.length - failed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
