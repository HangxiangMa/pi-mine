// Wiring tests for PLAN 43. esc-restore must (1) guard the marker write, (2) own a session
// lock, (3) warn when the latest marker is off the visible branch, and (4) inject a
// transient, unpersisted conflict notice while a conflict is active.
// Real session files and the real SessionManager; a fake pi/ctx drives the handlers.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import escRestore from "../extensions/esc-restore.ts";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const assistant = {
  role: "assistant",
  content: [{ type: "text", text: "a" }],
  api: "x",
  provider: "x",
  model: "x",
  usage,
  stopReason: "stop",
  timestamp: Date.now(),
};
const aborted = { ...assistant, stopReason: "aborted", content: [] };
const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });

function harness() {
  const handlers = new Map();
  const appended = [];
  const pi = {
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerEntryRenderer() {},
    appendEntry(type, data) {
      appended.push({ type, data });
    },
  };
  escRestore(pi);
  return { handlers, appended };
}

function fakeCtx(sessionManager, notices) {
  const state = { editorText: "" };
  return {
    hasUI: true,
    model: { provider: "breeze" },
    sessionManager,
    isIdle: () => true,
    ui: {
      notify: (message, type) => notices.push({ message, type }),
      getEditorText: () => state.editorText,
      setEditorText: (text) => {
        state.editorText = text;
      },
      setStatus() {},
      onTerminalInput: () => () => {},
    },
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "s43-wire-"));
  const dir = join(root, "sessions");
  const seed = SessionManager.create(join(root, "repo"), dir);
  seed.appendMessage(user("u1"));
  seed.appendMessage(assistant);
  return { root, file: seed.getSessionFile(), dir };
}

const lockOf = (file) => `${file}.owner.lock`;
const bytesOf = (file) => readFileSync(file, "utf8");
const markerLines = (file) =>
  bytesOf(file)
    .trim()
    .split("\n")
    .filter((line) => line.includes('"customType":"interrupt-marker"'));
const warnings = (notices) => notices.filter((n) => n.type === "warning");

function procStartOf(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[19];
}

/** A real, live process on this host. stop() resolves only after the exit is reaped. */
async function liveChild() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  for (let i = 0; i < 100 && !existsSync(`/proc/${child.pid}/stat`); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return {
    pid: child.pid,
    procStart: procStartOf(child.pid),
    stop: async () => {
      child.kill("SIGKILL");
      await exited;
    },
  };
}

function plantForeignLock(file, child) {
  writeFileSync(
    lockOf(file),
    JSON.stringify({
      pid: child.pid,
      host: hostname(),
      procStart: child.procStart,
      sessionFile: file,
      startedAt: Date.now(),
    }),
  );
}

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

// ---- Layer 1: write guard at agent_settled ---------------------------------------------

test("a1 two-writer: stale leaf does not write the marker and warns", async () => {
  const { root, file, dir } = fixture();
  try {
    const B = SessionManager.open(file, dir);
    const A = SessionManager.open(file, dir);
    A.appendMessage(user("A-live"));
    const { handlers, appended } = harness();
    const notices = [];
    const ctx = fakeCtx(B, notices);
    await handlers.get("agent_start")?.({}, ctx);
    await handlers.get("message_end")?.({ message: aborted }, ctx);
    await handlers.get("agent_settled")?.({}, ctx);
    assert.equal(appended.length, 0, "no marker entry must be appended when the leaf moved");
    assert.equal(markerLines(file).length, 0, "no marker line must reach the file");
    assert.equal(warnings(notices).length, 1, "exactly one warning");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a2 single writer: marker is written and no warning", async () => {
  const { root, file, dir } = fixture();
  try {
    const S = SessionManager.open(file, dir);
    const { handlers, appended } = harness();
    const notices = [];
    const ctx = fakeCtx(S, notices);
    await handlers.get("agent_start")?.({}, ctx);
    await handlers.get("message_end")?.({ message: aborted }, ctx);
    await handlers.get("agent_settled")?.({}, ctx);
    assert.equal(appended.length, 1, "exactly one marker is appended");
    assert.equal(appended[0].type, "interrupt-marker");
    assert.equal(warnings(notices).length, 0, "no warning for a clean writer");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("b6 stale-leaf settle injects a transient notice; a clean settle clears it", async () => {
  const { root, file, dir } = fixture();
  try {
    const B = SessionManager.open(file, dir);
    const A = SessionManager.open(file, dir);
    A.appendMessage(user("A-live"));
    const { handlers } = harness();
    const notices = [];
    const stale = fakeCtx(B, notices);
    await handlers.get("agent_start")?.({}, stale);
    await handlers.get("message_end")?.({ message: aborted }, stale);
    await handlers.get("agent_settled")?.({}, stale);
    const before = bytesOf(file);
    const injected = await handlers.get("context")?.({ type: "context", messages: [user("x")] }, stale);
    const notice = injected?.messages?.find((m) => m.customType === "esc-restore-conflict");
    assert.ok(notice, "a conflict notice is injected while the conflict is active");
    assert.equal(notice.display, false, "the notice is not displayed");
    assert.equal(bytesOf(file), before, "the notice is never written to the session file");

    const clean = fakeCtx(SessionManager.open(file, dir), notices);
    await handlers.get("agent_start")?.({}, clean);
    await handlers.get("message_end")?.({ message: aborted }, clean);
    await handlers.get("agent_settled")?.({}, clean);
    const cleared = await handlers.get("context")?.({ type: "context", messages: [user("x")] }, clean);
    assert.equal(cleared, undefined, "a clean settle clears the conflict");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- Layer 2: owner lock ----------------------------------------------------------------

test("b1 live other owner on start: warn, keep their lock, inject notice", async () => {
  const { root, file, dir } = fixture();
  const child = await liveChild();
  try {
    plantForeignLock(file, child);
    const S = SessionManager.open(file, dir);
    const { handlers } = harness();
    const notices = [];
    const ctx = fakeCtx(S, notices);
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
    assert.equal(warnings(notices).length, 1, "one warning on start");
    assert.equal(JSON.parse(readFileSync(lockOf(file), "utf8")).pid, child.pid, "foreign lock is left in place");
    const before = bytesOf(file);
    const out = await handlers.get("context")?.({ type: "context", messages: [user("x")] }, ctx);
    assert.ok(out?.messages?.some((m) => m.customType === "esc-restore-conflict"), "notice injected");
    assert.equal(bytesOf(file), before, "injection does not touch the session file");
  } finally {
    await child.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("b2 single owner: lock taken, no warning, no injection, released on shutdown", async () => {
  const { root, file, dir } = fixture();
  try {
    const S = SessionManager.open(file, dir);
    const { handlers } = harness();
    const notices = [];
    const ctx = fakeCtx(S, notices);
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
    assert.equal(JSON.parse(readFileSync(lockOf(file), "utf8")).pid, process.pid, "we own the lock");
    assert.equal(warnings(notices).length, 0, "no warning");
    const out = await handlers.get("context")?.({ type: "context", messages: [user("x")] }, ctx);
    assert.equal(out, undefined, "no injection when clean");
    await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctx);
    assert.equal(existsSync(lockOf(file)), false, "lock released on shutdown");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("b5 conflict clears at the next settle once the other owner has exited", async () => {
  const { root, file, dir } = fixture();
  const child = await liveChild();
  try {
    plantForeignLock(file, child);
    const S = SessionManager.open(file, dir);
    const { handlers } = harness();
    const notices = [];
    const ctx = fakeCtx(S, notices);
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
    assert.ok(
      (await handlers.get("context")?.({ type: "context", messages: [] }, ctx))?.messages?.length,
      "conflict active before the other owner exits",
    );
    await child.stop();
    await handlers.get("agent_settled")?.({}, ctx);
    const out = await handlers.get("context")?.({ type: "context", messages: [] }, ctx);
    assert.equal(out, undefined, "conflict cleared after the other owner exited");
    assert.equal(JSON.parse(readFileSync(lockOf(file), "utf8")).pid, process.pid, "we now own the lock");
  } finally {
    await child.stop().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- Layer 3: visible-path check ----------------------------------------------------------

test("b3 marker off the visible branch on start: one warning, no injection", async () => {
  const { root, file, dir } = fixture();
  try {
    const B = SessionManager.open(file, dir);
    const A = SessionManager.open(file, dir);
    B.appendCustomEntry("interrupt-marker", { at: 1, provider: "breeze" });
    A.appendMessage(user("A-after"));
    const S = SessionManager.open(file, dir);
    const { handlers } = harness();
    const notices = [];
    const ctx = fakeCtx(S, notices);
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
    assert.equal(warnings(notices).length, 1, "one visible-path warning");
    const out = await handlers.get("context")?.({ type: "context", messages: [] }, ctx);
    assert.equal(out, undefined, "a visible-path warning alone does not inject");
    await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctx);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- Runner -----------------------------------------------------------------------------

let failed = 0;
for (const { name, fn } of cases) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}: ${error?.message ?? error}`);
  }
}
console.log(`session-guard-wiring: ${cases.length - failed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
