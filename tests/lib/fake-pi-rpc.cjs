#!/usr/bin/env node
// Protocol-only stand-in for `pi --mode rpc`, used by subagent-rpc-protocol.test.sh.
//
// It speaks the RPC records the subagent parses and records every stdin command to
// $FAKE_PI_LOG (JSONL), so the test can assert what the parent sent. It mirrors the one
// blocking rule that matters: a dialog request holds the turn open until the parent
// answers it, so an unanswered dialog leaves the child running. Closing stdin is the
// orderly-shutdown request in RPC mode (rpc.md:93), and the child exits on it.
"use strict";
const fs = require("node:fs");

const log = process.env.FAKE_PI_LOG;
const record = (obj) => {
  if (log) fs.appendFileSync(log, `${JSON.stringify(obj)}\n`);
};
const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

let buf = "";
let awaitingDialog = null;

const settle = () => {
  out({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "FAKE-OK" }],
      stopReason: "stop",
      usage: { input: 1, output: 1 },
    },
  });
  out({ type: "agent_end", messages: [], willRetry: false });
  out({ type: "agent_settled", aborted: false });
};

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const cmd = JSON.parse(line);
    record(cmd);
    if (cmd.type === "prompt") {
      out({ type: "response", command: "prompt", success: true, data: { disposition: "started" } });
      // FAKE_PI_HOLD: a child that is still working. It emits no dialog and never settles, so the
      // parent sees a run in flight until it aborts or closes stdin. Off by default.
      if (process.env.FAKE_PI_HOLD === "1") continue;
      // FAKE_PI_HOLD=partial: stream one assistant message (a partial result) and keep working.
      if (process.env.FAKE_PI_HOLD === "partial") {
        out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "PARTIAL" }], stopReason: "toolUse", usage: { input: 1, output: 1 } } });
        continue;
      }
      // Hold the turn open on a dialog. Settle only once the parent answers it.
      awaitingDialog = "dlg-1";
      out({ type: "extension_ui_request", id: "dlg-1", method: "confirm", title: "ok?" });
    } else if (cmd.type === "steer") {
      out({ type: "response", command: "steer", success: true, data: { disposition: "queued" } });
      // Real pi delivers a queued steer before its next model call (rpc-commands.md:46,
      // probed live). The steer is the next input, so it advances the held turn.
      if (awaitingDialog) {
        awaitingDialog = null;
        settle();
      }
    } else if (cmd.type === "extension_ui_response") {
      record({ type: "_dialog_answered", id: cmd.id, cancelled: cmd.cancelled === true });
      if (awaitingDialog === cmd.id) {
        awaitingDialog = null;
        settle();
      }
    }
  }
});

process.stdin.on("end", () => {
  record({ type: "_stdin_end" });
  process.exit(0);
});
