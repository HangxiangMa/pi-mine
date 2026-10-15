#!/usr/bin/env bash
# Regression: a synchronous planner that ends in a question block gets its questions answered in
# the main session, then resumes in the SAME session with the answers. Drives the real
# subagent_routed.execute through pi's jiti; the child is tests/lib/fake-pi-rpc.cjs and the
# picker is an injected ctx.ui.custom. No model, no network, no spend.
#
# Checks: (A) a planner question is shown and the answer resumes the same session id;
# (B) a non-planner agent with the same block is NOT shown a picker; (C) a background planner
# is NOT shown a picker; (D) a cancelled picker returns the cancelled notice with no resume;
# (E) a planner with no question block runs once with no picker; (F) the answer resume reuses
# the first run's session id.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
subagent="$here/../extensions/subagent/index.ts"
taskdock="$here/../extensions/task-dock.ts"

# shellcheck source=lib/pi-jiti.sh
source "$here/lib/pi-jiti.sh"
locate_pi_jiti || exit 1

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

cat > "$tmp/shim.cjs" <<'SHIM'
const real = require(process.env.PI_CODING_AGENT_PKG);
module.exports = { ...real, getAgentDir: () => process.env.PI_ROUTER_TEST_DIR };
SHIM
export PI_ROUTER_TEST_DIR="$tmp"
export PI_CODING_AGENT_PKG

mkdir -p "$tmp/bin"
cat > "$tmp/bin/pi" <<PI
#!/usr/bin/env bash
exec node "$here/lib/fake-pi-rpc.cjs" "\$@"
PI
chmod +x "$tmp/bin/pi"
export PATH="$tmp/bin:$PATH"

mkdir -p "$tmp/agents"
cp "$here/../../../agents/deep-reviewer.md" "$tmp/agents/deep-reviewer.md"
cp "$here/../../../agents/planner.md" "$tmp/agents/planner.md"

export PI_JITI PI_TUI PI_CODING_AGENT_PKG
export PI_SUBAGENT_SRC="$subagent"
export PI_TASK_DOCK_SRC="$taskdock"
export PI_SHIM="$tmp/shim.cjs"
export FAKE_PI_LOG="$tmp/child.log"
export FAKE_PI_ARGV_LOG="$tmp/child-argv.log"
export FAKE_PI_REPLY_FILE="$tmp/reply.txt"
export PQ_TMP="$tmp"
export PI_SUBAGENT_SESSION_DIR="$tmp/subagent-sessions"
mkdir -p "$PI_SUBAGENT_SESSION_DIR"
: > "$FAKE_PI_LOG"
: > "$FAKE_PI_ARGV_LOG"

# The driver is a quoted heredoc: nothing inside it is seen by the shell.
driver="$tmp/driver.cjs"
cat > "$driver" <<'JS'
const fs = require("node:fs");
const path = require("node:path");
const jiti = require(process.env.PI_JITI)(process.cwd(), { interopDefault: true,
  alias: { "@earendil-works/pi-coding-agent": process.env.PI_SHIM, "@earendil-works/pi-tui": process.env.PI_TUI } });
const sub = jiti(process.env.PI_SUBAGENT_SRC);

let passed = 0;
// Texts the main session receives through sendUserMessage (the background result arrives here).
const steered = [];
function check(ok, label) {
  if (!ok) { console.error("FAIL " + label); process.exit(1); }
  console.log("ok " + label);
  passed++;
}

const tools = {};
sub.default({
  registerTool: (t) => { tools[t.name] = t; },
  registerShortcut() {}, registerCommand() {}, on() {}, registerMessageRenderer() {},
  events: { on() {}, emit() {} },
  sendUserMessage(text) { steered.push(String(text)); return Promise.resolve(); },
});

const replyFile = process.env.FAKE_PI_REPLY_FILE;
const setReply = (text) => fs.writeFileSync(replyFile, text);
const QUESTION = [
  "Need one decision first.",
  "```question",
  '{"questions":[{"id":"scope","label":"Scope","options":["narrow","broad"]}]}',
  "```",
].join("\n");
const PLAN = "Final plan: step 1, step 2.";

// The picker is injected. Like the real runGroupedPicker it resolves with { answers } where
// answers is undefined on cancel. After an answer, the fake planner is switched to a plain plan,
// as a real planner does once it has the answers; otherwise it would keep asking to the cap.
let pickerCalls = 0;
let pickerAnswers = { scope: "broad" };
const makeCtx = () => ({
  cwd: process.cwd(), hasUI: true, sessionManager: {}, model: undefined, thinkingLevel: undefined,
  ui: {
    custom: async () => {
      pickerCalls += 1;
      if (pickerAnswers !== undefined) setReply(PLAN);
      return { answers: pickerAnswers };
    },
  },
});

const logText = () => fs.readFileSync(process.env.FAKE_PI_LOG, "utf8");
// Bounded async wait. It must yield to the event loop: a synchronous busy wait starves the
// background child's stdout handling, so the condition can never become true. A background child
// spawns and finishes asynchronously, so a measurement taken right after its receipt would count
// its late spawn. Poll with a deadline; never a fixed sleep.
const waitFor = async (label, predicate) => {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting for " + label);
};
const countOf = (text, needle) => text.split(needle).length - 1;

const argvRecords = () => {
  const text = fs.readFileSync(process.env.FAKE_PI_ARGV_LOG, "utf8").trim();
  return text ? text.split("\n").map((l) => JSON.parse(l).argv) : [];
};
const sessionIdFlag = (argv) => argv[argv.indexOf("--session-id") + 1];
const spawnCount = () => argvRecords().length;

(async () => {
  // A. A planner question is shown, and the answer resumes the same session id.
  setReply(QUESTION); pickerCalls = 0; pickerAnswers = { scope: "broad" };
  const beforeA = spawnCount();
  const a = await tools.subagent_routed.execute(
    "pl-a", { agent: "planner", task: "plan the change", run_in_background: false }, undefined, undefined, makeCtx(),
  );
  check(pickerCalls === 1, "a planner question opens the picker once (got " + pickerCalls + ")");
  check(spawnCount() === beforeA + 2, "the planner runs once, then resumes once (spawns " + beforeA + " -> " + spawnCount() + ")");
  const argvA = argvRecords().slice(beforeA);
  check(sessionIdFlag(argvA[0]) === sessionIdFlag(argvA[1]),
    "the answer resumes the same session id (first " + sessionIdFlag(argvA[0]) + ", resume " + sessionIdFlag(argvA[1]) + ")");
  check(!a.isError, "the planner run finishes without an error");

  // B. Negative: a non-planner agent that prints the same block is NOT given a picker. The
  // question loop is scoped to the planner, so its text is returned unchanged.
  setReply(QUESTION); pickerCalls = 0; pickerAnswers = { scope: "broad" };
  const b = await tools.subagent_routed.execute(
    "pl-b", { agent: "deep-reviewer", task: "review it", run_in_background: false }, undefined, undefined, makeCtx(),
  );
  check(pickerCalls === 0, "a non-planner never opens the picker (got " + pickerCalls + ")");
  check(String(b.content[0].text).includes("```question"), "a non-planner returns its block text unchanged");

  // I. The planner defaults to a synchronous run: with run_in_background UNSET, a planner question
  // still opens the picker in the main session. Other agents keep background as the default.
  setReply(QUESTION); pickerCalls = 0; pickerAnswers = { scope: "broad" };
  const beforeI = spawnCount();
  const iRes = await tools.subagent_routed.execute(
    "pl-i", { agent: "planner", task: "plan it by default" }, undefined, undefined, makeCtx(),
  );
  check(pickerCalls === 1, "a planner with run_in_background unset opens the picker (got " + pickerCalls + ")");
  check(spawnCount() === beforeI + 2, "the default planner run resumes once (spawns " + beforeI + " -> " + spawnCount() + ")");
  check(!iRes.isError, "the default planner run returns without an error");

  // C. Negative: a background planner never opens the picker. Its result arrives as a steer.
  setReply(QUESTION); pickerCalls = 0; pickerAnswers = { scope: "broad" };
  const c = await tools.subagent_routed.execute(
    "pl-c", { agent: "planner", task: "plan in background", run_in_background: true }, undefined, undefined, makeCtx(),
  );
  // Assert only after the background result has been steered. Checking right after the receipt
  // would run before the background path could open a picker, so a regression would pass.
  await waitFor("the background planner result to be steered", () => steered.some((t) => t.startsWith("Background subagent planner")));
  check(pickerCalls === 0, "a background planner never opens the picker (got " + pickerCalls + ")");
  check(!c.isError, "the background planner call returns a receipt");

  // D. A cancelled picker returns the cancelled notice and resumes nothing.
  // Let C's background child finish first, so its spawn cannot land inside D's window.
  await waitFor("the background planner to deliver its result", () => steered.some((t) => t.startsWith("Background subagent planner")));
  setReply(QUESTION); pickerCalls = 0; pickerAnswers = undefined;
  const beforeD = spawnCount();
  const logBeforeD = logText();
  const d = await tools.subagent_routed.execute(
    "pl-d", { agent: "planner", task: "plan the change", run_in_background: false }, undefined, undefined, makeCtx(),
  );
  check(pickerCalls === 1, "a cancelled planner question still opens the picker once (got " + pickerCalls + ")");
  const deltaD = logText().slice(logBeforeD.length);
  check(countOf(deltaD, "The user answered") === 0, "a cancel sends no resume prompt (answer prompts after cancel: " + countOf(deltaD, "The user answered") + ")");
  check(spawnCount() === beforeD + 1, "a cancel resumes nothing: one spawn only (spawns " + beforeD + " -> " + spawnCount() + ")");
  check(String(d.content[0].text).includes("cancelled these questions"), "a cancel returns the cancelled notice");

  // E. A planner with no question block runs once and never opens a picker.
  setReply(PLAN); pickerCalls = 0; pickerAnswers = { scope: "broad" };
  const beforeE = spawnCount();
  const e = await tools.subagent_routed.execute(
    "pl-e", { agent: "planner", task: "plan it", run_in_background: false }, undefined, undefined, makeCtx(),
  );
  check(pickerCalls === 0 && spawnCount() === beforeE + 1,
    "a plain plan runs once with no picker (picker " + pickerCalls + ", spawns " + beforeE + " -> " + spawnCount() + ")");
  check(String(e.content[0].text).includes(PLAN), "a plain plan returns its text");

  // F. The answer resume reuses the first planner run session id (the second spawn).
  setReply(QUESTION); pickerCalls = 0; pickerAnswers = { scope: "broad" };
  const beforeF = spawnCount();
  await tools.subagent_routed.execute(
    "pl-f", { agent: "planner", task: "plan the change", run_in_background: false }, undefined, undefined, makeCtx(),
  );
  const argvF = argvRecords().slice(beforeF);
  check(argvF.length === 2 && sessionIdFlag(argvF[0]) === sessionIdFlag(argvF[1]),
    "the answer resume uses the first run session id (got " + argvF.length + " spawns)");

  // G. A resume_run that is itself the planner's first run keeps its OWN session and run id for the
  // answer resume. Seed a finished planner record with a known session key and run id, resume it
  // with a fresh task that makes the planner ask, and check the follow-up reuses the stored ids.
  const STORED_KEY = "stored-planner-session-key";
  const STORED_RUN = "stored-planner-run";
  const storedSessionId = "sub-" + require("node:crypto").createHash("sha256").update(STORED_KEY).digest("hex").slice(0, 24);
  fs.writeFileSync(path.join(process.env.PI_SUBAGENT_SESSION_DIR, storedSessionId + ".state.json"),
    JSON.stringify({ status: "done", at: Date.now(), runId: STORED_RUN, sessionKey: STORED_KEY, agent: "planner" }));
  setReply(QUESTION); pickerCalls = 0; pickerAnswers = { scope: "broad" };
  const beforeG = spawnCount();
  const g = await tools.subagent_routed.execute(
    "pl-g", { resume_run: STORED_RUN, task: "plan it again", run_in_background: false }, undefined, undefined, makeCtx(),
  );
  const argvG = argvRecords().slice(beforeG);
  check(!g.isError, "a finished planner run resumes (got error " + !!g.isError + ")");
  check(pickerCalls === 1, "the resumed planner opens the picker once (got " + pickerCalls + ")");
  check(argvG.length === 2 && argvG.every((a) => sessionIdFlag(a) === storedSessionId),
    "both spawns reuse the stored session id " + storedSessionId + " (got " + argvG.map((a) => sessionIdFlag(a)).join(",") + ")");
  const storedAfter = JSON.parse(fs.readFileSync(path.join(process.env.PI_SUBAGENT_SESSION_DIR, storedSessionId + ".state.json"), "utf8"));
  check(storedAfter.runId === STORED_RUN, "the stored run id still resolves after the answer resume (runId " + storedAfter.runId + ")");

  // H. A planner whose final message carries the question block in a SECOND text part, after a
  // preamble. The loop must still find it: reading only the first text part would miss the block
  // and the picker would never open. Turned on with FAKE_PI_REPLY_PARTS for this section only.
  setReply("I checked the code and need one decision.\n---PART---\n" + QUESTION);
  process.env.FAKE_PI_REPLY_PARTS = "1";
  pickerCalls = 0; pickerAnswers = { scope: "broad" };
  try {
    await tools.subagent_routed.execute(
      "pl-h", { agent: "planner", task: "plan with a preamble", run_in_background: false }, undefined, undefined, makeCtx(),
    );
  } finally {
    delete process.env.FAKE_PI_REPLY_PARTS;
  }
  check(pickerCalls === 1, "a question block in a later text part still opens the picker (got " + pickerCalls + ")");

  console.log("planner-questions: " + passed + " passed, 0 failed");
  process.exit(0);
})().catch((error) => {
  console.error("FAIL " + ((error && error.stack) || error));
  process.exit(1);
});
JS

# Run the driver with node -e, not as a file: getPiInvocation re-executes argv[1] when it is an
# existing file, which made the driver recurse. With -e there is no argv[1] to re-run.
# A timeout bounds the run so a regression can never fork-bomb the host again.
DRIVER_SRC="$(cat "$driver")"
export DRIVER_SRC
timeout 300 node -e 'eval(process.env.DRIVER_SRC)' > "$tmp/out.log" 2> "$tmp/err.log" || { cat "$tmp/out.log"; cat "$tmp/err.log" >&2; exit 1; }
cat "$tmp/out.log"
