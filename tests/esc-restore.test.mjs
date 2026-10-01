import assert from "node:assert/strict";
import escRestore from "../extensions/esc-restore.ts";

function makeHarness() {
  const handlers = new Map();
  const commands = new Map();
  const sent = [];
  const pi = {
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerCommand(name, options) {
      commands.set(name, options);
    },
    sendUserMessage(text, options) {
      sent.push({ text, options });
    },
  };
  escRestore(pi);
  return { handlers, commands, sent };
}

function context(navigateTree = async () => {}) {
  return {
    hasUI: true,
    sessionManager: {
      getBranch: () => [{
        type: "message",
        id: "user-1",
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "active prompt" },
      }],
    },
    navigateTree,
  };
}

const harness = makeHarness();
harness.handlers.get("input")({
  type: "input",
  source: "interactive",
  text: "continue with the queued prompt",
  streamingBehavior: "followUp",
});
harness.handlers.get("input")({
  type: "input",
  source: "interactive",
  text: "then verify it",
  streamingBehavior: "steer",
});
await harness.handlers.get("message_end")({
  type: "message_end",
  message: { role: "assistant", stopReason: "aborted" },
}, context());
await harness.handlers.get("agent_settled")({ type: "agent_settled" }, context());
assert.deepEqual(harness.sent, [{
  text: "/esc-rewind",
  options: { deliverAs: "followUp", expandPromptTemplates: true },
}]);

let navigated = 0;
await harness.commands.get("esc-rewind").handler("", context(async (entryId) => {
  assert.equal(entryId, "user-1");
  navigated++;
}));
assert.equal(navigated, 1);
assert.deepEqual(harness.sent.slice(1), [
  { text: "continue with the queued prompt", options: undefined },
  { text: "then verify it", options: { deliverAs: "steer" } },
]);

const ordinary = makeHarness();
ordinary.handlers.get("input")({
  type: "input",
  source: "interactive",
  text: "must not replay after a normal run",
  streamingBehavior: "followUp",
});
await ordinary.handlers.get("agent_settled")({ type: "agent_settled" }, context());
assert.deepEqual(ordinary.sent, []);

console.log("esc restore queue replay: ok");
