#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const jitiPath = process.env.PI_JITI_PATH;
if (!jitiPath) {
  console.log("SKIP: PI_JITI_PATH is not set");
  process.exit(0);
}

const memoryIndex = process.env.PI_MEMORY_INDEX ??
  "/local/mnt/workspace/hangxian/.nvm/versions/node/v24.19.0/lib/node_modules/pi-memory/index.ts";
const createJiti = createRequire(import.meta.url)(jitiPath);
let memory;

async function capture(mode, memoryDir) {
  process.env.PI_MEMORY_DIR = memoryDir;
  process.env.PI_MEMORY_SNAPSHOT = mode;
  process.env.PI_MEMORY_NO_SEARCH = "1";
  process.env.PI_MEMORY_EXIT_SUMMARY = "0";

  const handlers = new Map();
  const tools = new Map();
  const fakePi = {
    on(name, handler) { handlers.set(name, handler); },
    registerTool(definition) { tools.set(definition.name, definition); },
    registerCommand() {},
  };
  const extension = memory.default ?? memory;
  extension(fakePi);
  const beforeAgentStart = handlers.get("before_agent_start");
  assert.equal(typeof beforeAgentStart, "function", `${mode}: before_agent_start registered`);
  const ctx = {};
  const first = await beforeAgentStart({ systemPrompt: "BASE", prompt: "first prompt" }, ctx);
  await writeFile(join(memoryDir, "daily", "2026-09-08.md"), "UPDATED-MARKER\n", "utf8");
  const second = await beforeAgentStart({ systemPrompt: "BASE", prompt: "second prompt" }, ctx);
  return {
    first: first?.systemPrompt ?? "",
    second: second?.systemPrompt ?? "",
    tools,
  };
}

const dir = await mkdtemp(join(tmpdir(), "pi-memory-snapshot-")).catch((error) => {
  throw new Error(`cannot create temp memory dir: ${error}`);
});
try {
  await mkdir(join(dir, "daily"), { recursive: true });
  await writeFile(join(dir, "MEMORY.md"), "STABLE-MARKER\n", "utf8");
  await writeFile(join(dir, "SCRATCHPAD.md"), "- [ ] verify memory\n", "utf8");
  await writeFile(join(dir, "daily", "2026-09-08.md"), "INITIAL-MARKER\n", "utf8");
  process.env.PI_MEMORY_DIR = dir;
  memory = await createJiti(import.meta.url, { moduleCache: false }).import(memoryIndex, { default: true });

  const stable = await capture("stable", dir);
  assert.match(stable.first, /The following memory files have been loaded/);
  assert.equal(stable.first, stable.second, "stable snapshot remains byte-stable across turns");
  assert.match(stable.first, /INITIAL-MARKER/);
  assert.doesNotMatch(stable.second, /UPDATED-MARKER/);

  const stableRead = await stable.tools.get("memory_read").execute("test", { target: "daily", date: "2026-09-08" });
  assert.match(stableRead.content[0].text, /UPDATED-MARKER/, "stable mode still reads latest state on demand");

  await writeFile(join(dir, "daily", "2026-09-08.md"), "INITIAL-MARKER\n", "utf8");
  const perTurn = await capture("per-turn", dir);
  assert.notEqual(perTurn.first, perTurn.second, "per-turn snapshot rebuilds after file changes");
  assert.match(perTurn.second, /UPDATED-MARKER/);

  console.log(JSON.stringify({
    pass: true,
    quality: {
      injectionHeader: stable.first.includes("The following memory files have been loaded"),
      stableLatestRead: stableRead.content[0].text.includes("UPDATED-MARKER"),
    },
    stable: { chars: stable.first.length, byteStable: stable.first === stable.second },
    perTurn: { firstChars: perTurn.first.length, secondChars: perTurn.second.length, refreshed: perTurn.first !== perTurn.second },
  }));
} finally {
  await rm(dir, { recursive: true, force: true });
}
