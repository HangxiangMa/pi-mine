// Exit 130 attribution. A user cancel takes precedence over the parent's abort signal
// when both fired; neither fired means no attribution.
import assert from "node:assert/strict";
import { abortSourceFor } from "../extensions/subagent/abort-source.ts";

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`not ok  ${name}`);
    console.log(err.stack ?? err);
  }
}

check("user cancel alone is attributed to user-cancel", () => {
  assert.equal(abortSourceFor(true, false), "user-cancel");
});

check("parent abort signal alone is attributed to signal-abort", () => {
  assert.equal(abortSourceFor(false, true), "signal-abort");
});

check("user cancel wins when both fired", () => {
  assert.equal(abortSourceFor(true, true), "user-cancel");
});

check("neither fired leaves the source unset", () => {
  assert.equal(abortSourceFor(false, false), undefined);
});

if (failed > 0) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log("subagent abort source: all passed");
