import assert from "node:assert/strict";

process.env.PI_TOOLSEARCH_TTL_TURNS = "2";
process.env.PI_TOOLSEARCH_OFF = "";
const { default: installToolSearch } = await import("../extensions/tool-search.ts");

const handlers = new Map();
const registered = new Map();
let active = ["bash", "mine_tool_search"];
const tools = [
  { name: "bash", description: "shell" },
  { name: "mine_tool_search", description: "search tools" },
  { name: "delegate_routed", description: "delegate a subagent" },
];
const pi = {
  on(name, handler) { handlers.set(name, handler); },
  registerTool(tool) { registered.set(tool.name, tool); },
  getAllTools() { return tools; },
  getActiveTools() { return active.slice(); },
  setActiveTools(next) { active = next.slice(); },
};
const ctx = { mode: "tui", ui: { setStatus() {}, theme: { fg: (_color, text) => text } } };
ctx.sessionManager = {};
installToolSearch(pi);
await handlers.get("session_start")({}, ctx);
assert.deepEqual(active, ["bash", "mine_tool_search"]);

await handlers.get("turn_start")({ turnIndex: 0 }, ctx);
await registered.get("mine_tool_search").execute("call", { query: "delegate subagent" }, undefined, undefined, ctx);
assert.ok(active.includes("delegate_routed"));
await handlers.get("turn_end")({}, ctx);
await handlers.get("turn_start")({ turnIndex: 1 }, ctx);
await handlers.get("turn_end")({}, ctx);
assert.ok(active.includes("delegate_routed"), "tool survives before TTL");
await handlers.get("turn_start")({ turnIndex: 2 }, ctx);
await handlers.get("turn_end")({}, ctx);
assert.ok(!active.includes("delegate_routed"), "idle tool is reclaimed at TTL");

await handlers.get("turn_start")({ turnIndex: 2 }, ctx);
await registered.get("mine_tool_search").execute("call", { query: "delegate subagent" }, undefined, undefined, ctx);
await handlers.get("tool_execution_start")({ toolName: "delegate_routed" }, ctx);
await handlers.get("turn_end")({}, ctx);
await handlers.get("turn_start")({ turnIndex: 3 }, ctx);
await handlers.get("turn_end")({}, ctx);
assert.ok(active.includes("delegate_routed"), "real call refreshes TTL");
console.log("tool-search TTL: passed");
