import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import escRestore, { DRAFT_CLEAR_WINDOW_MS, draftClearStep, interruptMarkerText } from "../extensions/esc-restore.ts";

function makeHarness() {
  const handlers = new Map();
  const entryRenderers = new Map();
  const appended = [];
  const pi = {
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerEntryRenderer(name, renderer) {
      entryRenderers.set(name, renderer);
    },
    appendEntry(type, data) {
      appended.push({ type, data });
    },
  };
  escRestore(pi);
  return { handlers, entryRenderers, appended };
}

function editorUi(editorText = "") {
  const state = { editorText, statuses: [], terminalHandler: undefined };
  return {
    state,
    notify() {},
    getEditorText: () => state.editorText,
    setEditorText(text) {
      state.editorText = text;
    },
    setStatus(key, text) {
      state.statuses.push({ key, text });
    },
    onTerminalInput(handler) {
      state.terminalHandler = handler;
      state.unsubscribeCount = state.unsubscribeCount ?? 0;
      return () => {
        state.unsubscribeCount++;
        state.terminalHandler = undefined;
      };
    },
  };
}

function abortedMessage() {
  return { role: "assistant", stopReason: "aborted", errorMessage: "Request was aborted", content: [] };
}

// 1. An aborted assistant message is rewritten so pi does not render "Operation aborted".
{
  const { handlers } = makeHarness();
  const out = handlers.get("message_end")(
    { message: abortedMessage() },
    { hasUI: true, sessionManager: { getBranch: () => [] } },
  );
  assert.equal(out.message.stopReason, "stop", "aborted stub is shown as a normal stop");
  assert.equal(out.message.errorMessage, undefined, "no error text survives the rewrite");
}

// 2. A normal reply is left alone.
{
  const { handlers } = makeHarness();
  const out = handlers.get("message_end")(
    { message: { role: "assistant", stopReason: "stop", content: [] } },
    { hasUI: true },
  );
  assert.equal(out, undefined, "a normal assistant message is not rewritten");
}

// 3. An aborted run appends exactly one Interrupted marker, once the run settles.
{
  const { handlers, appended } = makeHarness();
  const ctx = { hasUI: true };
  handlers.get("message_end")({ message: abortedMessage() }, ctx);
  assert.equal(appended.length, 0, "the marker waits for the run to settle");
  await handlers.get("agent_settled")({}, ctx);
  assert.equal(appended.length, 1, "one marker per aborted run");
  assert.equal(appended[0].type, "interrupt-marker");
  await handlers.get("agent_settled")({}, ctx);
  assert.equal(appended.length, 1, "a later settle does not repeat the marker");
}

// 4. A normal run appends no marker.
{
  const { handlers, appended } = makeHarness();
  await handlers.get("agent_settled")({}, { hasUI: true });
  assert.equal(appended.length, 0, "a normal run shows no marker");
}

// 5. Without a UI, nothing is rewritten and no marker is written.
{
  const { handlers, appended } = makeHarness();
  const ctx = { hasUI: false };
  const out = handlers.get("message_end")({ message: abortedMessage() }, ctx);
  assert.equal(out, undefined, "no rewrite without a UI");
  await handlers.get("agent_settled")({}, ctx);
  assert.equal(appended.length, 0, "no marker without a UI");
}

// 5b. The marker text is fixed to PI, whatever provider or model is active.
{
  assert.equal(
    interruptMarkerText("breeze"),
    "Interrupted · What should PI do instead?",
    "a non-Claude provider still reads PI",
  );
  assert.equal(
    interruptMarkerText(undefined),
    "Interrupted · What should PI do instead?",
    "no provider reads PI",
  );
  assert.equal(
    interruptMarkerText(""),
    "Interrupted · What should PI do instead?",
    "an empty provider reads PI",
  );
}

// 6. The marker renderer is registered and renders the PI label on one line.
{
  const { entryRenderers } = makeHarness();
  const renderer = entryRenderers.get("interrupt-marker");
  assert.ok(renderer, "marker renderer is registered");
  const theme = { fg: (_color, text) => text };
  const component = renderer({ type: "custom", customType: "interrupt-marker", data: {} }, { expanded: false }, theme);
  const lines = component.render(120);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Interrupted · What should PI do instead\?/);
}

// 7. Draft clear: an idle editor with no draft passes Esc through to pi.
{
  const state = { pendingAt: undefined };
  assert.equal(draftClearStep(state, "\x1b", 1000, "", true), "pass");
}

// 8. Draft clear: a streaming run passes Esc through, so the run can still be stopped.
{
  const state = { pendingAt: undefined };
  assert.equal(draftClearStep(state, "\x1b", 1000, "draft", false), "pass");
  assert.equal(state.pendingAt, undefined, "a streaming Esc does not arm the clear");
}

// 9. Draft clear: the first Esc hints, and a second inside the window clears.
{
  const state = { pendingAt: undefined };
  assert.equal(draftClearStep(state, "\x1b", 1000, "draft", true), "hint");
  assert.equal(draftClearStep(state, "\x1b", 1000 + DRAFT_CLEAR_WINDOW_MS, "draft", true), "clear");
}

// 10. Draft clear: a second Esc after the window only re-arms the hint.
{
  const state = { pendingAt: undefined };
  assert.equal(draftClearStep(state, "\x1b", 1000, "draft", true), "hint");
  assert.equal(draftClearStep(state, "\x1b", 1000 + DRAFT_CLEAR_WINDOW_MS + 1, "draft", true), "hint");
}

// 11. Draft clear: a non-Esc key never arms or clears.
{
  const state = { pendingAt: undefined };
  assert.equal(draftClearStep(state, "a", 1000, "draft", true), "pass");
  assert.equal(state.pendingAt, undefined);
}

// 12. Draft clear end to end through the registered terminal listener.
{
  const { handlers } = makeHarness();
  const ui = editorUi("hello draft");
  const ctx = { hasUI: true, ui, isIdle: () => true };
  handlers.get("session_start")({}, ctx);
  assert.ok(ui.state.terminalHandler, "terminal listener is registered");
  assert.deepEqual(ui.state.terminalHandler("\x1b"), { consume: true }, "first Esc is consumed for the hint");
  assert.equal(ui.state.editorText, "hello draft", "first Esc keeps the draft");
  assert.deepEqual(ui.state.terminalHandler("\x1b"), { consume: true }, "second Esc is consumed");
  assert.equal(ui.state.editorText, "", "second Esc clears the draft");
}

// 13. The terminal listener lets Esc through while a run is streaming.
{
  const { handlers } = makeHarness();
  const ui = editorUi("draft");
  const ctx = { hasUI: true, ui, isIdle: () => false };
  handlers.get("session_start")({}, ctx);
  assert.equal(ui.state.terminalHandler("\x1b"), undefined, "a streaming Esc is passed through");
  assert.equal(ui.state.editorText, "draft", "a streaming Esc keeps the draft");
}

// 14. A second session_start (/new or /resume) replaces the terminal listener, so each
//     Esc is handled once. Without this, the draft would clear on the first press.
{
  const { handlers } = makeHarness();
  const ui = editorUi("draft");
  const ctx = { hasUI: true, ui, isIdle: () => true };
  handlers.get("session_start")({}, ctx);
  const firstListener = ui.state.terminalHandler;
  handlers.get("session_start")({}, ctx);
  assert.equal(ui.state.unsubscribeCount, 1, "the previous listener is removed on re-start");
  assert.notEqual(ui.state.terminalHandler, firstListener, "a fresh listener replaces it");
  assert.deepEqual(ui.state.terminalHandler("\x1b"), { consume: true }, "one Esc is a single hint");
  assert.equal(ui.state.editorText, "draft", "one Esc does not clear the draft");
}

function boundUi() {
  const state = { editorText: "" };
  return {
    state,
    onTerminalInput: () => () => {},
    setStatus: () => {},
    getEditorText: () => state.editorText,
    setEditorText: (text) => {
      state.editorText = text;
    },
    notify: () => {},
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: async () => undefined,
    pasteToEditor: () => {},
    editor: async () => undefined,
    addAutocompleteProvider: () => {},
  };
}

async function makeEscSession(responses, gate) {
  const root = await mkdtemp(join(tmpdir(), "pi-esc-restore-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [escRestore],
  });
  await loader.reload();
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const faux = fauxProvider({ provider: "faux-esc-restore" });
  runtime.registerNativeProvider(faux.provider);
  faux.setResponses(responses);
  const originalStreamSimple = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (model, context, options) => {
    const source = originalStreamSimple(model, context, options);
    const output = createAssistantMessageEventStream();
    void (async () => {
      for await (const event of source) {
        if (event.type !== "done" && event.type !== "error") {
          output.push(event);
          continue;
        }
        const message = event.type === "done" ? event.message : event.error;
        if (options?.signal?.aborted) {
          const aborted = { ...message, stopReason: "aborted", errorMessage: "Request was aborted" };
          output.push({ type: "error", reason: "aborted", error: aborted });
          output.end(aborted);
        } else {
          output.push(event);
          output.end(message);
        }
      }
    })();
    return output;
  };

  const slow = defineTool({
    name: "slow",
    label: "slow",
    description: "Wait for the test gate.",
    parameters: Type.Object({}),
    async execute() {
      gate.started();
      await gate.wait;
      return { content: [{ type: "text", text: "slow finished" }] };
    },
  });
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    modelRuntime: runtime,
    model: faux.getModel(),
    noTools: "builtin",
    customTools: [slow],
  });
  const uiContext = boundUi();
  await session.bindExtensions({ uiContext, mode: "tui" });
  return { root, session, uiContext };
}

// 15. A delivered steering prompt with no completed assistant answer is restored after ESC.
{
  let release;
  const gate = { wait: new Promise((resolve) => (release = resolve)), started: () => {} };
  let slowCalls = 0;
  let firstStarted;
  let secondStarted;
  gate.started = () => {
    slowCalls++;
    if (slowCalls === 1) firstStarted?.();
    if (slowCalls === 2) secondStarted?.();
  };
  const { root, session, uiContext } = await makeEscSession(
    [
      fauxAssistantMessage(fauxToolCall("slow", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("slow", {}), { stopReason: "toolUse" }),
    ],
    gate,
  );
  try {
    const first = new Promise((resolve) => (firstStarted = resolve));
    const run = session.prompt("START");
    await first;
    await session.prompt("STEERED PROMPT", { streamingBehavior: "steer" });
    const second = new Promise((resolve) => (secondStarted = resolve));
    release();
    await second;
    await session.abort();
    await run.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(uiContext.state.editorText, "STEERED PROMPT", "delivered unanswered prompt is refilled");
    assert.ok(
      session.sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === "interrupt-marker"),
      "the interrupt marker is appended",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// 16. A delivered steering prompt is merged ahead of a draft that was already in the editor.
{
  let release;
  const gate = { wait: new Promise((resolve) => (release = resolve)), started: () => {} };
  let slowCalls = 0;
  let firstStarted;
  let secondStarted;
  gate.started = () => {
    slowCalls++;
    if (slowCalls === 1) firstStarted?.();
    if (slowCalls === 2) secondStarted?.();
  };
  const { root, session, uiContext } = await makeEscSession(
    [
      fauxAssistantMessage(fauxToolCall("slow", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("slow", {}), { stopReason: "toolUse" }),
    ],
    gate,
  );
  try {
    const first = new Promise((resolve) => (firstStarted = resolve));
    const run = session.prompt("START");
    await first;
    uiContext.setEditorText("DRAFT");
    await session.prompt("STEERED A", { streamingBehavior: "steer" });
    const second = new Promise((resolve) => (secondStarted = resolve));
    release();
    await second;
    await session.abort();
    await run.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(uiContext.state.editorText, "STEERED A\n\nDRAFT", "draft survives delivered prompt refill");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// 17. A queued prompt restored by pi's native Esc path survives delivered prompt refill.
{
  let release;
  const gate = { wait: new Promise((resolve) => (release = resolve)), started: () => {} };
  let slowCalls = 0;
  let firstStarted;
  let secondStarted;
  gate.started = () => {
    slowCalls++;
    if (slowCalls === 1) firstStarted?.();
    if (slowCalls === 2) secondStarted?.();
  };
  const { root, session, uiContext } = await makeEscSession(
    [
      fauxAssistantMessage(fauxToolCall("slow", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("slow", {}), { stopReason: "toolUse" }),
    ],
    gate,
  );
  try {
    const first = new Promise((resolve) => (firstStarted = resolve));
    const run = session.prompt("START");
    await first;
    await session.prompt("STEERED A", { streamingBehavior: "steer" });
    const second = new Promise((resolve) => (secondStarted = resolve));
    release();
    await second;
    await session.prompt("QUEUED B", { streamingBehavior: "steer" });
    session.clearQueue();
    uiContext.setEditorText(["QUEUED B", uiContext.getEditorText()].filter((text) => text.trim()).join("\n\n"));
    await session.abort();
    await run.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(uiContext.state.editorText, "STEERED A\n\nQUEUED B", "queued prompt survives delivered prompt refill");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// 18. A delivered steering prompt that receives a normal answer is not refilled.
{
  let release;
  const gate = { wait: new Promise((resolve) => (release = resolve)), started: () => {} };
  let firstStarted;
  gate.started = () => firstStarted?.();
  const { root, session, uiContext } = await makeEscSession(
    [
      fauxAssistantMessage(fauxToolCall("slow", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("ANSWERED", { stopReason: "stop" }),
    ],
    gate,
  );
  try {
    const first = new Promise((resolve) => (firstStarted = resolve));
    const run = session.prompt("START");
    await first;
    await session.prompt("ANSWERED PROMPT", { streamingBehavior: "steer" });
    release();
    await run;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(uiContext.state.editorText, "", "answered prompt is not refilled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// 19. Per-run state does not leak: an earlier answered run leaves no refill behind, and a later run's
//     own opening prompt is not refilled on ESC. Only prompts steered in during a run are restored.
{
  let release;
  const gate = { wait: new Promise((resolve) => (release = resolve)), started: () => {} };
  let slowCalls = 0;
  let firstStarted;
  let secondStarted;
  gate.started = () => {
    slowCalls++;
    if (slowCalls === 1) firstStarted?.();
    if (slowCalls === 2) secondStarted?.();
  };
  const { root, session, uiContext } = await makeEscSession(
    [
      fauxAssistantMessage("ANSWERED EARLIER", { stopReason: "stop" }),
      fauxAssistantMessage(fauxToolCall("slow", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("slow", {}), { stopReason: "toolUse" }),
    ],
    gate,
  );
  try {
    await session.prompt("ANSWERED EARLIER PROMPT");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(uiContext.state.editorText, "", "an answered run leaves the editor alone");
    uiContext.state.editorText = "";
    const first = new Promise((resolve) => (firstStarted = resolve));
    const run = session.prompt("NEW RUN");
    await first;
    const second = new Promise((resolve) => (secondStarted = resolve));
    release();
    await second;
    await session.abort();
    await run.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(uiContext.state.editorText, "", "a run's own opening prompt is not refilled; only steered prompts are");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

console.log("esc restore interrupt marker: ok");
