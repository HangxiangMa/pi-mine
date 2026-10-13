import assert from "node:assert/strict";

// request_plan_tools must never be deferred: it is the only route out of an over-narrow Plan
// allowlist, and a deferred tool is hidden from the model until mine_tool_search activates it.
process.env.PI_TOOLSEARCH_OFF = "";
const { default: installToolSearch } = await import("../extensions/tool-search.ts");

const handlers = new Map();
let active = ["bash", "mine_tool_search", "request_plan_tools"];
const tools = [
  { name: "bash", description: "shell" },
  { name: "mine_tool_search", description: "search tools" },
  { name: "request_plan_tools", description: "widen plan allowlist" },
  { name: "delegate_routed", description: "delegate a subagent" },
];
const pi = {
  on(name, handler) { handlers.set(name, handler); },
  registerTool() {},
  getAllTools() { return tools; },
  getActiveTools() { return active.slice(); },
  setActiveTools(next) { active = next.slice(); },
};
const ctx = { mode: "tui", ui: { setStatus() {}, theme: { fg: (_color, text) => text } } };
ctx.sessionManager = {};
installToolSearch(pi);
await handlers.get("session_start")({}, ctx);

assert.ok(active.includes("request_plan_tools"), "request_plan_tools must stay active after tool-search gates");
assert.ok(!active.includes("delegate_routed"), "unrelated extension tools are still deferred");
console.log("tool-search plan keep: passed");
