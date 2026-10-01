/**
 * subagent-model-router — pi port of claude/subagent-model-router.py, plus
 * availability-aware, weighted model routing across QGenie + Breeze.
 *
 * Three jobs, all on the `tool_call` hook (pi's PreToolUse analog, mutate
 * event.input in place; fail-open):
 *
 *  1. TIER CLASSIFICATION — when a `subagent_routed` call names no agent, classify the
 *     task text and inject a tier AGENT (role: system prompt + tools). (The tool is named
 *     `subagent_routed`, not `subagent`, to coexist with nicobailon's pi-subagents package,
 *     whose own generic `subagent` tool is left unrouted.) Classification is by SCOPE —
 *     breadth, named targets, mutation, whether the output is mechanically checkable —
 *     not by phrase match; see the signal block below.
 *  2. AVAILABILITY ROUTING — pick the MODEL for that AGENT from its own ranked
 *     candidate list (capability floor + price ascending, from aicp), skipping any
 *     model in cooldown, and inject it as `input.model` (the vendored subagent tool
 *     honors a per-invocation `model` over the agent's frontmatter). Candidates span
 *     both gateways / upstreams (azure/vertex/anthropic/bedrock) so a quota-throttled
 *     upstream falls through to a healthy one. No candidate list names a 1M-context
 *     model: this router never widens the window on its own. A 1M model is used ONLY
 *     when a caller sets `model` explicitly; explicit models still participate in
 *     cooldown routing unless `forceModel` is true.
 *  3. RETURN CONTRACT — append the anchors/coverage/confidence/length constraints to a
 *     dispatch this router assigned, so its conclusion is checkable instead of being
 *     re-derived by the parent. Skipped when the caller already demanded a shape.
 *
 * Cooldown is REACTIVE: the subagent tool writes a model into
 * <agentDir>/router-health.json when it hits a quota/429/rate-limit error; this
 * router reads that file and avoids cooling-down models. The failing dispatch
 * returns an error to the main model, whose natural retry then re-routes here
 * around the cooled-down model.
 *
 * Explicit caller-set agents are always respected. Explicit models are budgeted and
 * rerouted around cooldown unless `forceModel` is true. Ranking weights are from
 * aicp.qualcomm.com/models (intelligence index II + price multiplier vs Sonnet-5);
 * the cheap tier uses QGenie OpenAI GPT-5.6 Luna as its primary model.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hasPiSkill, retrieveGraftContext, shouldRetrieveSubagent } from "./graft.ts";
import { contextBudgetForModel, type ContextBudget } from "./context-budget.ts";
import { HANDOFF_CONTRACT } from "./subagent/packet.ts";
import { activeTakeoverForCwd, isTaskPathAllowed } from "./subagent/task-state.ts";
import { finalizeGroup, upsertTask } from "./task-dock.ts";
import {
	cooldownText,
	coolingModels,
	type CooldownEntry,
	type CooldownMap,
} from "./subagent/router-health.ts";

export interface RoutedCallItem {
	agent: string;
	model?: string;
	contextBudget?: ContextBudget;
	routerFallbackFromModel?: string;
	routeEvidence?: RouteEvidence;
	task: string;
}

const routedCalls = new Map<string, RoutedCallItem[]>();

/** Route metadata used by subagent_routed's call renderer before execution starts. */
export function getRoutedCallItems(toolCallId: string): RoutedCallItem[] | undefined {
	return routedCalls.get(toolCallId);
}

// ---- tier classification (mirror of the claude classifier) ----------------
// Signals, not phrase matches. The keyword ladder this replaces misfired in both
// directions for one reason: a word is not an operation. `dependenc`/`complex` priced
// a one-file lookup as architecture work, while `words <= 40` alone demoted ANY short
// brief to the cheap tier — so "why does quota_read return None" (6 words, pure
// judgment) drew a Luna model. See claude/subagent-model-router.py for the full
// rationale and the measurement behind each bound.
//
// This file and claude/subagent-model-router.py must stay in step: same regexes, same
// thresholds, same rung order. An unexplained difference is a bug in one of them. The
// four deliberate divergences all come from ONE asymmetry — the Claude hook injects a
// model ALIAS, which sets only a price, while this router injects an AGENT NAME, which
// also sets the TOOLSET, so handing a write-needing dispatch a read-only agent is a
// functional failure here and a rounding error there. They are marked "pi-only
// divergence" at rungs 2, 4 and 5 below, and listed together under "WHERE THIS ROUTER
// AND pi's DELIBERATELY DIVERGE" in the Python file. The fourth: this router computes
// no `contract` / `raw_words` / `*_hits` signal, because it has no decision log to
// calibrate from and nothing else reads them.
const BREADTH =
	/\b(all|every|each|across|entire|whole|throughout|everywhere|exhaustive|complete(ly)?|both|repo[- ]?wide|codebase)\b/i;
// `each` is breadth, but "for each" is NOT: "for each finding give a severity" states
// how the ANSWER is shaped, one row per item, and says nothing about how much code is
// in scope. It is stripped by CONTRACT_PHRASE before this runs, so this regex is left
// alone; "for each OF the modules" is exempted from that strip, since there the phrase
// really does enumerate a set. Same bug class as `contract` in DEPTH: a shape demand
// read as scope, always in the expensive direction.
const DEPTH =
	/\b(why|how|explain|root[- ]?cause|rationale|trace|invariant|because|reason\s+about|implication)\b/i;
const MUTATE =
	/\b(edit|write|add|remove|delete|change|implement|fix|patch|refactor|rename|migrat\w+|port|rewrite)\b/i;
// ...and the briefs that say the opposite. A read-only brief spends most of its words
// on mutation verbs precisely BECAUSE it is forbidding them, so matching MUTATE
// without reading the negation inverts the signal on exactly the dispatches that were
// clearest about their scope. Measured on five real dispatches that each said "Do not
// edit any host file and do not fix anything — report only": all five were classified
// `mutate: true`, met `mutate && targets >= 3`, and priced a read-only investigation
// at the refactor tier. On pi the consequence is worse than a price: `mutate` is what
// steers a dispatch onto `coder`/`deep-coder`, which carry edit+write, so a brief
// that forbids editing was being handed the tools to edit.
//
// HOW the negation is read matters, and a global veto was the wrong mechanism — it
// failed in the other direction on briefs that merely fence off a thing they must not
// break. `there is no need to change the API, just add the flag to ccx.sh, ccx.ps1 and
// install.sh` and `the credential path must never change; add do_link support to
// install.sh, ccx.sh and common.sh` both read as read-only, and rung 5 then handed a
// THREE-FILE EDIT to `investigator` (then `reviewer`), which has no edit tool. So signals() CUTS the
// read-only clauses out and looks for a mutation verb in what is left: a brief that
// only forbids keeps nothing to match, a brief that forbids one thing and asks for
// another keeps the ask. Branch-by-branch reasoning (bare `no` is not a negator; one
// stemmed verb list for every branch; the "I apply" branch swallows its object) lives
// in the Python READ_ONLY comment.
const RO_VERB = String.raw`(?:edit\w*|writ\w+|modif\w+|chang\w+|alter\w*|fix\w*|patch\w*|touch\w*|mutat\w+|creat\w+|delet\w+|remov\w+|rewrit\w+|refactor\w*|appl\w+)`;
const RO_NEG = String.raw`(?:do\s*n[o']?t|does\s+not|did\s+not|must\s+not|should\s+not|shall\s+not|will\s+not|won'?t|cannot|can\s*not|may\s+not|never|avoid|refrain\s+from|without)`;
const RO_SRC =
	String.raw`\b${RO_NEG}\s+(?:\w+\s+){0,2}${RO_VERB}\b` +
	String.raw`|\bno\s+(?:more\s+|further\s+|new\s+)?${RO_VERB}\b` +
	String.raw`|\bnothing\s+(?:\w+\s+){0,3}${RO_VERB}\b` +
	String.raw`|\b(?:report|observation|analysis|investigation|inspection|audit|review|diagnos\w+|read)\s+(?:\w+\s+){0,2}only\b` +
	String.raw`|\bread[-\s]?only\b|\bnon[-\s]?(?:destructive|mutating|invasive|modifying)\b` +
	String.raw`|\bhands\s+off\b|\bleave\s+(?:\w+\s+){0,3}alone\b` +
	String.raw`|\bI(?:\s+will|\s+shall|'ll)?\s+apply\b(?:\s+(?:the|any|all)\b)?(?:\s+${RO_VERB})?`;
const READ_ONLY = new RegExp(RO_SRC, "i");
// Global twin of the same source, used ONLY with .replace() to cut the forbidding
// clauses out. Never call .test() on this one: a global regex carries lastIndex.
const READ_ONLY_ALL = new RegExp(RO_SRC, "gi");

// The output is checkable WITHOUT judgment — this is what makes a cheap tier safe.
const VERIFIABLE =
	/\b(grep|locate|list|enumerate|count|inventory|dedupe|collate|tally|glob|find|search|look\s+up|where|which|what\s+calls|file\s+names?)\b/i;
// Mechanical edit vocabulary: bounded no matter how many files it spans. Keeps a
// broad-but-mechanical sweep out of the heavy tier; never earns a demotion alone.
const TRIVIAL =
	/\b(typo|whitespace|re-?indent|reformat|formatting|comment|one[- ]?line|single[- ]?line|small\s+(edit|fix|change|tweak)|tweak|bump|lint)\b/i;
const REVIEW = /\b(review|audit|critique|code[- ]?review|correctness|vulnerab\w+)\b/i;
const ARCH =
	/\b(architect\w*|re-?architect|redesign|design\s+(a|an|the)\s|root[- ]?cause|migration\s+(plan|strategy)|trade[- ]?offs?|race\s+condition|deadlock|concurren\w+)\b/i;
// An explicitly stated planning / investigation / information-gathering ask. This one
// has NO analog in the Claude router, and the divergence is deliberate: there, an
// alias only picks a price tier, whereas here the agent name also picks the TOOLSET,
// so a "plan/investigate/trace X" dispatch must land on a read-only role rather than
// on `coder`, which carries edit+write. WHICH read-only role is a tier question,
// answered at rung 4: `investigator` (read/grep/find/bash, cheap) for a bounded ask,
// `planner` (heavy) only when it is at scale. Sending every one of these to `planner`
// was paying opus rates purely to withhold the edit tool — the exact trade rung 5
// rejects; sending every bounded one to `reviewer` (mid) was paying sonnet rates for
// the same reason once `investigator` existed to do it cheaper. Two vocabularies feed
// this rung: planning/strategy words (plan, approach, scope out) and pure fact-finding
// words (trace, call stack, gather, collect) — both land on the same read-only agent,
// because on pi WHICH read-only agent is priced by SCOPE (bounded vs at-scale), not by
// whether the ask wants a decision or just the facts; a wrong recommendation and a
// wrong trace are both re-derived by the caller either way.
const INVESTIGATE =
	/\b(plan|strateg\w*|approach|investigat\w*|explore|research|how\s+should|figure\s+out|scope\s+out|trace\w*|call[-\s]?stack|call[-\s]?graph|call\s+chain|data[-\s]?flow|walk\s+(?:me\s+)?through|map\s+out|gather|collect)\b/i;
// Concrete things named in the brief, in two counts that answer two questions.
// FILE_TARGET is a FILE (known source extension, or an absolute path): `files >= 3` is
// what "changing several named files" means in the escalation rung, and counting
// identifiers there priced every single-file edit that mentioned two helpers as a
// cross-file refactor — `rename render_backend to render_target in install.sh` named
// three targets, edited ONE file, and drew `deep-coder` + opus. TARGET adds snake_case
// and ALL_CAPS identifiers, because for the CHEAP rung an identifier is another thing
// to go find. Both counted UNIQUE — repetition is not scope. Composed from shared
// fragments so the two counts cannot drift apart; both are global and both are used
// only with matchAll(), never .test().
const T_FILE = String.raw`\b[\w./-]+\.(?:py|sh|ps1|ts|tsx|js|jsx|c|h|cc|cpp|hpp|rs|go|java|md|json|ya?ml|toml|template|txt|log|csv)\b|(?<![\w.])/(?:[\w.-]+/)+[\w.-]+`;
const T_IDENT = String.raw`\b[a-z_][a-z0-9_]*_[a-z0-9_]+\b|\b[A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+)+\b`;
const FILE_TARGET = new RegExp(T_FILE, "g");
const TARGET = new RegExp(`${T_FILE}|${T_IDENT}`, "g");

const CHEAP_WORDS = 25; // the cheap tier only for genuinely small dispatches
const ARCH_WORDS = 25; // ...and "architecture" only when the brief is substantial

// Lines stating how the ANSWER must be shaped, not what the work is. Stripped before
// any signal is computed, because classifying on them is a self-inflicted loop: this
// extension appends a return contract demanding `path:line` anchors, a coverage line
// and confirmed/inferred/unverified marks, the agent bodies restate it, the main
// thread then writes dispatches in the same vocabulary — and the classifier read
// those demands back as evidence about the work. Measured in the Claude router's
// decision log: `depth && breadth` was true on 8 of 8 dispatches over 150 words and 0
// of 12 under 50, i.e. it had stopped measuring scope and started measuring verbosity.
// The demand PHRASE is cut, and the whole line goes only when the phrase WAS the
// line's substance. Dropping whole lines unconditionally broke the canonical cheap
// dispatch — `find every caller of parse_args and report file:line` states its task
// on the same line as its demand, so line-stripping deleted the task and a mechanical
// sweep drew a mid-tier agent. Caught by the suite in both routers.
// No `.test()` on this regex: it is global, so `test()` would carry `lastIndex` state.
// A match is detected by comparing the replaced string, which resets that index.
// `for each` is in here as a shape demand — see BREADTH for why, and note the
// `(?!\s+of\b)` guard that keeps "for each of the modules" reading as a set.
const CONTRACT_PHRASE =
	/\b(?:confirmed\s*\/\s*inferred(?:\s*\/\s*unverified)?|inferred\s*\/\s*unverified|(?:did|do)\s+not\s+check|not\s+checked|(?:report|anchor\w*|cite|give|with)?\s*\b(?:path|file)\s*:\s*line|final\s+line|shortest\s+decisive\s+line|mark\s+(?:each|every)\s+conclusion|for\s+each(?!\s+of\b)|(?:return|output)\s+contract)\b/gi;

// The block THIS extension appends (see RETURN_CONTRACT). Everything from the marker
// on is our own output, so it is cut before any signal is computed. Injection was
// already idempotent — HAS_CONTRACT sees the block and skips — but CLASSIFICATION was
// not: the contract's own ANCHORS line says "**Every** factual claim …", a BREADTH hit,
// so re-dispatching a brief that already carried the block escalated it (`review the
// quota helper in cache.py` went `reviewer` on the first pass and `deep-reviewer` on
// the second). The marker was already used to size the task for the status bar; it now
// gates every read of the text, because half-applying it left this file inconsistent
// with itself.
const INJECTED_MARKER = "\n\n--- Return contract (injected";
const GRAFT_CONTEXT_MARKER = "\n\n<graft-context>";

/** Remove router-owned and Graft-owned sections before reading task signals. */
function stripInjected(text: string): string {
	if (typeof text !== "string") return text;
	return text.split(INJECTED_MARKER)[0].split(GRAFT_CONTEXT_MARKER)[0];
}

// A line left with only bullet punctuation once the phrase is gone was pure
// boilerplate; keeping its debris leaves breadth/depth tokens behind.
const CONTRACT_RESIDUE_WORDS = 4;

/** The part of the brief that describes the WORK, with return-format demands removed.
 *  Over-stripping is the safe direction: it loses signal and lands on the DEFAULT
 *  mid tier, never on the cheap one, which needs `verifiable` to survive the strip.
 *
 *  STRIPPING NEVER EMPTIES THE TEXT. The residue rule drops a line whose task
 *  statement is <= CONTRACT_RESIDUE_WORDS real words, and a terse cheap dispatch is
 *  exactly that shape: `list the callers - give path:line`, `grep for TODO; report
 *  path:line`, `where is main defined? path:line`, `find get_user (path:line please)`
 *  each stripped to the EMPTY STRING, lost `verifiable`, and fell off the cheap rung.
 *  So when dropping would leave nothing at all, the phrase-stripped lines are kept
 *  instead — the demand still goes, the task survives. */
function taskText(text: string): string {
	const lines = stripInjected(text || "").split("\n");
	const kept: string[] = [];
	const soft: string[] = [];
	for (const line of lines) {
		const rest = line.replace(CONTRACT_PHRASE, " ");
		if (rest === line) {
			kept.push(line);
			soft.push(line);
			continue;
		}
		soft.push(rest); // the same line with only the demand removed
		const words = rest.replace(/[-*\d.)(:;,\s]+/g, " ").trim();
		if (words !== "" && words.split(/\s+/).length > CONTRACT_RESIDUE_WORDS) kept.push(rest);
	}
	const out = kept.join("\n");
	return out.trim() === "" ? soft.join("\n") : out;
}

export interface RouteSignals {
	words: number;
	breadth: boolean;
	depth: boolean;
	mutate: boolean;
	readOnly: boolean;
	verifiable: boolean;
	trivial: boolean;
	review: boolean;
	arch: boolean;
	targets: number;
	files: number;
}

export type RouteCertainty = "high" | "medium" | "low";

export interface RouteEvidence {
	agent: string;
	effectiveAgent?: string;
	fallbackReason?: "low-certainty";
	rule:
		| "review"
		| "cheap-verifiable"
		| "cheap-trivial"
		| "heavy"
		| "investigate"
		| "read-only"
		| "default";
	certainty: RouteCertainty;
	signals: RouteSignals;
}

function signals(text: string): RouteSignals {
	const t = taskText(text || "");
	const uniq = new Set<string>();
	for (const m of t.matchAll(TARGET)) uniq.add(m[0]);
	const files = new Set<string>();
	for (const m of t.matchAll(FILE_TARGET)) files.add(m[0]);
	// `mutate` reads the text with the read-only CLAUSES cut out rather than vetoing on
	// their presence, so a brief that forbids one thing and asks for another keeps the
	// ask — and keeps its write-capable agent. See READ_ONLY.
	const unforbidden = t.replace(READ_ONLY_ALL, " ");
	return {
		words: t.split(/\s+/).filter(Boolean).length,
		breadth: BREADTH.test(t),
		depth: DEPTH.test(t),
		mutate: MUTATE.test(unforbidden),
		readOnly: READ_ONLY.test(t),
		verifiable: VERIFIABLE.test(t),
		trivial: TRIVIAL.test(t),
		review: REVIEW.test(t),
		arch: ARCH.test(t),
		targets: uniq.size,
		files: files.size,
	};
}

function classify(text: string): string {
	const t = (text || "").trim();
	const s = signals(t);

	// 1) Review is never cheap; unbounded or multi-FILE review is a cross-file
	//    coherence question. First, so no later rule can talk a review down.
	if (s.review) return s.breadth || s.files >= 3 ? "deep-reviewer" : "reviewer";

	// 2) Cheap, two ways in. Retrieval whose output is mechanically checkable, and a
	//    bounded mechanical edit. `targets <= 1` bounds the retrieval (each named
	//    identifier is another lookup to get right), `files <= 2` bounds the edit —
	//    `editor`'s own frontmatter refuses 3+ FILE scope, so that bound comes from the
	//    agent rather than from the phrasing.
	//
	//    pi-only divergence (2 of 4): the Claude hook has no trivial->cheap path at all.
	//    Its analog is CHEAP_AGENTS, which keys on the agent the CALLER already chose,
	//    because that hook cannot swap the agent — only price it. A trivial edit sent to
	//    `general-purpose` would get haiku with no declared scope bound to protect it,
	//    which is the expensive failure mode it measured (haiku-dominant tasks cost 47%
	//    MORE than sonnet-dominant ones once they had to be redone). Here the cheap tier
	//    IS an agent that refuses to let the job grow, so the same trade comes out the
	//    other way: `fix the typo in parse_args` -> `editor` here, sonnet there.
	if (s.verifiable && !s.depth && !s.mutate && s.targets <= 1 && s.words <= CHEAP_WORDS)
		return "editor";
	if (s.trivial && !s.breadth && s.files <= 2 && s.words <= CHEAP_WORDS) return "editor";

	// 3) Heavy for judgment at scale: unbounded explanation, several named FILES
	//    changed, an unbounded non-mechanical change, or stated architecture work that
	//    is either unbounded or briefed at length. Mutating heavy work goes to
	//    deep-coder, read-only heavy work to planner.
	//
	//    `files >= 3`, not `targets >= 3`: "several named files" has to mean files, and
	//    counting identifiers sent single-file edits to opus — `rename render_backend to
	//    render_target in install.sh`, `fix parse_args in ccx.sh so MAX_RETRIES is
	//    honored`, `edit install.sh so the symlink step uses do_link instead of
	//    copy_file` all drew `deep-coder`; they are `coder` work.
	if (
		(s.depth && s.breadth) ||
		(s.mutate && s.files >= 3) ||
		(s.mutate && s.breadth && !s.trivial) ||
		(s.arch && (s.breadth || s.words >= ARCH_WORDS))
	) {
		return s.mutate ? "deep-coder" : "planner";
	}

	// 4) An explicit planning/investigation/gathering ask keeps a READ-ONLY role even
	//    when small (see INVESTIGATE), but it does not automatically buy the heavy tier.
	//    `planner` is opus; `investigator` is the same kind of read-only role at cheap
	//    (read/grep/find/bash, no edit/write) — so a bounded ask goes to `investigator`,
	//    and only one at scale (unbounded, several named files, or a substantial brief)
	//    is worth `planner`. Rung 5 states the same trade in the same direction; when
	//    this rung sent every `explore the retry helper` / `figure out the flag name` /
	//    `trace how X reaches Y` to `planner`, the two rungs answered one question two
	//    ways, and this one was paying opus rates purely to withhold the edit tool.
	//    `reviewer` stays reserved for a CORRECTNESS judgment (rung 1 already caught
	//    those); a bounded ask that only wants facts or a plan, no verdict, is exactly
	//    the budget `investigator` exists to save.
	//
	//    Read from taskText for the same reason every other signal is: a "Final line:"
	//    style formatting demand is not a planning ask.
	//
	//    pi-only divergence (3 of 4): the Claude hook has no INVESTIGATE signal, because
	//    there "plan X" and "implement X" cost the same to price wrong — there is no
	//    toolset to withhold, and no cheap read-only role to send it to either.
	if (INVESTIGATE.test(taskText(t))) {
		return s.breadth || s.files >= 3 || s.words >= ARCH_WORDS ? "planner" : "investigator";
	}

	// 5) A brief that explicitly forbids mutation, and asks for nothing that survives
	//    the read-only clauses, gets the read-only cheap agent. On pi the agent name
	//    carries the TOOLSET, so defaulting "do not edit any host file, report only" to
	//    `coder` hands edit+write to a dispatch that was told not to have them.
	//    `investigator` is read-only and cheaper than `reviewer`; `planner` would also be
	//    read-only but is heavy, and paying opus rates to withhold a tool is a bad trade
	//    (rung 4 above now answers it the same way). This is a "report only" ask, not a
	//    correctness verdict, so it is exactly `investigator`'s job, not `reviewer`'s.
	//
	//    `&& !s.mutate` is load-bearing: a brief can fence off one thing and still ask
	//    for an edit — "the credential path must never change; add do_link support to
	//    install.sh" is read-only AND mutating, and it needs the edit tool. signals()
	//    already cut the forbidding clauses out before looking for the ask, so `mutate`
	//    here means a mutation verb OUTSIDE every negation.
	//
	//    pi-only divergence (1 of 4): the Claude hook records read_only and tiers on
	//    nothing, because an alias sets only a price.
	if (s.readOnly && !s.mutate) return "investigator";

	// 6) Everything ambiguous: the mid tier's general agent, which simply need not edit.
	return "coder";
}

/** Explain the deterministic classifier without retaining the task text. */
function classifyWithEvidence(text: string): RouteEvidence {
	const t = taskText(text || "");
	const s = signals(t);
	const agent = classify(t);
	let rule: RouteEvidence["rule"] = "default";
	if (s.review) rule = "review";
	else if (s.verifiable && !s.depth && !s.mutate && s.targets <= 1 && s.words <= CHEAP_WORDS)
		rule = "cheap-verifiable";
	else if (s.trivial && !s.breadth && s.files <= 2 && s.words <= CHEAP_WORDS)
		rule = "cheap-trivial";
	else if (
		(s.depth && s.breadth) ||
		(s.mutate && s.files >= 3) ||
		(s.mutate && s.breadth && !s.trivial) ||
		(s.arch && (s.breadth || s.words >= ARCH_WORDS))
	)
		rule = "heavy";
	else if (INVESTIGATE.test(t)) rule = "investigate";
	else if (s.readOnly && !s.mutate) rule = "read-only";

	const conflictingSignals = Number(s.mutate) + Number(s.readOnly) + Number(s.review) > 1;
	const signalPoor =
		rule === "default" &&
		!s.depth &&
		!s.breadth &&
		!s.arch &&
		!s.mutate &&
		!s.review &&
		!s.verifiable &&
		!s.trivial &&
		s.files === 0 &&
		s.targets === 0;
	const certainty: RouteCertainty = signalPoor
		? "low"
		: rule === "default" || conflictingSignals
			? "medium"
			: "high";
	return { agent, rule, certainty, signals: s };
}

// ---- return contract ------------------------------------------------------
// Appended to the dispatch task when this router assigned the agent. Measured on the
// Claude side over 143 real subagent returns: 49% carried ZERO path:line anchors, 99%
// never said what they had not checked, 53% marked no confidence — which is why the
// parent re-reads and re-derives work a subagent already did. The length rule is a CAP
// (p90 was already ~3,150 tokens of parent context per dispatch), not a floor.
const RETURN_CONTRACT = `

--- Return contract (injected by subagent-model-router) ---
Your final message is the ONLY thing the caller sees; it is data for another model,
not a report for a human. It must carry:
1. ANCHORS. Every factual claim cites a verifiable location — \`path:line\`, a commit
   sha, or a page/issue key. Never paraphrase an identifier away.
2. COVERAGE. One line stating what you searched AND what you did not check.
3. CONFIDENCE. Mark each conclusion \`confirmed\` (you read it), \`inferred\` (deduced
   from what you read), or \`unverified\` (assumed).
4. LENGTH. At most ~1200 tokens of prose; anchor lines are exempt. Drop narration of
   your own process — the caller needs the conclusion and its evidence, not the walk.
`;

// Skip when the caller already demanded a shape of their own: a second, generic
// contract only competes with theirs. Also makes the injection idempotent.
const HAS_CONTRACT = /(path:line|file:line|Return contract)/i;
const HAS_HANDOFF_CONTRACT = /(Handoff contract|task-packet)/i;

// ---- per-agent model ranking (capability floor + price ascending) ---------
// One ordered candidate list PER AGENT (not per tier — coder and reviewer are both
// mid-tier but want different primaries), each an explicit, fully-authored chain:
// [pinned primary, ...pinned fallbacks in cooldown order]. There is no shared
// “universal default” entry injected into every list — each chain says exactly
// what it wants, in order. Keep these ids in sync with models.json (provider/id).
//
// NO list here contains a 1M-context model ref (no "-1m/" or ":1M" id). This router
// never widens the context window on its own; a 1M model is reachable only when the
// caller sets `model` explicitly on the subagent_routed call. Explicit models still
// participate in cooldown routing unless `forceModel` is set. Do not add a 1M id to
// any of these lists.
const QGENIE_LUNA_MODEL = "qgenie-openai/gpt-5.6-luna";
const BREEZE_LUNA_MODEL = "breeze-openai/gpt-5.6-luna";
const BREEZE_SOL_MODEL = "breeze-openai/gpt-5.6-sol";
const DEEPSEEK_MODEL = "qgenie-deepseek/deepseek-v4-flash";
const SONNET_MODEL = "breeze/claude-sonnet-5";
const QGENIE_SONNET_MODEL = "qgenie/anthropic::claude-5-sonnet";
const OPUS_MODEL = "breeze/claude-opus-5-5";

// Budget policy: lightweight roles prefer QGenie Luna, then Breeze Luna, then
// DeepSeek. Coding stays on Luna. Review and deep roles use Sonnet, then the
// QGenie Anthropic fallback. Planner inherits the current model by default; its
// higher-level choices are offered interactively, while this list remains the
// fallback chain for explicit or non-interactive planner routes.
const AGENT_CANDIDATES: Record<string, string[]> = {
	editor: [QGENIE_LUNA_MODEL, BREEZE_LUNA_MODEL, DEEPSEEK_MODEL],
	investigator: [QGENIE_LUNA_MODEL, BREEZE_LUNA_MODEL, DEEPSEEK_MODEL],
	coder: [QGENIE_LUNA_MODEL, BREEZE_LUNA_MODEL],
	reviewer: [SONNET_MODEL, QGENIE_SONNET_MODEL],
	"deep-coder": [SONNET_MODEL, QGENIE_SONNET_MODEL],
	"deep-reviewer": [SONNET_MODEL, QGENIE_SONNET_MODEL],
	planner: [OPUS_MODEL, BREEZE_SOL_MODEL, SONNET_MODEL],
};

function candidateListForAgent(agent: string | undefined): string[] | undefined {
	return agent && Object.hasOwn(AGENT_CANDIDATES, agent) ? AGENT_CANDIDATES[agent] : undefined;
}
function isOpusModel(model: unknown): model is string {
	return typeof model === "string" && /(?:^|[/:_-])opus(?:$|[/:_-])/i.test(model);
}

function applyBudgetModelPolicy(model: string): string {
	// Explicit QGenie Gemini/Terra/Sol (or future QGenie models) are not allowed
	// while Luna quota is constrained. DeepSeek is the intentional lightweight
	// fallback. Keep manually requested non-QGenie models unchanged; Opus gets a
	// separate confirmation gate.
	const allowed = model === QGENIE_LUNA_MODEL || model === DEEPSEEK_MODEL;
	return /^qgenie(?:-|\/)/i.test(model) && !allowed ? QGENIE_LUNA_MODEL : model;
}

function routedItems(input: any): any[] {
	return [
		input,
		...(Array.isArray(input?.tasks) ? input.tasks : []),
		...(Array.isArray(input?.chain) ? input.chain : []),
	].filter((item) => item && typeof item === "object");
}

async function confirmOpusModels(
	input: any,
	ctx?: any,
	approvedItems = new WeakSet<object>(),
): Promise<void> {
	const items = routedItems(input);
	const opusItems = items.filter(
		(item) => isOpusModel(item.model) && item.forceModel !== true && !approvedItems.has(item),
	);
	if (opusItems.length === 0) return;

	const requested = Array.from(new Set(opusItems.map((item) => String(item.model)))).join(", ");
	let approved = false;
	try {
		approved = Boolean(
			ctx?.hasUI &&
				ctx.ui?.confirm &&
				(await ctx.ui.confirm(
					"Allow Breeze Opus route?",
					`Requested model(s): ${requested}\n\nOpus uses higher token budget. Allow this route?`,
				)),
		);
	} catch {
		approved = false;
	}
	if (approved) return;

	for (const item of opusItems) {
		item.routerFallbackFromModel ??= item.model;
		item.routerFallbackReason ??= "budget";
		item.model = SONNET_MODEL;
		item.contextBudget = contextBudgetForModel(item.model);
		item.routerFallback = true;
	}
}

/** Keep planner on the current model unless the user explicitly chooses a higher route. */
async function askPlannerOpus(
	input: any,
	ctx?: any,
	approvedItems = new WeakSet<object>(),
): Promise<void> {
	const items = routedItems(input).filter(
		(item) =>
			item.agent === "planner" &&
			item.forceModel !== true &&
			(typeof item.model !== "string" || !item.model.trim()),
	);
	if (items.length === 0 || !ctx?.hasUI || !ctx.ui?.select) return;
	const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "current model";
	const choices = [`Use ${current}`, ...AGENT_CANDIDATES.planner];
	let selected: string | undefined;
	try {
		selected = await ctx.ui.select("Planner model", choices);
	} catch {
		return;
	}
	if (!selected || selected === choices[0]) return;
	for (const item of items) {
		item.model = selected;
		item.contextBudget = contextBudgetForModel(selected);
		if (selected === OPUS_MODEL) approvedItems.add(item);
		item.routerFallback = false;
		delete item.routerFallbackFromModel;
		delete item.routerFallbackReason;
	}
}

interface ModelSelection {
	model: string;
	fallback: boolean;
}

/** Cheapest healthy candidate in a list; all-cooling lists fail closed. */
function selectFromList(
	list: string[] | undefined,
	cooling: CooldownMap,
): ModelSelection | undefined {
	if (!list || list.length === 0) return undefined;
	for (let index = 0; index < list.length; index++) {
		if (!cooling.has(list[index])) return { model: list[index], fallback: index > 0 };
	}
	return undefined;
}

function pickFromList(list: string[] | undefined, cooling: CooldownMap): string | undefined {
	return selectFromList(list, cooling)?.model;
}

export interface ModelRouteDecision {
	model?: string;
	fallback: boolean;
	fallbackFromModel?: string;
	fallbackReason?: "cooldown" | "budget" | "budget+cooldown";
	cooldownUntil?: number;
	blockedReason?: string;
}

/** Resolve explicit or automatic model selection against current health. */
export function routeModelForAgent(
	agent: string | undefined,
	requestedModel: string | undefined,
	cooling: CooldownMap,
	forceModel = false,
): ModelRouteDecision {
	const original = requestedModel;
	const budgeted = requestedModel
		? forceModel
			? requestedModel
			: applyBudgetModelPolicy(requestedModel)
		: undefined;
	const budgetFallback = Boolean(original && budgeted && original !== budgeted);
	const requested = budgeted;
	const list = candidateListForAgent(agent);
	// Planner and custom agents inherit their configured/current model unless an
	// explicit model was requested. Only built-in routed roles have candidate lists.
	if (!requested && (agent === "planner" || !list?.length)) return { fallback: false };
	if (requested && forceModel) {
		return {
			model: requested,
			fallback: budgetFallback,
			fallbackFromModel: budgetFallback ? original : undefined,
			fallbackReason: budgetFallback ? "budget" : undefined,
		};
	}
	if (requested && !cooling.has(requested)) {
		return {
			model: requested,
			fallback: budgetFallback,
			fallbackFromModel: budgetFallback ? original : undefined,
			fallbackReason: budgetFallback ? "budget" : undefined,
		};
	}

	// Opus is an explicit/interactive choice, never an implicit fallback. Otherwise
	// rejecting Opus can loop back to it when the replacement model is cooling.
	const fallbackList =
		requested && agent === "planner" ? list?.filter((model) => !isOpusModel(model)) : list;
	const selection = selectFromList(fallbackList, cooling);
	if (selection) {
		const from = original ?? requested;
		const automaticFallback = !requested && selection.fallback;
		const primary = list?.[0];
		const budgetAndCooldown = Boolean(budgetFallback && requested && cooling.has(requested));
		return {
			model: selection.model,
			fallback: requested ? true : selection.fallback,
			fallbackFromModel: requested ? from : automaticFallback ? primary : undefined,
			fallbackReason: requested
				? budgetAndCooldown
					? "budget+cooldown"
					: "cooldown"
				: automaticFallback
					? "cooldown"
					: undefined,
			cooldownUntil: requested
				? cooling.get(requested)?.until
				: automaticFallback && primary
					? cooling.get(primary)?.until
					: undefined,
		};
	}
	const coolingDetails = fallbackList
		?.map(
			(model) =>
				`${model}${cooling.has(model) ? ` (${cooldownText(cooling.get(model) as CooldownEntry)})` : ""}`,
		)
		.join(", ");
	return {
		fallback: Boolean(requested || budgetFallback),
		fallbackFromModel: requested ?? original,
		fallbackReason: requested
			? budgetFallback
				? "budget+cooldown"
				: "cooldown"
			: budgetFallback
				? "budget"
				: undefined,
		cooldownUntil: requested ? cooling.get(requested)?.until : undefined,
		blockedReason: `No healthy model available for ${agent ?? "requested route"}${coolingDetails ? `; candidates: ${coolingDetails}` : ""}`,
	};
}

function taskTitle(task: unknown): string {
	if (typeof task !== "string") return "task";
	const title = stripRouteContract(task).split(/\r?\n/, 1)[0]?.trim() || "task";
	return title.length > 56 ? `${title.slice(0, 55)}…` : title;
}

function stripRouteContract(task: string): string {
	return task.split("\n\n--- Return contract (injected")[0];
}

type RoutedStatusItem = {
	agent: string;
	model?: string;
	task: string;
};

// Rows for a call land in the shared task-dock keyed `sub:<toolCallId>:<index>`,
// the same scheme subagent/index.ts uses — its own execute() owns the full
// per-item lifecycle (richer: real model/usage/state per item) and overwrites
// these placeholders as soon as it starts. This only seeds an initial row
// before execute() runs, and finalizes it as a safety net if execute() ever
// throws before reaching its own terminal updateRoutedStatus() call.
function startRoutedStatus(ctx: any, toolCallId: string, items: RoutedStatusItem[]): void {
	if (!ctx?.hasUI || items.length === 0) return;
	const startedAt = Date.now();
	items.forEach((item, index) => {
		upsertTask(ctx, `sub:${toolCallId}:${index}`, {
			source: "subagent",
			label: item.agent,
			model: item.model,
			state: "running",
			startedAt,
			detail: taskTitle(item.task),
		});
	});
}

// subagent/index.ts's own execute() already lands the final cost/tokens on
// each row via publishRoutedStatus() before this tool_result handler runs.
// But `updateRoutedStatus(results, "done"/"error")` there upserts by an
// index-based row per item (`sub:${toolCallId}:${index}`), while chain/single
// callers can also stop early (thrown error, cancel) and skip that final
// publish. Re-apply the same cost/tokens here from `event.details.results` as
// a safety net so finalizeGroup's blanket state overwrite never clobbers a
// row back to "cost n/a" when it does still have live results to read from.
function finishRoutedStatus(ctx: any, toolCallId: string, isError: boolean, details?: any): void {
	if (!ctx?.hasUI) return;
	const results = Array.isArray(details?.results) ? details.results : [];
	results.forEach((result: any, index: number) => {
		const usage = result?.usage;
		if (!usage) return;
		try {
			upsertTask(ctx, `sub:${toolCallId}:${index}`, {
				source: "subagent",
				tokens: { input: usage.input, output: usage.output },
				cost: Number.isFinite(usage.cost) ? usage.cost : undefined,
			});
		} catch {
			/* task-dock is optional */
		}
	});
	finalizeGroup(ctx, `sub:${toolCallId}`, isError ? "error" : "done");
}

export interface SubagentRouteDecision {
	agent?: string;
	agentRouted: boolean;
	routeEvidence?: RouteEvidence;
	task?: string;
	model?: string;
	contextBudget?: ContextBudget;
	fallback: boolean;
	fallbackFromModel?: string;
	fallbackReason?: string;
	cooldownUntil?: number;
	blockedReason?: string;
}

/** Decide a route without mutating the caller's tool input. */
export function decideRoute(item: any, cooling: CooldownMap): SubagentRouteDecision | undefined {
	if (!item || typeof item !== "object") return undefined;

	let agent = item.agent;
	const a = typeof agent === "string" ? agent.trim().toLowerCase() : "";
	let agentRouted = false;
	let routeEvidence: RouteEvidence | undefined;
	if (!a || a === "auto" || a === "default" || a === "router") {
		if (typeof item.task === "string" && item.task.trim()) {
			routeEvidence = classifyWithEvidence(item.task);
			const classified = routeEvidence.agent;
			const safeAgent =
				routeEvidence.certainty === "low" &&
				!routeEvidence.signals.mutate &&
				!routeEvidence.signals.review
					? "investigator"
					: candidateListForAgent(classified)
						? classified
						: "coder";
			if (safeAgent !== classified) {
				routeEvidence = {
					...routeEvidence,
					effectiveAgent: safeAgent,
					fallbackReason: "low-certainty",
				};
			} else {
				routeEvidence = { ...routeEvidence, effectiveAgent: safeAgent };
			}
			agent = safeAgent;
			agentRouted = true;
		}
	}

	const modelDecision = routeModelForAgent(
		typeof agent === "string" ? agent : undefined,
		typeof item.model === "string" ? item.model : undefined,
		cooling,
		item.forceModel === true,
	);
	const model = modelDecision.model;
	let task = typeof item.task === "string" ? item.task : undefined;
	if (task !== undefined) {
		const needsHandoff = task.includes("{previous}") || typeof item.phase === "string";
		if (agentRouted && !HAS_CONTRACT.test(task)) task += RETURN_CONTRACT;
		if (needsHandoff && !HAS_HANDOFF_CONTRACT.test(task)) task += HANDOFF_CONTRACT;
	}

	return {
		agent: typeof agent === "string" ? agent : undefined,
		agentRouted,
		routeEvidence,
		task,
		model,
		contextBudget: contextBudgetForModel(model),
		fallback: modelDecision.fallback,
		fallbackFromModel: modelDecision.fallbackFromModel,
		fallbackReason: modelDecision.fallbackReason,
		cooldownUntil: modelDecision.cooldownUntil,
		blockedReason: modelDecision.blockedReason,
	};
}

/** Apply a previously computed decision to the tool input. */
export function applyRouteDecision(item: any, decision: SubagentRouteDecision): void {
	if (!item || typeof item !== "object") return;
	// Router metadata is derived state. Never trust or retain caller-supplied/stale values.
	delete item.routerFallback;
	delete item.routerFallbackFromModel;
	delete item.routerFallbackReason;
	delete item.routerCooldownUntil;
	delete item.routerBlockedReason;

	if (decision.agentRouted && decision.agent) item.agent = decision.agent;
	if (decision.model) item.model = decision.model;
	else if (decision.blockedReason) delete item.model;
	item.contextBudget = decision.contextBudget;
	item.routerFallback = decision.fallback;
	if (decision.fallbackFromModel) item.routerFallbackFromModel = decision.fallbackFromModel;
	if (decision.fallbackReason) item.routerFallbackReason = decision.fallbackReason;
	if (decision.cooldownUntil) item.routerCooldownUntil = decision.cooldownUntil;
	if (decision.blockedReason) item.routerBlockedReason = decision.blockedReason;
	if (decision.task !== undefined) item.task = decision.task;
}

/** Route one {agent?, task?, model?} item in place. */
function routeItem(item: any, cooling: CooldownMap): SubagentRouteDecision | undefined {
	const decision = decideRoute(item, cooling);
	if (decision) applyRouteDecision(item, decision);
	return decision;
}

// ---- acp_delegate (billion-context-pi) boundary ----------------------------
// acp_delegate's `agent` is one of 5 FIXED roles (reviewer/researcher/worker/
// planner/oracle), each with its own prompt, toolset, child lifecycle, session
// files, and model inheritance. This is a separate contract from
// subagent_routed's free-form agent/model router. ACP input is therefore left
// untouched by default; model routing below exists only for explicit opt-in.
const DELEGATE_TOOL_NAME = "acp_delegate";

function delegateModelFor(role: string, task: string, cooling: CooldownMap): string | undefined {
	switch (role) {
		// Read-only correctness verdict: same floor as subagent_routed's own review
		// rung — never the cheap tier, cross-file/unbounded gets the deeper list.
		case "reviewer": {
			const s = signals(taskText(task));
			return pickFromList(
				AGENT_CANDIDATES[s.breadth || s.files >= 3 ? "deep-reviewer" : "reviewer"],
				cooling,
			);
		}
		// Read-only fact-finding: cheap by default (investigator), heavy only at
		// scale — mirrors classify()'s rung 4 for an explicit investigate ask.
		case "researcher": {
			const s = signals(taskText(task));
			return pickFromList(
				AGENT_CANDIDATES[
					s.breadth || s.files >= 3 || s.words >= ARCH_WORDS ? "planner" : "investigator"
				],
				cooling,
			);
		}
		// The only role with edit/write/bash — full classify() applies, floored at
		// `coder` (not `editor`) since acp_delegate's worker has no 1-2-file refusal
		// to bound a cheap-tier mistake the way our own `editor` agent does.
		case "worker": {
			const tier = classify(task);
			const floored = tier === "editor" || tier === "investigator" ? "coder" : tier;
			return pickFromList(AGENT_CANDIDATES[floored] ?? AGENT_CANDIDATES.coder, cooling);
		}
		// Read-only architecture/step planning: always the heavy planner list —
		// the role itself is the scale signal, no need to re-classify.
		case "planner":
			return pickFromList(AGENT_CANDIDATES.planner, cooling);
		// Read-only expert judgment call: no dedicated tier, so it gets the same
		// heaviest list as planner rather than silently falling through to
		// acp.json's own (often cheaper) role default.
		case "oracle":
			return pickFromList(AGENT_CANDIDATES.planner, cooling);
		default:
			return undefined;
	}
}

export default function (pi: ExtensionAPI) {
	// ctx (2nd arg) carries ctx.ui — present in the interactive TUI, a no-op in the
	// child's json/print mode, so routing status only ever paints the parent footer.
	pi.on("tool_call", async (event: any, ctx?: any) => {
		try {
			const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : "";
			const opusApproved = new WeakSet<object>();
			const takeover = cwd ? activeTakeoverForCwd(cwd) : undefined;
			if (
				takeover &&
				(event?.toolName === "bash" || event?.toolName === "write" || event?.toolName === "edit") &&
				event.toolName !== "subagent_submit_takeover"
			) {
				if (event.toolName === "bash")
					return {
						block: true,
						reason:
							"Controlled Lead takeover forbids shell writes; use scoped edit/write and submit acceptance.",
					};
				const candidate = event.input?.file_path ?? event.input?.path;
				if (typeof candidate !== "string" || !isTaskPathAllowed(takeover, candidate))
					return {
						block: true,
						reason: `Controlled Lead takeover allows only: ${takeover.control.allowedPaths.join(", ")}`,
					};
			}
			if (event?.toolName === DELEGATE_TOOL_NAME) {
				// billion-context-pi owns acp_delegate's fixed roles, child process,
				// model inheritance, session files, cancellation, and notifications.
				// Do not let this router create a second model policy by silently
				// rewriting ACP input. A bad injected provider (for example Breeze
				// without a child-resolvable API key) makes the ACP child exit nonzero
				// and surfaces as `[acp_delegate FAILED ⚠️]`.
				//
				// Keep the old coupling only as an explicit opt-in for deployments that
				// validate every candidate provider in both parent and child contexts.
				if (process.env.PI_ROUTE_ACP_DELEGATE !== "1") return;
				const input = event.input;
				if (!input || typeof input !== "object") return;
				if (typeof input.model === "string") {
					input.model = applyBudgetModelPolicy(input.model);
				} else {
					const role = typeof input.agent === "string" ? input.agent.trim().toLowerCase() : "";
					const task = typeof input.task === "string" ? input.task : "";
					const model = delegateModelFor(role, task, coolingModels());
					if (model) input.model = model;
				}
				await confirmOpusModels(input, ctx, opusApproved);
				return; // the fork's own bridge (billion-context-pi:delegate:v1) feeds task-dock.
			}
			if (!event || event.toolName !== "subagent_routed") return;
			const input = event.input;
			if (!input || typeof input !== "object") return;
			const cooling = coolingModels();
			const routeDecisions = new WeakMap<object, SubagentRouteDecision>();
			const routeOne = (item: any) => {
				const decision = routeItem(item, cooling);
				if (decision && item && typeof item === "object") routeDecisions.set(item, decision);
			};
			const items = [
				input,
				...(Array.isArray(input.tasks) ? input.tasks : []),
				...(Array.isArray(input.chain) ? input.chain : []),
			].filter((it): it is Record<string, any> => Boolean(it && typeof it === "object"));
			const graftItems = items.filter(
				(it) =>
					Boolean(cwd) &&
					typeof it.task === "string" &&
					shouldRetrieveSubagent(it.task) &&
					hasPiSkill(cwd),
			);
			routeOne(input); // single mode
			if (Array.isArray(input.tasks)) for (const it of input.tasks) routeOne(it);
			if (Array.isArray(input.chain)) for (const it of input.chain) routeOne(it);

			if (graftItems.length) {
				await Promise.all(
					graftItems.map(async (it) => {
						const context = await retrieveGraftContext(it.task, cwd);
						if (context) it.task = `${it.task}\n\n${context}`;
					}),
				);
			}
			if (ctx?.hasUI && ctx.ui?.confirm) await askPlannerOpus(input, ctx, opusApproved);
			await confirmOpusModels(input, ctx, opusApproved);

			// Keep route identity in the tool-call row, not in a separate statusline.
			try {
				const items = [
					input,
					...(Array.isArray(input.tasks) ? input.tasks : []),
					...(Array.isArray(input.chain) ? input.chain : []),
				].filter((it) => it && typeof it === "object" && (it.agent || it.model));
				if (items.length) {
					const routedItems = items.map((it: any) => ({
						agent: String(it.agent ?? "?"),
						model: typeof it.model === "string" ? it.model : undefined,
						contextBudget: it.contextBudget,
						routerFallbackFromModel:
							typeof it.routerFallbackFromModel === "string"
								? it.routerFallbackFromModel
								: undefined,
						routeEvidence: routeDecisions.get(it)?.routeEvidence,
						task: typeof it.task === "string" ? it.task : "task",
					}));
					routedCalls.set(event.toolCallId, routedItems);
					startRoutedStatus(ctx, event.toolCallId, routedItems);
					ctx?.ui?.requestRender?.();
				}
			} catch {
				/* task-dock is optional; never let a status write break delegation */
			}
		} catch {
			/* fail-open: never block delegation on a router error */
		}
	});

	// Finalize task-dock rows once this dispatch's result lands.
	pi.on("tool_result", (event: any, ctx?: any) => {
		try {
			if (event?.toolName !== "subagent_routed") return;
			finishRoutedStatus(
				ctx,
				event.toolCallId,
				Boolean(event?.isError || event?.result?.isError),
				event?.details,
			);
			routedCalls.delete(event.toolCallId);
		} catch {
			/* status bar is optional */
		}
	});
}
