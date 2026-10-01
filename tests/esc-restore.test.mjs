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

function context(navigateTree = async () => {}, { promptText = "active prompt", editorText = promptText } = {}) {
  const ui = {
    editorText,
    getEditorText() {
      return this.editorText;
    },
    setEditorText(text) {
      this.editorText = text;
    },
  };
  return {
    hasUI: true,
    ui,
    sessionManager: {
      getBranch: () => [{
        type: "message",
        id: "user-1",
        timestamp: new Date().toISOString(),
        message: { role: "user", content: promptText },
      }],
    },
    navigateTree: async (entryId) => {
      ui.editorText = promptText;
      await navigateTree(entryId);
    },
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

const consumed = makeHarness();
consumed.handlers.get("input")({
  type: "input",
  source: "interactive",
  text: "queued prompt already started",
  streamingBehavior: "followUp",
});
consumed.handlers.get("before_agent_start")({ prompt: "queued prompt already started" });
await consumed.handlers.get("message_end")({
  type: "message_end",
  message: { role: "assistant", stopReason: "aborted" },
}, context(undefined, { promptText: "queued prompt already started" }));
await consumed.handlers.get("agent_settled")({ type: "agent_settled" }, context());
const consumedContext = context(undefined, { promptText: "queued prompt already started" });
await consumed.commands.get("esc-rewind").handler("", consumedContext);
assert.equal(consumedContext.ui.getEditorText(), "", "an already-started queued prompt is not refilled");
assert.deepEqual(consumed.sent, [{
  text: "/esc-rewind",
  options: { deliverAs: "followUp", expandPromptTemplates: true },
}]);

const mixed = makeHarness();
mixed.handlers.get("input")({
  type: "input",
  source: "interactive",
  text: "duplicate queued prompt",
  streamingBehavior: "followUp",
});
mixed.handlers.get("input")({
  type: "input",
  source: "interactive",
  text: "later queued prompt",
  streamingBehavior: "steer",
});
mixed.handlers.get("before_agent_start")({ prompt: "duplicate queued prompt" });
mixed.handlers.get("before_agent_start")({ prompt: "later queued prompt" });
await mixed.handlers.get("message_end")({
  type: "message_end",
  message: { role: "assistant", stopReason: "aborted" },
}, context(undefined, { promptText: "duplicate queued prompt" }));
await mixed.handlers.get("agent_settled")({ type: "agent_settled" }, context());
const mixedContext = context(undefined, { promptText: "duplicate queued prompt" });
await mixed.commands.get("esc-rewind").handler("", mixedContext);
assert.equal(
  mixedContext.ui.getEditorText(),
  "duplicate queued prompt",
  "an earlier matching prompt does not classify the latest turn as consumed",
);

const ordinary = makeHarness();
ordinary.handlers.get("input")({
  type: "input",
  source: "interactive",
  text: "must not replay after a normal run",
  streamingBehavior: "followUp",
});
ordinary.handlers.get("before_agent_start")({ prompt: "must not replay after a normal run" });
await ordinary.handlers.get("agent_settled")({ type: "agent_settled" }, context());
assert.deepEqual(ordinary.sent, []);

console.log("esc restore queue replay: ok");
