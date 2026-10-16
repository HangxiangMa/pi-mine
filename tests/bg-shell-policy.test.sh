#!/usr/bin/env bash
# pi's background shell must resolve to bash for this pi process, without touching the login shell.
# The decision is checked against pi-background-tasks' real resolveShellPolicy, not a copy of it,
# so a change to how pi reads PI_BG_POSIX_SHELL fails here.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/pi-jiti.sh
source "$here/lib/pi-jiti.sh"
locate_pi_jiti || exit 1

node - "$PI_JITI" "$here/../extensions/bg-shell/policy.ts" "$here/../../pi-background-tasks/src/core/common.ts" "$here/../extensions/bg-shell/index.ts" <<'NODE'
const assert = require("node:assert/strict");
const jiti = require(process.argv[2])(process.cwd(), { interopDefault: true });
const policy = jiti(process.argv[3]);
const common = jiti(process.argv[4]);

const exists = (path) => path === "/bin/bash";
const missing = () => false;

// 1. A value the user already set wins, and the environment is left alone.
{
  const env = { PI_BG_POSIX_SHELL: "sh" };
  const reason = policy.applyBgShellPolicy(env, exists);
  assert.equal(reason, "user-set");
  assert.equal(env.PI_BG_POSIX_SHELL, "sh", "an explicit user setting is never overwritten");
}

// 2. Unset, and bash exists: bash is selected, and pi's own resolver agrees.
{
  const env = {};
  const reason = policy.applyBgShellPolicy(env, exists);
  assert.equal(reason, "bash-selected");
  assert.equal(env.PI_BG_POSIX_SHELL, "bash");
  const resolved = common.resolveShellPolicy("linux", env, "/tmp");
  assert.equal(resolved.policy, "bash", "pi-background-tasks resolves the bash policy");
  assert.equal(resolved.dialect, "bash");
  assert.equal(resolved.executable, "/bin/bash");
}

// 3. Unset, and bash is missing: nothing is written, so pi keeps its default instead of failing.
{
  const env = {};
  const reason = policy.applyBgShellPolicy(env, missing);
  assert.equal(reason, "bash-missing");
  assert.equal(env.PI_BG_POSIX_SHELL, undefined, "no value is written when bash is unavailable");
}

// 4. An empty string counts as unset, so it is treated like the default case.
{
  const env = { PI_BG_POSIX_SHELL: "" };
  assert.equal(policy.applyBgShellPolicy(env, exists), "bash-selected");
  assert.equal(env.PI_BG_POSIX_SHELL, "bash");
}

// 5. The login shell and user dotfiles are not part of the decision at all: the function only
// reads and writes the env object it is given.
{
  const env = { SHELL: "/bin/tcsh" };
  policy.applyBgShellPolicy(env, exists);
  assert.equal(env.SHELL, "/bin/tcsh", "SHELL is never changed");
}

// 6. The real entry point (applyBgShellFromPiMine) on a real process env: it is idempotent, so
// calling it again (or from a second load) changes nothing after the first call.
{
  const entry = jiti(process.argv[5]);
  const env = {};
  entry.applyBgShellFromPiMine(env);
  assert.equal(env.PI_BG_POSIX_SHELL, "bash", "the entry point selects bash when /bin/bash is executable");
  entry.applyBgShellFromPiMine(env);
  assert.equal(env.PI_BG_POSIX_SHELL, "bash", "a second call is a no-op");
  const set = { PI_BG_POSIX_SHELL: "sh" };
  entry.applyBgShellFromPiMine(set);
  assert.equal(set.PI_BG_POSIX_SHELL, "sh", "the entry point never overrides a user choice");
}

console.log("bg shell policy: ok");
NODE
