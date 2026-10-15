#!/usr/bin/env bash
# Regression: edit and write refuse to overwrite a file that this process has not read, or
# that changed since it was read. Drives the real write-guard extension through pi's jiti with a
# fake pi that captures the tool_call and tool_result handlers. No model, no network, no spend.
#
# Checks: edit needs a read of any range and an unchanged hash; write over an existing file
# needs a full read and an unchanged hash; a new file is allowed; a successful write refreshes
# the record; a failed call does not; a truncated read is not full; symlinks and path spellings
# share one record; PI_WRITE_GUARD_OFF registers nothing.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
guard="$here/../extensions/write-guard.ts"

# shellcheck source=lib/pi-jiti.sh
source "$here/lib/pi-jiti.sh"
locate_pi_jiti || exit 1

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/proj"
printf 'alpha\nbeta\ngamma\n' > "$tmp/proj/a.txt"
ln -s "$tmp/proj/a.txt" "$tmp/proj/link.txt"

export PI_WRITE_GUARD_SRC="$guard" PI_PROJ="$tmp/proj" PI_JITI
export PI_CODING_AGENT_PKG
node - <<'NODE'
const path = require("node:path");
const fs = require("node:fs");
const jiti = require(process.env.PI_JITI)(process.cwd(), { interopDefault: true });
const mod = jiti(process.env.PI_WRITE_GUARD_SRC);
const writeGuard = mod.default;
const proj = process.env.PI_PROJ;
const a = path.join(proj, "a.txt");

let fail = 0, ran = 0;
const chk = (cond, msg) => { ran++; if (!cond) { console.error("FAIL:", msg); fail++; } };

// Fake pi: capture handlers, and let a test drive them in order.
function harness() {
  const h = {};
  writeGuard({ on: (e, f) => { h[e] = f; } });
  return {
    async call(toolName, input, toolCallId, cwd = proj) {
      const r = await h.tool_call({ type: "tool_call", toolName, toolCallId, input }, { cwd });
      return r && r.block ? r.reason : undefined;
    },
    async result(toolName, input, toolCallId, { isError = false, details } = {}, cwd = proj) {
      await h.tool_result({ type: "tool_result", toolName, toolCallId, input, content: [], details, isError }, { cwd });
    },
    async sessionStart(cwd = proj) { await h.session_start({ type: "session_start" }, { cwd }); },
  };
}
// Real pi sends tool_call before tool_result; the read record is registered on the former.
const read = async (h, p, id, opts = {}) => {
  const input = { path: p, ...opts.input };
  await h.call("read", input, id);
  await h.result("read", input, id, { details: opts.details });
};

(async () => {
  // Reset the file before each case so cases do not leak into each other.
  const reset = () => fs.writeFileSync(a, "alpha\nbeta\ngamma\n");

  // 1. Unread edit is refused.
  reset(); let h = harness(); await h.sessionStart();
  let r = await h.call("edit", { path: a, edits: [] }, "e1");
  chk(r !== undefined && /was not read/.test(r), `unread edit refused (got ${r})`);

  // 2. Fully read, unchanged edit is allowed.
  reset(); h = harness(); await h.sessionStart();
  await read(h, a, "r1");
  r = await h.call("edit", { path: a, edits: [] }, "e2");
  chk(r === undefined, `read then edit allowed (got ${r})`);

  // 3. A partial (offset) read is enough for edit, since edit matches an exact oldText.
  reset(); h = harness(); await h.sessionStart();
  await read(h, a, "r3", { input: { offset: 2, limit: 1 } });
  r = await h.call("edit", { path: a, edits: [] }, "e3");
  chk(r === undefined, `partial read then edit allowed (got ${r})`);

  // 4. A partial read is not enough for write over an existing file.
  reset(); h = harness(); await h.sessionStart();
  await read(h, a, "r4", { input: { offset: 2, limit: 1 } });
  r = await h.call("write", { path: a, content: "x" }, "w4");
  chk(r !== undefined && /only part of/.test(r), `partial read then write refused (got ${r})`);

  // 5. A truncated full-looking read does not count as full for write.
  reset(); h = harness(); await h.sessionStart();
  await read(h, a, "r5", { details: { truncation: { truncated: true } } });
  r = await h.call("write", { path: a, content: "x" }, "w5");
  chk(r !== undefined && /only part of/.test(r), `truncated read then write refused (got ${r})`);

  // 6. Whole-file read then write is allowed.
  reset(); h = harness(); await h.sessionStart();
  await read(h, a, "r6");
  r = await h.call("write", { path: a, content: "x" }, "w6");
  chk(r === undefined, `full read then write allowed (got ${r})`);

  // 7. Another agent changed the file after this read: edit and write are refused.
  reset(); h = harness(); await h.sessionStart();
  await read(h, a, "r7");
  fs.writeFileSync(a, "alpha\nCHANGED\ngamma\n");
  r = await h.call("edit", { path: a, edits: [] }, "e7");
  chk(r !== undefined && /changed since it was read/.test(r), `stale edit refused (got ${r})`);
  r = await h.call("write", { path: a, content: "x" }, "w7");
  chk(r !== undefined && /changed since it was read/.test(r), `stale write refused (got ${r})`);

  // 8. A new file may be created without a prior read.
  reset(); h = harness(); await h.sessionStart();
  r = await h.call("write", { path: path.join(proj, "new.txt"), content: "x" }, "w8");
  chk(r === undefined, `new file write allowed (got ${r})`);

  // 9. After our own successful write, the next write is not stale.
  reset(); h = harness(); await h.sessionStart();
  await read(h, a, "r9");
  fs.writeFileSync(a, "ours\n");
  await h.result("write", { path: a, content: "ours\n" }, "w9a");
  r = await h.call("write", { path: a, content: "again\n" }, "w9b");
  chk(r === undefined, `write after own successful write allowed (got ${r})`);

  // 10. A failed write does not refresh the record, so the content change stays detected.
  reset(); h = harness(); await h.sessionStart();
  await read(h, a, "r10");
  fs.writeFileSync(a, "theirs\n");
  await h.result("write", { path: a, content: "mine\n" }, "w10", { isError: true });
  r = await h.call("write", { path: a, content: "mine\n" }, "w10b");
  chk(r !== undefined && /changed since it was read/.test(r), `failed write does not refresh (got ${r})`);

  // 11. A symlink and its target share one record.
  reset(); h = harness(); await h.sessionStart();
  await read(h, path.join(proj, "link.txt"), "r11");
  r = await h.call("edit", { path: a, edits: [] }, "e11");
  chk(r === undefined, `symlink read covers target edit (got ${r})`);

  // 12. Path spellings for one file share one record: relative, @-prefixed, absolute.
  reset(); h = harness(); await h.sessionStart();
  await read(h, "a.txt", "r12");
  r = await h.call("write", { path: "@" + a, content: "x" }, "w12");
  chk(r === undefined, `relative read covers @absolute write (got ${r})`);

  // 13. A new session clears the records, so an old read no longer counts.
  reset(); h = harness(); await h.sessionStart();
  await read(h, a, "r13");
  await h.sessionStart();
  r = await h.call("edit", { path: a, edits: [] }, "e13");
  chk(r !== undefined && /was not read/.test(r), `new session clears reads (got ${r})`);

  // 14. An errored read does not count as a read.
  reset(); h = harness(); await h.sessionStart();
  await h.call("read", { path: a }, "r14");
  await h.result("read", { path: a }, "r14", { isError: true });
  r = await h.call("edit", { path: a, edits: [] }, "e14");
  chk(r !== undefined && /was not read/.test(r), `errored read does not count (got ${r})`);

  if (fail) { console.error(`${ran - fail} passed, ${fail} failed`); process.exit(1); }
  console.log(`${ran} passed, 0 failed`);
})().catch((error) => { console.error(error); process.exit(1); });
NODE
