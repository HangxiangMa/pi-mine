// Locate the pi package's jiti for the .mjs suites. Mirrors the managed-layout probe in
// tests/lib/pi-jiti.sh: read <agentDir>/install/current-version and use
// <agentDir>/install/releases/<ver>/node_modules/jiti. The legacy layouts derived from
// the pi executable's location stay as a fallback. Returns undefined when none exists,
// so the caller can fail loudly.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function locatePiJiti(piBin, env = process.env) {
  const agentDir = env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  const candidates = [];
  try {
    const ver = fs.readFileSync(path.join(agentDir, "install", "current-version"), "utf8").trim();
    if (ver) candidates.push(path.join(agentDir, "install", "releases", ver, "node_modules", "jiti"));
  } catch {
    /* no managed install; fall through to the legacy layouts */
  }
  const bin = path.dirname(piBin);
  candidates.push(
    path.join(bin, "../../node_modules/jiti"),
    path.join(bin, "node_modules/@earendil-works/pi-coding-agent/node_modules/jiti"),
    path.join(bin, "../lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti"),
  );
  return candidates.find((candidate) => fs.existsSync(candidate));
}
