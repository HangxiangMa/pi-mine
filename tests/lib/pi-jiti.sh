# Shared probe for the pi-mine suites that load the real .ts via pi's bundled jiti.
#
# Sourced, not executed. After `locate_pi_jiti` returns 0 it has set:
#   PI_JITI      the jiti package directory
#   PI_TUI       the @earendil-works/pi-tui package directory
#
# On failure it prints one `NOT RUN:` line naming what is missing and returns 1.
# Callers must treat that as a failure (exit non-zero), never as a pass: a suite
# that cannot load the code under test has verified nothing, and an exit 0 here
# let pre-push report green for suites that never ran a single assertion.
#
# Layouts handled, in order:
#   1. the `pi` on PATH is a symlink into the package (Linux lib/node_modules),
#   2. the `pi` shim sits beside a managed install whose current version is
#      recorded in <agent>/install/current-version, with the package and its
#      jiti/pi-tui siblings under <agent>/install/releases/<version>/node_modules.
#      This is the layout the managed installer produces, and the one the older
#      candidate list never matched -- which made every pi-mine suite skip.

locate_pi_jiti() {
  local pi_bin cli pkgname cand jiti="" ver rel
  pkgname="@earendil-works/pi-coding-agent"

  pi_bin="$(command -v pi || true)"
  if [[ -z "$pi_bin" ]]; then
    echo "NOT RUN: pi is not on PATH, so the router/hooks/invariants suites cannot load the code under test"
    return 1
  fi
  cli="$(readlink -f "$pi_bin")"

  local -a cands=(
    "$(dirname "$cli")/../../node_modules/jiti"
    "$(cd "$(dirname "$cli")/.." 2>/dev/null && pwd)/node_modules/jiti"
    "$(dirname "$cli")/node_modules/$pkgname/node_modules/jiti"
    "$(dirname "$pi_bin")/node_modules/$pkgname/node_modules/jiti"
    "$(dirname "$pi_bin")/../lib/node_modules/$pkgname/node_modules/jiti"
  )
  # Managed layout: <agent>/install/releases/<current-version>/node_modules.
  # The agent root follows pi's own getAgentDir(): PI_CODING_AGENT_DIR, else
  # ~/.pi/agent. It must not be derived from `pi`'s location: under npm, PATH puts
  # pi-mine's own node_modules/.bin/pi first, and that location has no managed install.
  local agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
  if [[ -r "$agent_dir/install/current-version" ]]; then
    IFS= read -r ver < "$agent_dir/install/current-version" || ver=""
    if [[ -n "$ver" ]]; then
      cands+=("$agent_dir/install/releases/$ver/node_modules/jiti")
    fi
  fi

  for cand in "${cands[@]}"; do
    [[ -d "$cand" ]] && { jiti="$cand"; break; }
  done
  if [[ -z "$jiti" ]]; then
    echo "NOT RUN: pi package jiti not found (pi at $pi_bin; probed ${#cands[@]} layouts)"
    return 1
  fi

  # pi-tui is a sibling of jiti in the managed layout, nested under the package in
  # the Linux global layout. Accept either; the router imports it for truncateToWidth.
  local tui=""
  for cand in \
    "$(dirname "$jiti")/@earendil-works/pi-tui" \
    "$(dirname "$jiti")/$pkgname/node_modules/@earendil-works/pi-tui"; do
    [[ -d "$cand" ]] && { tui="$cand"; break; }
  done
  if [[ -z "$tui" ]]; then
    echo "NOT RUN: @earendil-works/pi-tui not found next to jiti at $jiti"
    return 1
  fi

  # The pi-coding-agent package itself. Taken from the managed version directory, not
  # from `pi`'s location: under npm, node_modules/.bin puts pi-mine's own copy first on
  # PATH, and deriving from that copy breaks the nested jiti alias resolution.
  local pkg=""
  if [[ -n "${ver:-}" && -d "$agent_dir/install/releases/$ver/node_modules/$pkgname" ]]; then
    pkg="$agent_dir/install/releases/$ver/node_modules/$pkgname"
  fi

  PI_JITI="$jiti"
  PI_TUI="$tui"
  PI_CODING_AGENT_PKG="$pkg"
  export PI_JITI PI_TUI PI_CODING_AGENT_PKG
  return 0
}
