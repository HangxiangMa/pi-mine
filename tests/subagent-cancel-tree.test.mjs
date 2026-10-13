import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { signalChildTree } from "../extensions/subagent/process-tree.ts";

// Regression: a cancelled subagent whose direct child exits while a grandchild still
// holds stdout/stderr must not leave the parent waiting on `close` forever, and the
// grandchild must be reaped with the group. Mirrors the routed child layout: a detached
// child whose descendant inherits its stdio pipes.
if (process.platform === "win32") {
  console.log("subagent-cancel-tree: skipped on win32");
  process.exit(0);
}

function spawnTreeWithHeldPipe() {
  // Shell backgrounds a long sleep that inherits stdout/stderr, then waits on it.
  const child = spawn("sh", ["-c", "sleep 60 & echo $!; wait"], {
    detached: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return child;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Wait for the grandchild pid the shell echoes, then return it.
function readGrandchildPid(child) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("no grandchild pid")), 3000);
    child.stdout.on("data", (d) => {
      buf += d.toString();
      const pid = Number.parseInt(buf.trim(), 10);
      if (Number.isFinite(pid)) {
        clearTimeout(timer);
        resolve(pid);
      }
    });
  });
}

// Case 1: group SIGTERM reaches the grandchild, so `close` fires without escalation.
{
  const child = spawnTreeWithHeldPipe();
  const grandchildPid = await readGrandchildPid(child);
  assert.ok(isAlive(grandchildPid), "grandchild should be running before cancel");

  const closed = new Promise((resolve) => child.once("close", resolve));
  signalChildTree(child, "SIGTERM");
  const winner = await Promise.race([
    closed.then(() => "closed"),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 3000).unref()),
  ]);
  assert.equal(winner, "closed", "group SIGTERM should let close fire");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(isAlive(grandchildPid), false, "grandchild must be reaped with the group");
}

// Case 2: without the group signal (old behaviour), the held pipe keeps `close` pending
// even after the direct child has exited. This documents the failure being fixed.
{
  const child = spawnTreeWithHeldPipe();
  const grandchildPid = await readGrandchildPid(child);
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.kill("SIGTERM");
  await exited;
  const winner = await Promise.race([
    closed.then(() => "closed"),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 800).unref()),
  ]);
  assert.equal(winner, "timeout", "direct-child-only kill leaves close pending (old bug)");
  // Clean up the escaped grandchild so the test does not leak a process.
  try {
    process.kill(grandchildPid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

console.log("subagent-cancel-tree: 2/2 passed");
