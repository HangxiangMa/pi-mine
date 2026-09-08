#!/usr/bin/env bash
# Unit test for pi-mine's extensions/subagent-model-router.ts (vendored under
# pi/vendor/pi-mine in the qcom-private-dotfiles repo).
# Loads the real .ts via pi's bundled jiti with a mock ExtensionAPI (and a shim
# for getAgentDir), feeds fake `tool_call` events, and asserts: tier
# classification, availability model injection, cooldown fallback, and that
# explicit agent/model are respected. No network. Mirrors claude/tests/.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
router="$here/../extensions/subagent-model-router.ts"
# pi/agents/*.md (the tier agent bodies asserted below) are NOT part of this
# package — they stay symlinked separately by the parent repo's install.sh —
# so this still has to reach into the parent qcom-private-dotfiles checkout:
# pi/vendor/pi-mine/tests -> ../../../agents -> pi/agents.
agents_dir="$here/../../../agents"

pi_bin="$(command -v pi || true)"
[[ -n "$pi_bin" ]] || { echo "SKIP: pi not on PATH"; exit 0; }
# Locate the pi package's bundled jiti. The `pi` on PATH may be a real symlink into
# the package (Linux `lib/node_modules/...`) or a shell shim beside it (Windows
# `Roaming/npm/pi`), so try the resolved target's parent first, then the shim's own
# dir + the conventional global package path.
cli="$(readlink -f "$pi_bin")"
pkgname="@earendil-works/pi-coding-agent"
jiti=""
for cand in \
  "$(cd "$(dirname "$cli")/.." 2>/dev/null && pwd)/node_modules/jiti" \
  "$(dirname "$cli")/node_modules/$pkgname/node_modules/jiti" \
  "$(dirname "$pi_bin")/node_modules/$pkgname/node_modules/jiti" \
  "$(dirname "$pi_bin")/../lib/node_modules/$pkgname/node_modules/jiti"; do
  [[ -d "$cand" ]] && { jiti="$cand"; break; }
done
[[ -n "$jiti" ]] || { echo "SKIP: pi package jiti not found (looked near $pi_bin)"; exit 0; }
# subagent-model-router.ts now pulls in task-dock.ts, which imports the real
# @earendil-works/pi-tui for truncateToWidth. That package is nested under
# pi-coding-agent's own node_modules (not hoisted), so alias it explicitly the
# same way getAgentDir is shimmed below, or jiti's plain node resolution misses it.
pitui="$(dirname "$jiti")/@earendil-works/pi-tui"
[[ -d "$pitui" ]] || { echo "SKIP: @earendil-works/pi-tui not found near $jiti"; exit 0; }

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
printf 'exports.getAgentDir = () => process.env.PI_ROUTER_TEST_DIR;\n' > "$tmp/shim.cjs"
export PI_ROUTER_TEST_DIR="$tmp"

PI_ROUTER_TEST_DIR="$tmp" node -e '
const jiti=require(process.argv[1])(process.cwd(),{interopDefault:true,alias:{"@earendil-works/pi-coding-agent":process.argv[3],"@earendil-works/pi-tui":process.argv[5]}});
const fs=require("node:fs"), pathMod=require("node:path");
const mod=jiti(process.argv[2]); const fn=mod.default||mod;
const h={}; const status=[]; const ui={setStatus:(key,value)=>status.push([key,value])};
fn({on:(e,f)=>{h[e]=f;}}); const tc=h.tool_call;
if(!tc){ console.error("no tool_call handler"); process.exit(1); }
const health=pathMod.join(process.env.PI_ROUTER_TEST_DIR,"router-health.json");
let fail=0, ran=0;
const chk=(cond,msg)=>{ ran++; if(!cond){ console.error("FAIL:",msg); fail++; } };

// no cooldown: classification + model injection
try{fs.unlinkSync(health);}catch{}
let e={toolName:"subagent_routed",input:{task:"fix the typo in the README"}}; tc(e);
chk(e.input.agent==="editor","cheap task -> editor (got "+e.input.agent+")");
chk(e.input.model==="qgenie-openai/gpt-5.6-luna","cheap model -> GPT-5.6 Luna (got "+e.input.model+")");
tc(e,{ui});
chk(status[status.length-1][1]==="router: editor → qgenie-openai/gpt-5.6-luna","status shows exact routed provider/model (got "+status[status.length-1][1]+")");

e={toolName:"subagent_routed",input:{task:"review this diff for correctness"}}; tc(e);
chk(e.input.agent==="reviewer","review -> reviewer");
chk(e.input.model==="breeze/claude-sonnet-5","mid model -> breeze sonnet-5 (got "+e.input.model+")");

e={toolName:"subagent_routed",input:{task:"refactor the payment pipeline across modules"}}; tc(e);
chk(e.input.agent==="deep-coder","heavy -> deep-coder");
chk(e.input.model==="breeze/claude-sonnet-5","heavy model -> breeze sonnet-5 (got "+e.input.model+")");

// Policy: no candidate list carries a 1M-context id, so a big-scope task never
// auto-widens the window — it still draws deep-coder\x27s normal 200k primary. 1M is
// reachable ONLY via an explicit caller-set `model` (asserted separately below).
const cool=Date.now()+600000;
e={toolName:"subagent_routed",input:{task:"rewrite the build system across the whole codebase, touching every module"}}; tc(e);
chk(e.input.agent==="deep-coder","large heavy -> deep-coder");
chk(e.input.model==="breeze/claude-sonnet-5","large heavy never auto-widens to 1M -> breeze sonnet-5 (got "+e.input.model+")");
chk(!/(-1m\/|:1M)/.test(e.input.model),"large heavy must not pick a 1M ref (got "+e.input.model+")");

// deep-coder\x27s fallback chain: primary (breeze sonnet-5) -> breeze opus-4.8 ->
// gpt-5.6-sol (last resort). Classification ("deep-coder") must not move as the
// model falls back — only availability changes, never the role.
const heavyTask="rewrite every module of the payment pipeline across the repo";
fs.writeFileSync(health, JSON.stringify({"breeze/claude-sonnet-5": cool}));
e={toolName:"subagent_routed",input:{task:heavyTask}}; tc(e);
chk(e.input.agent==="deep-coder","heavy fallback keeps deep-coder (got "+e.input.agent+")");
chk(e.input.model==="breeze/claude-opus-4-8","heavy: primary cooling -> breeze opus-4.8 (got "+e.input.model+")");
fs.writeFileSync(health, JSON.stringify({"breeze/claude-sonnet-5": cool, "breeze/claude-opus-4-8": cool}));
e={toolName:"subagent_routed",input:{task:heavyTask}}; tc(e);
chk(e.input.model==="qgenie-openai/gpt-5.6-sol","heavy: +breeze opus cooling -> gpt-5.6-sol (got "+e.input.model+")");
try{fs.unlinkSync(health);}catch{}

// Naming several files is still heavy (mutate + files >= 3) independent of the
// cooldown state above — classification, not availability, decides the agent.
e={toolName:"subagent_routed",input:{task:"edit parse_args in ccx.sh, common.sh and install.sh to take the new flag"}}; tc(e);
chk(e.input.agent==="deep-coder","3 named files edited -> deep-coder (got "+e.input.agent+")");
chk(e.input.model==="breeze/claude-sonnet-5","3-file edit, no cooldown -> breeze sonnet-5 (got "+e.input.model+")");

// reviewer\x27s fallback chain: primary (breeze sonnet-5) -> gpt-5.6-terra (last
// resort, 2-entry chain). A large-scope review still never picks a 1M ref.
fs.writeFileSync(health, JSON.stringify({"breeze/claude-sonnet-5": cool}));
e={toolName:"subagent_routed",input:{task:"review the large log dump for correctness"}}; tc(e);
chk(e.input.agent==="reviewer","large mid -> reviewer");
chk(e.input.model==="qgenie-openai/gpt-5.6-terra","mid: primary cooling -> gpt-5.6-terra (got "+e.input.model+")");
chk(!/(-1m\/|:1M)/.test(e.input.model),"large mid must not pick a 1M ref even while cooling (got "+e.input.model+")");
try{fs.unlinkSync(health);}catch{}

// coder\x27s fallback chain: primary (gpt-5.6-luna) -> breeze sonnet-5 -> gpt-5.6-terra.
e={toolName:"subagent_routed",input:{task:"check the dependency in foo.c"}}; tc(e);
chk(e.input.agent==="coder","mid default -> coder (got "+e.input.agent+")");
chk(e.input.model==="qgenie-openai/gpt-5.6-luna","coder primary -> gpt-5.6-luna (got "+e.input.model+")");
fs.writeFileSync(health, JSON.stringify({"qgenie-openai/gpt-5.6-luna": cool}));
e={toolName:"subagent_routed",input:{task:"check the dependency in foo.c"}}; tc(e);
chk(e.input.model==="breeze/claude-sonnet-5","coder: primary cooling -> breeze sonnet-5 (got "+e.input.model+")");
fs.writeFileSync(health, JSON.stringify({"qgenie-openai/gpt-5.6-luna": cool, "breeze/claude-sonnet-5": cool}));
e={toolName:"subagent_routed",input:{task:"check the dependency in foo.c"}}; tc(e);
chk(e.input.model==="qgenie-openai/gpt-5.6-terra","coder: +breeze sonnet cooling -> gpt-5.6-terra (got "+e.input.model+")");
try{fs.unlinkSync(health);}catch{}

// planner\x27s fallback chain: primary (breeze opus-4.8) -> breeze opus-5 -> gpt-5.6-sol.
e={toolName:"subagent_routed",input:{agent:"planner",task:"plan the rollout"}}; tc(e);
chk(e.input.model==="breeze/claude-opus-4-8","planner primary -> breeze opus-4.8 (got "+e.input.model+")");
fs.writeFileSync(health, JSON.stringify({"breeze/claude-opus-4-8": cool}));
e={toolName:"subagent_routed",input:{agent:"planner",task:"plan the rollout"}}; tc(e);
chk(e.input.model==="breeze/claude-opus-5","planner: primary cooling -> breeze opus-5 (got "+e.input.model+")");
fs.writeFileSync(health, JSON.stringify({"breeze/claude-opus-4-8": cool, "breeze/claude-opus-5": cool}));
e={toolName:"subagent_routed",input:{agent:"planner",task:"plan the rollout"}}; tc(e);
chk(e.input.model==="qgenie-openai/gpt-5.6-sol","planner: +breeze opus-5 cooling -> gpt-5.6-sol (got "+e.input.model+")");
try{fs.unlinkSync(health);}catch{}

// deep-reviewer\x27s fallback chain: primary (breeze sonnet-5) -> breeze opus-4.8 ->
// breeze opus-5 (last resort, highest token burn).
e={toolName:"subagent_routed",input:{agent:"deep-reviewer",task:"audit ccx.sh and common.sh together"}}; tc(e);
chk(e.input.model==="breeze/claude-sonnet-5","deep-reviewer primary -> breeze sonnet-5 (got "+e.input.model+")");
fs.writeFileSync(health, JSON.stringify({"breeze/claude-sonnet-5": cool, "breeze/claude-opus-4-8": cool}));
e={toolName:"subagent_routed",input:{agent:"deep-reviewer",task:"audit ccx.sh and common.sh together"}}; tc(e);
chk(e.input.model==="breeze/claude-opus-5","deep-reviewer: primary+opus-4.8 cooling -> breeze opus-5 (got "+e.input.model+")");
try{fs.unlinkSync(health);}catch{}

// investigator: read-only info-gathering / call-stack tracing. It is not
// auto-classified by classify() (dispatched by explicit `agent` only), and it
// deliberately shares editor\x27s exact model list AND cooldown chain — same primary,
// same fallback order, kept in sync by construction (same array, not a copy).
e={toolName:"subagent_routed",input:{agent:"investigator",task:"trace how parse_args reaches do_link"}}; tc(e);
chk(e.input.agent==="investigator","explicit investigator dispatch is never reclassified");
chk(e.input.model==="qgenie-openai/gpt-5.6-luna","investigator primary matches editor -> GPT-5.6 Luna (got "+e.input.model+")");
fs.writeFileSync(health, JSON.stringify({"qgenie-openai/gpt-5.6-luna": cool}));
e={toolName:"subagent_routed",input:{agent:"investigator",task:"trace how parse_args reaches do_link"}}; tc(e);
chk(e.input.model==="qgenie-gemini/vertexai::gemini-3.5-flash","investigator: primary cooling -> gemini, same as editor (got "+e.input.model+")");
fs.writeFileSync(health, JSON.stringify({"qgenie-openai/gpt-5.6-luna": cool, "qgenie-gemini/vertexai::gemini-3.5-flash": cool}));
e={toolName:"subagent_routed",input:{agent:"investigator",task:"trace how parse_args reaches do_link"}}; tc(e);
chk(e.input.model==="breeze/claude-haiku-4-5-20251001","investigator: last resort -> breeze haiku 4.5 (got "+e.input.model+")");
try{fs.unlinkSync(health);}catch{}

// cooldown: park GPT-5.6 Luna -> editor falls back to Gemini, then Haiku.
fs.writeFileSync(health, JSON.stringify({"qgenie-openai/gpt-5.6-luna": Date.now()+600000}));
e={toolName:"subagent_routed",input:{task:"fix a small typo"}}; tc(e);
chk(e.input.agent==="editor","cooldown: still editor");
chk(e.input.model==="qgenie-gemini/vertexai::gemini-3.5-flash","cooldown: luna->gemini (got "+e.input.model+")");
fs.writeFileSync(health, JSON.stringify({"qgenie-openai/gpt-5.6-luna": cool, "qgenie-gemini/vertexai::gemini-3.5-flash": cool}));
e={toolName:"subagent_routed",input:{task:"fix a small typo"}}; tc(e);
chk(e.input.model==="breeze/claude-haiku-4-5-20251001","cooldown: luna+gemini->haiku (got "+e.input.model+")");
try{fs.unlinkSync(health);}catch{}

// respect explicit agent + explicit model
e={toolName:"subagent_routed",input:{agent:"reviewer",task:"fix a typo",model:"custom/x"}}; tc(e);
chk(e.input.agent==="reviewer" && e.input.model==="custom/x","explicit agent+model kept");

// non-subagent untouched
e={toolName:"bash",input:{command:"ls"}}; tc(e);
chk(JSON.stringify(e.input)==="{\"command\":\"ls\"}","non-subagent untouched");

// ---- signal classification, mirrored from claude/tests/subagent-router.test.sh ----
// Same pairs, because a classifier that fixes one direction by breaking the other has
// not improved anything. The tier each agent implies is in AGENT_TIER.
//
// Every assertion here is an EXACT agent name. They used to be `!==` — "not
// deep-coder", "not editor" — which passes for ANY return value: sabotaging classify()
// to `return undefined` left 59 of 86 assertions passing, and 18 of them (13 sites, one
// a 6-iteration loop) could not fail at all. An exact name is what actually pins a
// routing decision, and on pi the name is also the TOOLSET.
const route=(task)=>{ const ev={toolName:"subagent_routed",input:{task}}; tc(ev); return ev.input; };
const cls=(task)=>route(task).agent;
const chkIs=(got,want,msg)=>chk(got===want,msg+" (want "+want+", got "+got+")");
// Toolsets are READ FROM the agent frontmatter, not listed here: "a read-only brief
// must not draw a write-capable agent" is a claim about the tools the routed agent
// actually loads, and a list copied into the test cannot notice `tools:` changing.
const agentTools=(a)=>{
  const f=pathMod.join(process.argv[4],String(a)+".md");
  if(!fs.existsSync(f)) return null;
  const m=/^tools:\s*(.+)$/m.exec(fs.readFileSync(f,"utf-8"));
  return new Set((m?m[1]:"").split(",").map((s)=>s.trim()).filter(Boolean));
};
const canWrite=(a)=>{ const t=agentTools(a); return t!==null && (t.has("edit")||t.has("write")); };
const isReadOnly=(a)=>{ const t=agentTools(a); return t!==null && !t.has("edit") && !t.has("write"); };
// The cheap tier at the MODEL level, for the "review is never cheap" invariant: an
// agent name can be renamed, the price cannot be argued with. Checked with a string
// guard so a dead router (model undefined) fails instead of sliding past the !has().
const CHEAP_MODELS=new Set(["qgenie-openai/gpt-5.6-luna","qgenie-gemini/vertexai::gemini-3.5-flash"]);
const chkNotCheap=(task,msg)=>{ const r=route(task);
  chk(typeof r.model==="string" && !CHEAP_MODELS.has(r.model) && r.agent!=="editor",
      msg+" (got "+r.agent+" / "+r.model+")"); };

// `dependenc` and `complex` were heavy keywords: a one-file lookup priced as
// architecture work. Neither word says anything about scope.
chkIs(cls("check the dependency in foo.c"),"coder","dependency in one file is mid, not heavy");
chkIs(cls("explain the complex bit in parse_args"),"coder","complex is not a scope signal");
// `words <= 40` alone used to demote ANY short brief to the cheap tier, so a 6-word
// judgment question drew a Luna model. Scope, not length, decides now.
chkIs(cls("why does quota_read return None here"),"coder","short judgment ask is mid, not cheap");
// ...and the reverse: a broad sweep whose output is mechanically checkable is still
// cheap, because a wrong answer is detectable without judgment.
chkIs(cls("find every caller of parse_args and report file:line"),"editor","broad but mechanical stays cheap");

// Cheap bounds, one per bound: each is cheap EXCEPT for the single named guard.
chkIs(cls("find the root cause of the stale quota number"),"coder","depth blocks cheap");
chkIs(cls("list the callers in ccx.sh, common.sh and install.sh"),"coder","3 targets block cheap");
chkIs(cls("rename the helper across every template and script in the repo"),"deep-coder","breadth blocks a mechanical edit going cheap");

// Review is never cheap, and unbounded review is cross-file.
chkIs(cls("review this file"),"reviewer","bounded review -> reviewer");
chkIs(cls("audit all of the hook scripts for correctness"),"deep-reviewer","broad review -> deep-reviewer");
chkIs(cls("critique the count of retries"),"reviewer","bounded critique -> reviewer");
for(const p of ["review this file","audit the list of exported names",
                "critique the count of retries","review correctness of the grep helper"]) {
  chkNotCheap(p,"review is never cheap: "+p);
}

// Heavy for judgment at scale; read-only heavy work keeps the read-only role.
chkIs(cls("explain why every request across the gateway times out"),"planner","unbounded explanation -> planner (read-only heavy)");
chkIs(cls("refactor the payment pipeline across every module"),"deep-coder","broad mutation -> deep-coder");
// ...but broad-and-MECHANICAL is not judgment at scale.
chkIs(cls("strip the trailing whitespace in every file under scripts"),"coder","broad mechanical sweep is not heavy");

// pi-only divergence (rung 4): an explicit planning/investigation/gathering ask keeps
// a READ-ONLY agent even when small — but a bounded one is `investigator`
// (read/grep/find/bash, cheap), not `planner` (opus) and not `reviewer` (mid, reserved
// for a correctness verdict). Rung 5 rejects "paying opus rates to withhold a tool" in
// as many words, and rung 4 used to do exactly that: `explore the retry helper` drew
// planner + opus, then reviewer + sonnet, before `investigator` existed to do it for
// the cheap-tier price a pure fact-finding/gathering ask actually costs.
for(const p of ["explore the retry helper","figure out the flag name",
                "what is the best approach for the cache key",
                "research how the gateway does auth","plan the rollout of the new flag",
                "trace how parse_args reaches do_link","summarize the call stack for the retry path",
                "gather everything relevant to the cache key"]) {
  const a=cls(p);
  chkIs(a,"investigator","bounded plan/gather ask -> investigator (read-only, cheap): "+p);
  chk(isReadOnly(a),"plan/gather ask gets a read-only toolset: "+p+" -> "+a);
}
// ...and a plan ask AT SCALE is what `planner` is for.
chkIs(cls("plan the rollout across every hook script in the repo"),"planner","plan ask at scale -> planner");

// pi-only divergence (rung 2): a bounded mechanical edit goes to `editor`, whose own
// frontmatter refuses 3+ file scope. The Claude router has no analog — the same
// dispatch is sonnet there — because that hook cannot swap the requested agent, only
// price it, so it has no bounded-scope agent to hand the job to. Both files say so.
chkIs(cls("fix the typo in parse_args"),"editor","bounded mechanical edit -> editor (pi-only cheap path)");
chk(canWrite(cls("fix the typo in parse_args")),"a mechanical EDIT must draw an agent that can edit");

// ---- the three calibration bugs the Claude router\x27s decision log exposed ----
// Mirrored because both routers share the classifier shape. On pi the stake is higher
// than a price: `mutate` steers onto coder/deep-coder, which carry edit+write, so a
// negation-blind MUTATE hands a read-only investigation the tools to change the tree.

// 1) `contract` was in DEPTH and is also the core word of the contract vocabulary, so
//    one token was evidence in both directions at once.
chkIs(cls("map the whole CLI contract surface across every entry point"),"coder","the word contract is not a depth signal");

// 2) Signals on the raw brief degrade into a verbosity test — measured true on 8 of 8
//    dispatches over 150 words and 0 of 12 under 50. The tokens responsible were the
//    router\x27s OWN injected vocabulary: "Every FAIL: …", "Mark each conclusion …".
const boiler=["Run the vim build in /tmp/gray and tell me whether it links.",
  "Return contract:","- Every FAIL: what broke, with path:line",
  "- Mark each conclusion confirmed/inferred/unverified",
  "- State what you did not check","- Final line: one sentence."].join("\n");
chkIs(cls(boiler),"coder","return-format boilerplate does not make a brief heavy");
// ...and the strip must cut the DEMAND, not the line. This is the regression the suite
// caught: the canonical cheap sweep states its task on the same line as its file:line
// demand, so dropping whole lines deleted the task and it paid mid tier.
chkIs(cls("find every caller of parse_args across the tree and report file:line"),"editor","a same-line file:line demand does not eat the task");
// ...and the same rule must not empty the text either: a terse cheap dispatch is <= 4
// real words once the demand is cut, so the residue rule dropped the whole line,
// taskText() came back EMPTY, `verifiable` was lost and every one of these fell off the
// cheap rung to the mid default.
for(const p of ["list the callers - give path:line","grep for TODO; report path:line",
                "where is main defined? path:line","find get_user (path:line please)",
                "count the hooks - final line only"]) {
  chkIs(cls(p),"editor","stripping must never empty a terse cheap dispatch: "+p);
}

// 3) MUTATE read without negation inverted exactly the clearest briefs: a read-only
//    brief is dense in mutation verbs BECAUSE it forbids them.
const ro="Do not edit any host file and do not fix anything - report only, I apply fixes.\nCheck whether ccx.sh, common.sh and install.sh agree on the flag name.";
// The read-only mid agent, not the write-capable one. Same tier, so the tool
// withdrawal is free. A pi-only rule — on Claude the alias only sets a price.
chkIs(cls(ro),"investigator","read-only brief with 3 targets -> investigator");
chk(isReadOnly(cls(ro)),"a read-only brief must not draw an agent that can edit (got "+cls(ro)+")");
chk(route(ro).model==="qgenie-openai/gpt-5.6-luna","withholding the edit tool must not cost a tier (got "+route(ro).model+")");
for(const neg of ["do not modify anything","don\x27t change any file","read-only sweep",
                  "report only","without editing anything","never write to the tree",
                  "dont edit anything","you must not edit","must not modify",
                  "refrain from editing","avoid editing any file","do not alter the code",
                  "do not create files","do not make any edits","no edits please",
                  "report findings only, no edits","observation only","analysis only",
                  "readonly","hands off the working tree","leave the files alone",
                  "nothing should be changed","non-mutating","I will apply the fixes"]) {
  const task=neg+". Rework parse_args in ccx.sh, common.sh and install.sh.";
  chkIs(cls(task),"investigator","["+neg+"] vetoes mutate");
  chk(isReadOnly(cls(task)),"["+neg+"] must not draw a write-capable agent");
}
// A real mutation ask must survive: the veto keys on a NEGATED verb, not on the verb.
chkIs(cls("edit parse_args in ccx.sh, common.sh and install.sh to take the new flag"),"deep-coder","an un-negated multi-file edit is still deep-coder");
// ...and so must an ask that merely FENCES OFF something it must not break. These two
// were classified read-only by a global veto, and rung 5 then handed a THREE-FILE EDIT
// to `reviewer`, which has no edit tool — a functional failure, not a price. The veto
// is now a cut: the forbidding clauses go, and what is left is checked for an ask.
for(const p of ["there is no need to change the API, just add the flag to ccx.sh and ccx.ps1 and install.sh",
                "the credential path must never change; add do_link support to install.sh, ccx.sh and common.sh"]) {
  const a=cls(p);
  chkIs(a,"deep-coder","a fenced-off thing does not make a three-file edit read-only: "+p);
  chk(canWrite(a),"a three-file EDIT must draw an agent with an edit tool: "+p+" -> "+a);
}
chkIs(cls("do not touch install.sh; fix the typo in parse_args"),"editor","a fence plus a real edit keeps a write-capable agent");
// Review stays heaviest-wins even under a read-only brief — rung 1 runs first.
chkIs(cls("Do not fix anything, report only. Audit ccx.sh, common.sh and install.sh for flag drift."),"deep-reviewer","read-only broad review -> deep-reviewer");

// ---- files vs targets: "several named files" has to mean FILES ----
// `targets` counts snake_case / ALL_CAPS identifiers too, so rung 3 fired on
// single-file edits: each of these named three targets, edited ONE file, and drew
// `deep-coder` + opus.
for(const p of ["rename render_backend to render_target in install.sh",
                "fix parse_args in ccx.sh so MAX_RETRIES is honored",
                "edit install.sh so the symlink step uses do_link instead of copy_file",
                "add render_backend to the CHEAP_AGENTS set in subagent-model-router.py"]) {
  const a=cls(p);
  chkIs(a,"coder","one file, three identifiers: mid, not a cross-file refactor: "+p);
  chk(canWrite(a),"an edit ask keeps the edit tool: "+p+" -> "+a);
}
chkIs(cls("edit install.sh, ccx.sh and common.sh to rename the render_backend helper"),"deep-coder","three named FILES edited is still heavy");
// Rung 1 and rung 2 count files for the same reason rung 3 does. Both bounds asserted
// in the direction the identifier count got wrong: a review of ONE file that names
// three helpers is not a cross-file coherence question, and a typo fix that names two
// helpers is not a 3-file edit that editor would refuse.
chkIs(cls("review parse_args, do_link and copy_file in ccx.sh"),"reviewer","one file, three identifiers reviewed: reviewer, not deep-reviewer");
chkIs(cls("fix the typo in render_backend and render_target in install.sh"),"editor","one file, three identifiers, mechanical: still editor");
// Rung 5 only claims a brief that forbids mutation AND asks for nothing that survives
// the forbidding. A brief that fences off one thing and still asks for an edit inside
// two files never reaches heavy, so without the mutate guard it landed on reviewer,
// which has no edit tool: a functional failure, not a price.
{
  const fenced="do not touch the credential path; rewrite the retry helper in cache.py";
  const a=cls(fenced);
  chkIs(a,"coder","a fenced-off thing plus a one-file rewrite keeps a write-capable agent");
  chk(canWrite(a),"a one-file rewrite must draw an agent with an edit tool (got "+a+")");
}
// ...and ordinary English must not read as a read-only brief. Bare "no" as a negator
// matched "no need to change the flag name", which cut the ask out of the text and
// withdrew the edit tool from work that needed it. Broadening a veto that already
// misfires makes the misfire worse, so the two changes are asserted together.
chkIs(cls("no need to change the flag name"),"coder","an ordinary English no is not a read-only brief");

// ---- "for each" is a shape demand, not scope ----
// BREADTH matches bare `each`, so a per-item OUTPUT demand read as an unbounded set —
// the same class as `contract` in DEPTH, and again in the expensive direction.
chkIs(cls("review the diff and for each finding give a severity"),"reviewer","a per-item output demand is not breadth");
chkIs(cls("list the failing tests and for each one say why"),"coder","for each is a shape demand, not scope");
chkIs(cls("for each of the modules, rewrite the retry helper"),"deep-coder","for each OF a set is still a sweep");

// ---- classification is idempotent, like injection ----
// The injected contract\x27s own ANCHORS line ("Every factual claim …") is a BREADTH
// hit, so re-dispatching a brief that already carried the block escalated it:
// reviewer -> deep-reviewer for nothing the caller said. stripInjected() is now used by
// taskText(), not just by the status bar, which is where this file was inconsistent
// with itself.
e={toolName:"subagent_routed",input:{task:"review the quota helper in cache.py"}}; tc(e);
chkIs(e.input.agent,"reviewer","bounded review -> reviewer (first pass)");
chkIs(cls(e.input.task),"reviewer","a re-dispatch carrying our own contract does not escalate");


// ---- return contract ----
e={toolName:"subagent_routed",input:{task:"find where get_user is defined"}}; tc(e);
chk(/Return contract \(injected/.test(e.input.task),"contract injected into a routed task");
chk(e.input.task.startsWith("find where get_user is defined"),"original task text kept ahead of the contract");
for(const clause of ["ANCHORS","COVERAGE","CONFIDENCE","LENGTH"]) {
  chk(e.input.task.includes(clause),"contract carries "+clause);
}
// Idempotent: re-dispatching a task that already carries the block must not stack it.
const once=e.input.task;
let e2={toolName:"subagent_routed",input:{task:once}}; tc(e2);
chk(e2.input.task.split("Return contract (injected").length-1===1,"contract not stacked on re-dispatch");
// The caller already demanded anchors -> leave their contract alone. Each skip is
// paired with a POSITIVE assertion that the task arrived INTACT: on its own, "no
// injected block" is also what a router that dropped or emptied the task looks like,
// which is how the mirrored Claude assertions passed against a raising with_contract.
const kept=(input,want,msg)=>{ const ev={toolName:"subagent_routed",input}; tc(ev);
  chk(!/Return contract \(injected/.test(ev.input.task),msg+": no injected block");
  chk(ev.input.task===want,msg+": task intact (got "+JSON.stringify(ev.input.task)+")"); };
kept({task:"list the callers and give me path:line for each"},
     "list the callers and give me path:line for each",
     "a caller-supplied path:line contract is not competed with");
// A caller who named the agent made a deliberate choice: no injection, same restraint
// as the full passthrough the Claude hook gives an explicit model.
kept({agent:"reviewer",task:"review the quota helper"},"review the quota helper",
     "explicit agent -> no contract injected");
// ...and the named agent is not second-guessed either: the caller chose the role, so
// the toolset and the tier both stay theirs.
{ const ev={toolName:"subagent_routed",input:{agent:"reviewer",task:"rewrite every module in the repo"}}; tc(ev);
  chkIs(ev.input.agent,"reviewer","an explicitly named agent is never reclassified"); }
// The contract must not be what tips a brief into the 1M window: the model is picked
// before it is appended.
e={toolName:"subagent_routed",input:{task:"find where get_user is defined"}}; tc(e);
chk(e.input.model==="qgenie-openai/gpt-5.6-luna","contract does not change the 200k model pick (got "+e.input.model+")");

// Every routed agent name must exist as a pi agent file, or classify() names a role
// that cannot load. And each body must state the same four constraints the router
// injects: a caller who names the agent gets NO injected contract, so that skip is
// only safe while the agent covers it itself.
for(const a of ["editor","coder","reviewer","deep-reviewer","deep-coder","planner","investigator"]) {
  const f=pathMod.join(process.argv[4],a+".md");
  chk(fs.existsSync(f),"pi/agents/"+a+".md exists");
  if(!fs.existsSync(f)) continue;
  const body=fs.readFileSync(f,"utf-8");
  for(const clause of ["ANCHORS","COVERAGE","CONFIDENCE","LENGTH"]) {
    chk(body.includes(clause),"pi/agents/"+a+".md states "+clause);
  }
}

if(fail){ console.error((ran-fail)+" passed, "+fail+" failed"); process.exit(1); }
console.log(ran+" passed, 0 failed");
' "$jiti" "$router" "$tmp/shim.cjs" "$agents_dir" "$pitui"
