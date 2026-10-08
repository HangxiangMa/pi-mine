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
packet="$here/../extensions/subagent/packet.ts"
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
  "$(dirname "$cli")/../../node_modules/jiti" \
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
const packets=jiti(process.argv[6]);
const metrics=jiti(process.argv[7]);
const taskDock=jiti(process.argv[9]);
const h={}; const status=[]; const ui={setStatus:(key,value)=>status.push([key,value])};
(async()=>{
fn({on:(e,f)=>{h[e]=f;}}); const tc=h.tool_call; const tr=h.tool_result;
if(!tc){ console.error("no tool_call handler"); process.exit(1); }
const health=pathMod.join(process.env.PI_ROUTER_TEST_DIR,"router-health.json");
let fail=0, ran=0;
const chk=(cond,msg)=>{ ran++; if(!cond){ console.error("FAIL:",msg); fail++; } };

// Cooldown classification, persistence, and exponential backoff are shared by
// the router hook and the child executor; keep these invariants close to routing.
const healthMod=jiti(process.argv[8]);
const healthDir=pathMod.join(process.env.PI_ROUTER_TEST_DIR,"health-state");
fs.mkdirSync(healthDir,{recursive:true});
const t0=1000000;
const h1=healthMod.recordCooldown("test/model","HTTP 429 Too Many Requests",healthDir,t0);
const h2=healthMod.recordCooldown("test/model","HTTP 429 Too Many Requests",healthDir,t0+1);
const h3=healthMod.recordCooldown("test/model","quota exceeded",healthDir,t0+2);
chk(h1.until===t0+healthMod.__test.RATE_LIMIT_TTL_MS,"rate-limit cooldown uses 10-minute base TTL");
chk(h2.until===t0+1+2*healthMod.__test.RATE_LIMIT_TTL_MS,"repeated rate-limit doubles TTL");
chk(h3.until===t0+2+healthMod.__test.QUOTA_TTL_MS,"new quota reason resets base TTL");
chk(healthMod.coolingModels(healthDir,t0+2).has("test/model"),"cooldown persists in shared health file");

const staleHealthDir=pathMod.join(process.env.PI_ROUTER_TEST_DIR,"stale-health-lock");
fs.mkdirSync(staleHealthDir,{recursive:true});
const staleLock=pathMod.join(staleHealthDir,"router-health.json.lock");
fs.writeFileSync(staleLock,"{");
const staleAt=new Date(Date.now()-healthMod.__test.MALFORMED_LOCK_STALE_MS-1000);
fs.utimesSync(staleLock,staleAt,staleAt);
const recovered=healthMod.recordCooldown("test/stale","HTTP 429",staleHealthDir,Date.now());
chk(recovered?.reason==="rate-limit","old malformed health lock is recovered");
chk(!fs.existsSync(staleLock),"recovered malformed health lock is released");

const freshHealthDir=pathMod.join(process.env.PI_ROUTER_TEST_DIR,"fresh-health-lock");
fs.mkdirSync(freshHealthDir,{recursive:true});
const freshLock=pathMod.join(freshHealthDir,"router-health.json.lock");
fs.writeFileSync(freshLock,"{");
chk(healthMod.recordCooldown("test/fresh","HTTP 429",freshHealthDir,Date.now())===undefined,"fresh malformed health lock remains contended");
chk(fs.existsSync(freshLock),"fresh malformed health lock is not removed");
fs.unlinkSync(freshLock);

// no cooldown: classification + model injection
try{fs.unlinkSync(health);}catch{}
let e={toolName:"subagent_routed",input:{task:"fix the typo in the README"}}; tc(e);
chk(e.input.agent==="editor","cheap task -> editor (got "+e.input.agent+")");
chk(e.input.model==="qgenie-openai/gpt-5.6-luna","cheap model -> GPT-5.6 Luna (got "+e.input.model+")");
chk(e.input.routerFallback===false,"healthy primary is not marked fallback");
tc(e,{ui});
chk(status.length===0,"router does not create a separate statusline row; tool renderer owns route label");

e={toolName:"subagent_routed",input:{task:"review this diff for correctness"}}; tc(e);
chk(e.input.agent==="reviewer","review -> reviewer");
chk(e.input.model==="breeze/claude-sonnet-5","mid model -> Claude Sonnet (got "+e.input.model+")");

e={toolName:"subagent_routed",input:{task:"refactor the payment pipeline across modules"}}; tc(e);
chk(e.input.agent==="deep-coder","heavy -> deep-coder");
chk(e.input.model==="breeze/claude-sonnet-5","heavy model -> Claude Sonnet (got "+e.input.model+")");

// Policy: no candidate list carries a 1M-context id, so a big-scope task never
// auto-widens the window — it still draws deep-coder\x27s normal 200k primary. 1M is
// reachable ONLY via an explicit caller-set `model` (asserted separately below).
const cool=Date.now()+600000;
e={toolName:"subagent_routed",input:{task:"rewrite the build system across the whole codebase, touching every module"}}; tc(e);
chk(e.input.agent==="deep-coder","large heavy -> deep-coder");
chk(e.input.model==="breeze/claude-sonnet-5","large heavy never auto-widens to 1M -> Claude Sonnet (got "+e.input.model+")");
chk(!/(-1m\/|:1M)/.test(e.input.model),"large heavy must not pick a 1M ref (got "+e.input.model+")");

// Budget policy: automatic routing never selects Opus implicitly; reviewer fallback may use QGenie Sonnet.
const heavyTask="rewrite every module of the payment pipeline across the repo";
e={toolName:"subagent_routed",input:{task:heavyTask}}; tc(e);
chk(e.input.agent==="deep-coder","heavy keeps deep-coder role (got "+e.input.agent+")");
chk(e.input.model==="breeze/claude-sonnet-5","heavy defaults to Claude Sonnet (got "+e.input.model+")");
fs.writeFileSync(health, JSON.stringify({"breeze/claude-sonnet-5": cool}));
e={toolName:"subagent_routed",input:{task:heavyTask}}; tc(e);
chk(e.input.model==="qgenie/anthropic::claude-5-sonnet","heavy: Sonnet cooling -> QGenie Sonnet (got "+e.input.model+")");
chk(e.input.routerFallback===true && e.input.routerFallbackFromModel==="breeze/claude-sonnet-5","cooldown fallback records requested model");
chk(e.input.routerFallbackReason==="cooldown" && e.input.routerCooldownUntil===cool,"cooldown fallback records reason and expiry");
fs.writeFileSync(health, JSON.stringify({"qgenie/anthropic::claude-5-sonnet": cool, "breeze/claude-sonnet-5": cool}));
e={toolName:"subagent_routed",input:{task:heavyTask}}; tc(e);
chk(e.input.model===undefined,"heavy: all candidates cooling fail closed (got "+e.input.model+")");
chk(typeof e.input.routerBlockedReason==="string" && e.input.routerBlockedReason.startsWith("No healthy model available for deep-coder; candidates:"),"all-cooling dispatch reports blocked reason (got "+e.input.routerBlockedReason+")");
e.input.model="breeze-openai/gpt-5.6-sol"; e.input.forceModel=true; tc(e);
chk(e.input.model==="breeze-openai/gpt-5.6-sol" && !e.input.routerBlockedReason,"rerouting clears a stale blocked decision when forceModel bypasses cooldown");
try{fs.unlinkSync(health);}catch{}

// Agent discovery supports user/project-defined roles. Unknown-to-router agents must
// inherit their own frontmatter/current model rather than fail for lacking a built-in chain.
e={toolName:"subagent_routed",input:{agent:"custom-agent",task:"run the custom workflow"}}; tc(e);
chk(e.input.model===undefined && !e.input.routerBlockedReason,"custom agent without explicit model passes through to executor inheritance");

// Naming several files is still heavy independent of cooldown state.
e={toolName:"subagent_routed",input:{task:"edit parse_args in ccx.sh, common.sh and install.sh to take the new flag"}}; tc(e);
chk(e.input.agent==="deep-coder","3 named files edited -> deep-coder (got "+e.input.agent+")");
chk(e.input.model==="breeze/claude-sonnet-5","3-file edit -> Claude Sonnet (got "+e.input.model+")");

// Review and deep roles default to Sonnet, then use QGenie Sonnet when Sonnet is cooling.
e={toolName:"subagent_routed",input:{task:"review the large log dump for correctness"}}; tc(e);
chk(e.input.agent==="reviewer","large mid -> reviewer");
chk(e.input.model==="breeze/claude-sonnet-5","review defaults to Claude Sonnet (got "+e.input.model+")");
fs.writeFileSync(health, JSON.stringify({"breeze/claude-sonnet-5": cool}));
e={toolName:"subagent_routed",input:{task:"review the large log dump for correctness"}}; tc(e);
chk(e.input.model==="qgenie/anthropic::claude-5-sonnet","review: Sonnet cooling -> QGenie Sonnet (got "+e.input.model+")");
try{fs.unlinkSync(health);}catch{}

e={toolName:"subagent_routed",input:{agent:"planner",task:"plan the rollout"}}; tc(e);
chk(e.input.model===undefined,"planner inherits current model without UI (got "+e.input.model+")");
let plannerSelects=0;
e={toolName:"subagent_routed",input:{agent:"planner",model:"custom/planner",task:"plan the rollout"}};
tc(e,{hasUI:true,model:{provider:"custom",id:"current"},ui:{select:()=>{plannerSelects++; return "breeze/claude-opus-5-5";},confirm:()=>false}});
chk(plannerSelects===0 && e.input.model==="custom/planner","explicit planner model is not replaced by interactive selection");
fs.writeFileSync(health, JSON.stringify({"breeze/claude-sonnet-5": cool}));
e={toolName:"subagent_routed",input:{agent:"planner",task:"plan the rollout"}}; tc(e);
chk(e.input.model===undefined,"planner keeps current model without UI (got "+e.input.model+")");
try{fs.unlinkSync(health);}catch{}

e={toolName:"subagent_routed",input:{agent:"deep-reviewer",task:"audit ccx.sh and common.sh together"}}; tc(e);
chk(e.input.model==="breeze/claude-sonnet-5","deep-reviewer defaults to Claude Sonnet (got "+e.input.model+")");

// Lightweight investigator/editor roles use Luna, then DeepSeek V4 Flash.
e={toolName:"subagent_routed",input:{agent:"investigator",task:"trace how parse_args reaches do_link"}}; tc(e);
chk(e.input.model==="qgenie-openai/gpt-5.6-luna","investigator uses Luna (got "+e.input.model+")");
fs.writeFileSync(health, JSON.stringify({"qgenie-openai/gpt-5.6-luna": cool, "breeze-openai/gpt-5.6-luna": cool}));
e={toolName:"subagent_routed",input:{agent:"investigator",task:"trace how parse_args reaches do_link"}}; tc(e);
chk(e.input.model==="qgenie-deepseek/deepseek-v4-flash","investigator: Luna cooling -> DeepSeek V4 Flash (got "+e.input.model+")");
try{fs.unlinkSync(health);}catch{}

// Explicit Opus needs interactive confirmation. Test/headless context declines and downgrades.
e={toolName:"subagent_routed",input:{agent:"planner",model:"breeze/claude-opus-5-5",task:"plan the rollout"}}; tc(e);
chk(e.input.model==="breeze/claude-sonnet-5","explicit Opus without confirmation downgrades to Sonnet");
chk(e.input.routerFallback===true,"Opus downgrade is marked fallback");
chk(e.input.routerFallbackFromModel==="breeze/claude-opus-5-5","Opus fallback preserves requested model");
e={toolName:"subagent_routed",input:{agent:"planner",model:"breeze/claude-opus-5-5",forceModel:true,task:"plan the rollout"}}; tc(e);
chk(e.input.model==="breeze/claude-opus-5-5" && !e.input.routerFallback,"forceModel preserves explicit Opus without confirmation");
e={toolName:"subagent_routed",input:{agent:"planner",model:"breeze/claude-opus-5-5",routerOpusApproved:true,task:"plan the rollout"}}; tc(e);
chk(e.input.model==="breeze/claude-sonnet-5","caller cannot forge internal Opus approval");
const plannerFallback=mod.routeModelForAgent("planner","breeze/claude-sonnet-5",new Map([["breeze/claude-sonnet-5",{until:cool,reason:"rate-limit",failures:1}]]));
chk(plannerFallback.model==="breeze-openai/gpt-5.6-sol","planner fallback cannot silently re-enter Opus after rejection");
// Explicit non-Luna QGenie models are budgeted back to Luna; DeepSeek remains allowed.
e={toolName:"subagent_routed",input:{agent:"planner",model:"qgenie-gemini/vertexai::gemini-3.8-flash",task:"plan the rollout"}}; tc(e);
chk(e.input.model==="qgenie-openai/gpt-5.6-luna","non-Luna QGenie model downgrades to Luna");
chk(e.input.routerFallback===true,"QGenie budget downgrade is marked fallback");
fs.writeFileSync(health, JSON.stringify({"qgenie-openai/gpt-5.6-luna": cool}));
e={toolName:"subagent_routed",input:{agent:"planner",model:"qgenie-gemini/vertexai::gemini-3.8-flash",task:"plan the rollout"}}; tc(e);
chk(e.input.model==="breeze-openai/gpt-5.6-sol","budgeted planner model cooling skips unapproved Opus");
chk(e.input.routerFallbackFromModel==="qgenie-gemini/vertexai::gemini-3.8-flash" && e.input.routerFallbackReason==="budget+cooldown","multi-stage fallback preserves the caller-requested model and reason");
try{fs.unlinkSync(health);}catch{}
e={toolName:"subagent_routed",input:{agent:"investigator",model:"qgenie-deepseek/deepseek-v4-flash",task:"trace the config"}}; tc(e);
chk(e.input.model==="qgenie-deepseek/deepseek-v4-flash","DeepSeek fallback remains allowed");

// respect explicit agent + explicit model
e={toolName:"subagent_routed",input:{agent:"reviewer",task:"fix a typo",model:"custom/x"}}; tc(e);
chk(e.input.agent==="reviewer" && e.input.model==="custom/x","explicit agent+model kept");

// Decision calculation is pure; application is the only step that mutates the tool input.
const pureInput={task:"fix the typo in the README"};
const pureBefore=JSON.stringify(pureInput);
const pureDecision=mod.decideRoute(pureInput,new Map());
chk(JSON.stringify(pureInput)===pureBefore,"route decision does not mutate caller input");
chk(pureDecision.agent==="editor" && pureDecision.model==="qgenie-openai/gpt-5.6-luna","pure route decision contains the automatic agent and model");
chk(pureDecision.routeEvidence?.rule==="cheap-trivial" && pureDecision.routeEvidence?.certainty==="high","route evidence explains the selected cheap rule");
chk(!JSON.stringify(pureDecision.routeEvidence).includes("fix the typo"),"route evidence does not retain task text");
const graftedInput={task:"fix the typo in the README\n\n<graft-context>\nreview every module across the repository\n</graft-context>"};
const graftedDecision=mod.decideRoute(graftedInput,new Map());
chk(graftedDecision.agent===pureDecision.agent && graftedDecision.routeEvidence?.rule===pureDecision.routeEvidence?.rule,"injected Graft context cannot change classification");
const graftedApplied={...graftedInput};
mod.applyRouteDecision(graftedApplied,graftedDecision);
chk(graftedApplied.task.includes("<graft-context>"),"applying the route preserves Graft context for the child");
const applied={...pureInput};
mod.applyRouteDecision(applied,pureDecision);
chk(applied.agent==="editor" && applied.model==="qgenie-openai/gpt-5.6-luna","applying route decision mutates input with effective route");
chk(typeof applied.task==="string" && applied.task.includes("Return contract (injected by subagent-model-router)"),"applying automatic route adds return contract");
const explicit={agent:"reviewer",task:"fix a typo",model:"custom/x"};
const explicitDecision=mod.decideRoute(explicit,new Map());
mod.applyRouteDecision(explicit,explicitDecision);
chk(explicit.agent==="reviewer" && explicit.model==="custom/x","apply preserves explicit agent and model");
const prototypeAgent={agent:"constructor",task:"run the custom workflow"};
const prototypeDecision=mod.decideRoute(prototypeAgent,new Map());
chk(prototypeDecision.agent==="constructor" && prototypeDecision.model===undefined && !prototypeDecision.blockedReason,"prototype-named explicit agent remains custom passthrough");
chk(["editor","investigator","coder","reviewer","deep-coder","deep-reviewer","planner"].includes(pureDecision.agent),"automatic route resolves to a built-in agent");
const vague={task:"handle this"};
const vagueDecision=mod.decideRoute(vague,new Map());
chk(vagueDecision.agent==="investigator" && vagueDecision.routeEvidence?.certainty==="low","signal-poor automatic task falls back to read-only investigator");
chk(vagueDecision.routeEvidence?.effectiveAgent==="investigator" && vagueDecision.routeEvidence?.fallbackReason==="low-certainty","safe fallback records effective agent and reason");
const mutating={task:"change this"};
const mutatingDecision=mod.decideRoute(mutating,new Map());
chk(mutatingDecision.agent==="coder" && mutatingDecision.routeEvidence?.signals.mutate===true,"mutating ambiguous task keeps write-capable coder");
const explicitSafe={agent:"reviewer",task:"handle this"};
const explicitSafeDecision=mod.decideRoute(explicitSafe,new Map());
chk(explicitSafeDecision.agent==="reviewer" && !explicitSafeDecision.routeEvidence,"explicit agent bypasses automatic safe fallback");
// Context-seeded delegates use the same automatic route lists. Explicit routes remain pinned.
e={toolName:"bg_delegate",input:{name:"Trace callers",prompt:"trace how parse_args reaches do_link"}}; tc(e);
chk(e.input.route?.provider==="qgenie-openai" && e.input.route?.model==="gpt-5.6-luna","bg_delegate investigation uses the cheap automatic route");
e={toolName:"bg_delegate",input:{name:"Review change",prompt:"review this diff for correctness"}}; tc(e);
chk(e.input.route?.provider==="breeze" && e.input.route?.model==="claude-sonnet-5","bg_delegate review uses the reviewer route");
e={toolName:"bg_delegate",input:{name:"Plan approach",prompt:"design an approach across the whole codebase"}}; tc(e,{model:{provider:"qgenie-openai",id:"gpt-5.6-luna"}});
chk(e.input.route?.provider==="qgenie-openai" && e.input.route?.model==="gpt-5.6-luna","bg_delegate planner inherits the current model");
e={toolName:"bg_delegate",input:{name:"Pinned task",prompt:"trace this",route:{provider:"custom",model:"model"}}}; tc(e);
chk(e.input.route.provider==="custom" && e.input.route.model==="model","bg_delegate explicit route remains pinned");

// non-subagent untouched
e={toolName:"bash",input:{command:"ls"}}; tc(e);
chk(JSON.stringify(e.input)==="{\"command\":\"ls\"}","non-subagent untouched");

// ACP owns its own fixed-role/model policy. The router must not mutate ACP
// calls by default; otherwise a child can be forced onto an unavailable provider.
delete process.env.PI_ROUTE_ACP_DELEGATE;
e={toolName:"acp_delegate",input:{agent:"reviewer",task:"review this change"}}; tc(e);
chk(JSON.stringify(e.input)==="{\"agent\":\"reviewer\",\"task\":\"review this change\"}","acp_delegate is isolated from router by default");
e={toolName:"acp_delegate",input:{agent:"planner",model:"custom/model",task:"plan this"}}; tc(e);
chk(e.input.model==="custom/model","explicit ACP model is preserved");
process.env.PI_ROUTE_ACP_DELEGATE="1";
e={toolName:"acp_delegate",input:{agent:"planner",task:"plan this"}}; tc(e);
chk(e.input.model==="breeze/claude-sonnet-5" && e.input.routerFallbackFromModel==="breeze/claude-opus-5-5","opt-in ACP auto-selected Opus still requires confirmation");
delete process.env.PI_ROUTE_ACP_DELEGATE;

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
const CHEAP_MODELS=new Set(["qgenie-openai/gpt-5.6-luna","qgenie-deepseek/deepseek-v4-flash"]);
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
// `deep-coder` + Sonnet.
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

// Explicit pipeline steps get the handoff contract even when the caller selected
// their agents. The phase is metadata only; model and agent choices remain intact.
const chain={toolName:"subagent_routed",input:{chain:[
  {agent:"investigator",phase:"scout",task:"trace retry callers"},
  {agent:"planner",phase:"reason",task:"design a fix from this evidence: {previous}"},
  {agent:"coder",phase:"execute",task:"implement this plan: {previous}"}
]}}; tc(chain);
for(const step of chain.input.chain) chk(/Handoff contract \(injected by subagent-model-router\)/.test(step.task),"pipeline step receives handoff contract");
chk(chain.input.chain[1].task.includes("{previous}"),"pipeline placeholder is preserved for execution time");
chk(chain.input.chain[0].model==="qgenie-openai/gpt-5.6-luna","scout keeps cheap model");
chk(chain.input.chain[1].model===undefined,"reason inherits current model without UI");
chk(chain.input.chain[2].model==="qgenie-openai/gpt-5.6-luna","execute keeps cheap model");

// Packet parsing is strict enough to reject incomplete handoffs and bounded enough
// to prevent a giant previous result from expanding the next prompt.
const packetText="```task-packet\n"+JSON.stringify({version:1,goal:"fix retry",scope:["src/retry.ts"],constraints:[],evidence:[],decision:{summary:"use policy",rationale:"separate errors"},steps:[{id:"1",action:"edit retry policy",files:["src/retry.ts:42"]}],tests:["npm test"],risks:[],unknowns:[],coverage:"checked retry.ts; not integration tests"})+"\n```";
const parsed=packets.parseTaskPacket(packetText);
chk(!!parsed,"valid task packet parses");
const prepared=packets.prepareHandoff(packetText,300);
chk(prepared.packetValid && prepared.text.length<=300,"packet handoff is bounded");
chk(!packets.parseTaskPacket("```task-packet{}\n```") ,"incomplete packet rejects");
const unknownVersion="```task-packet\n"+JSON.stringify({version:999,goal:"future",scope:[],constraints:[],evidence:[],steps:[{id:"1",action:"do it",files:[]}],tests:[],risks:[],unknowns:[],coverage:"checked"})+"\n```";
chk(!packets.parseTaskPacket(unknownVersion),"unknown packet version rejects");
const unknownVersionHandoff=packets.prepareHandoff(unknownVersion,300);
chk(!unknownVersionHandoff.packetValid && unknownVersionHandoff.text.includes("\"version\":999"),"unknown packet version falls back to bounded raw");
const safe=packets.normalizeTaskPacket({version:1,goal:"fallback",scope:[],constraints:[],evidence:[],steps:[],tests:[],risks:[],unknowns:[],coverage:"checked"},200);
chk(!!packets.parseTaskPacket("```task-packet\n"+safe+"\n```"),"empty steps normalize safely");
const raw=packets.prepareHandoff("x".repeat(1000),300);
const metric={schema:1,runId:"test-run",at:Date.now(),pid:1,mode:"chain",phase:"reason",step:2,agent:"planner",routeEvidence:pureDecision.routeEvidence,requestedModel:"breeze/claude-opus-4-8",actualModel:"breeze/claude-opus-4-8",fallback:true,latencyMs:123,inputTokens:10,outputTokens:20,cacheReadTokens:30,cacheWriteTokens:40,cost:0.5,turns:2,exitCode:0,verificationStatus:"pass",failed:false,retryAttempt:0};
metrics.appendPipelineMetric(metric);
const summary=metrics.summarizePipelineMetrics(metrics.readPipelineMetrics({days:1,limit:10}));
chk(summary.records===1 && summary.runs===1,"metrics query reads JSONL record and run id");
chk(summary.fallbackAttempts===1 && summary.totalCost===0.5,"metrics summary aggregates fallback and cost");
chk(summary.totalCacheReadTokens===30 && summary.totalCacheWriteTokens===40,"metrics summary aggregates cache tokens");
chk(summary.byRouteRule["cheap-trivial"]===1 && summary.byRouteCertainty.high===1,"metrics summary aggregates route evidence");
metrics.appendPipelineMetric({...metric,at:Date.now()-3*24*60*60*1000});
chk(metrics.prunePipelineMetrics({retentionDays:1})===1,"metrics prune removes expired records");
chk(metrics.readPipelineMetrics({days:1,limit:10}).length===1,"metrics prune preserves current records");
chk(!raw.packetValid && raw.text.length<=300,"malformed handoff falls back bounded raw");

// Graft enrichment must cover each delegation surface, including Breeze-backed
// bg_delegate and ACP children. A stub keeps this integration test offline and
// proves routing happens before the graph answer is appended.
const graftCwd=fs.mkdtempSync(pathMod.join(require("node:os").tmpdir(),"pi-router-graft-"));
const graftBin=pathMod.join(graftCwd,"graft");
fs.mkdirSync(pathMod.join(graftCwd,".pi","skills","graft"),{recursive:true});
fs.writeFileSync(pathMod.join(graftCwd,".pi","skills","graft","SKILL.md"),"skill\n");
fs.writeFileSync(graftBin,`#!/bin/sh
printf "rewrite every module across the whole codebase\\n"
`);
fs.chmodSync(graftBin,0o755);
const oldPath=process.env.PATH;
process.env.PATH=graftCwd+":"+oldPath;
const graftCtx={cwd:graftCwd};
const bg={toolName:"bg_delegate",input:{prompt:"review this code for correctness"}};
await tc(bg,graftCtx);
chk(bg.input.route?.provider==="breeze" && bg.input.route?.model==="claude-sonnet-5","bg_delegate keeps the Breeze review route before Graft enrichment");
chk((bg.input.prompt.match(/<graft-context>/g)||[]).length===1,"bg_delegate receives one Graft context block");
const acp={toolName:"acp_delegate",input:{agent:"reviewer",task:"review this code for correctness"}};
await tc(acp,graftCtx);
chk((acp.input.task.match(/<graft-context>/g)||[]).length===1,"acp_delegate receives one Graft context block");
const routed={toolName:"subagent_routed",input:{task:"review this code for correctness"}};
await tc(routed,graftCtx);
chk(routed.input.agent==="reviewer","subagent_routed classifies before Graft enrichment");
chk(routed.input.model==="breeze/claude-sonnet-5","subagent_routed keeps the Breeze model route before Graft enrichment");
chk((routed.input.task.match(/<graft-context>/g)||[]).length===1,"subagent_routed receives one Graft context block");
const duplicate={toolName:"subagent_routed",input:{task:routed.input.task}};
await tc(duplicate,graftCtx);
chk((duplicate.input.task.match(/<graft-context>/g)||[]).length===1,"re-dispatch does not duplicate Graft context");
process.env.PATH=oldPath;
fs.rmSync(graftCwd,{recursive:true,force:true});

// tool_result finalization must re-apply the routed dispatch\x27s final cost/tokens
// before finalizeGroup flips the row to done/error, or the row is stuck at
// "cost n/a" even though the child process reported real usage.
if(!tr){ console.error("no tool_result handler"); process.exit(1); }
const hasUiCtx={hasUI:true,ui:{setStatus:()=>{},setWidget:()=>{}}};
taskDock.upsertTask(hasUiCtx,"sub:tr-test:0",{source:"subagent",label:"editor",state:"running",startedAt:Date.now()});
tr({toolName:"subagent_routed",toolCallId:"tr-test",isError:false,details:{results:[{usage:{input:120,output:340,cost:0.0123}}]}},hasUiCtx);
const finalized=taskDock.__test.peekTask("sub:tr-test:0");
chk(!!finalized && finalized.state==="done","tool_result finalizes the row to done");
chk(!!finalized && finalized.cost===0.0123,"tool_result re-applies final cost instead of leaving it n/a (got "+(finalized&&finalized.cost)+")");
chk(!!finalized && finalized.tokens && finalized.tokens.input===120 && finalized.tokens.output===340,"tool_result re-applies final tokens");

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
})().catch((error)=>{ console.error(error); process.exit(1); });
' "$jiti" "$router" "$tmp/shim.cjs" "$agents_dir" "$pitui" "$packet" "$here/../extensions/subagent/pipeline-metrics.ts" "$here/../extensions/subagent/router-health.ts" "$here/../extensions/task-dock.ts"
