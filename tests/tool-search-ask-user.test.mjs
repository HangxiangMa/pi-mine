import assert from "node:assert/strict";

// ask_user_question must never be deferred: it is the model's only in-run route to a user
// decision, and a deferred tool is hidden until mine_tool_search activates it.
process.env.PI_TOOLSEARCH_OFF = "";
const { default: installToolSearch } = await import("../extensions/tool-search.ts");

const handlers = new Map();
let active = ["bash", "mine_tool_search", "ask_user_question"];
const tools = [
  { name: "bash", description: "shell" },
  { name: "mine_tool_search", description: "search tools" },
  { name: "ask_user_question", description: "ask the user a multiple-choice question" },
  { name: "delegate_routed", description: "delegate a subagent" },
];
const pi = {
  on(name, handler) {
    handlers.set(name, handler);
  },
  registerTool() {},
  getAllTools() {
    return tools;
  },
  getActiveTools() {
    return active.slice();
  },
  setActiveTools(next) {
    active = next.slice();
  },
};
const ctx = { mode: "tui", ui: { setStatus() {}, theme: { fg: (_color, text) => text } } };
ctx.sessionManager = {};
installToolSearch(pi);
await handlers.get("session_start")({}, ctx);

assert.ok(active.includes("ask_user_question"), "ask_user_question must stay active after tool-search gates");
assert.ok(!active.includes("delegate_routed"), "unrelated extension tools are still deferred");
console.log("tool-search ask_user_question: passed");
