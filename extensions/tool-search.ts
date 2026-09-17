/**
 * tool-search — a Claude-Code-style "ToolSearch" gate for pi, so the full JSON
 * schemas of every registered tool are NOT shipped on every turn.
 *
 * WHY: pi sends each active tool's `description` + `parameters` schema with every
 * request. With this module's default package set (web-access, background-tasks,
 * memory, fff, subagents, tasks, dynamic-workflows, …) that is ~20-25k tokens of
 * schema on a trivial "hello" turn. pi core already ships a deferred-tool engine
 * (`splitDeferredTools`), but it only fires when the provider advertises
 * `compat.supportsToolReferences` (or Kimi's `deferredToolsMode`), which the breeze /
 * qgenie gateways do not. This extension gets the same win client-side, on ANY
 * provider, using the documented `getAllTools()` / `setActiveTools()` API — the
 * pattern from pi's own `examples/extensions/kimi-deferred-tools.ts`, generalised.
 *
 * HOW:
 *  1. session_start — keep only pi's built-in file/shell tools + `tool_search`
 *     active; every other tool is *deferred* (its schema leaves the request). The
 *     deferred tools' name + one-line description are remembered as a manifest.
 *  2. tool_search(query) — fuzzy-match the query against the deferred manifest,
 *     re-activate the matches (their full schema is injected on the next request),
 *     and report what was activated. `query:"list"` dumps the whole manifest.
 *  3. before_agent_start — append a compact name+blurb manifest of the still-deferred
 *     tools to the system prompt (chained via the documented `systemPrompt` result),
 *     so the model always knows what capabilities exist and can search for them.
 *     Names-only-ish: ~10-20 tokens per deferred tool vs ~500+ for a full schema.
 *
 * SCOPE: only gates the interactive parent (mode "tui"/"rpc"). In "json"/"print"
 * child sessions — the subagents the router dispatches — gating is skipped so a
 * subagent keeps the exact tools its agent frontmatter granted, with no extra
 * round-trip. Fail-open throughout: any error leaves tools untouched.
 *
 * CONFIG (env):
 *   PI_TOOLSEARCH_OFF=1        disable entirely (register nothing, gate nothing).
 *   PI_TOOLSEARCH_KEEP=a,b,c   extra tool names to keep active alongside the core set.
 *   PI_TOOLSEARCH_MAX=6        max tools a single tool_search call may activate (default 6).
 *   PI_TOOLSEARCH_TTL_TURNS=0  reclaim activated tools after this many unused turns;
 *                              0 keeps current never-reclaim behavior.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// pi's built-in file/shell tools — always active; the model expects these present
// without a search. Unknown names here are harmless (they simply never match).
const CORE_TOOLS = new Set(
	[
		"bash",
		"read",
		"write",
		"edit",
		"multiedit",
		"str_replace",
		"str_replace_editor",
		"apply_patch",
		"grep",
		"find",
		"glob",
		"ls",
		"view",
		"tool_search",
		// pi-plan-mode's own gate tools: enterPlanMode() asserts these are active before
		// /plan can start at all, with no chance for the model to tool_search them in first
		// (the assertion runs on the slash command itself, pre-turn). Deferring them makes
		// /plan permanently fail in interactive sessions.
		"plan_mode_question",
		"plan_mode_complete",
	].map((s) => s.toLowerCase()),
);

const OFF = /^(1|true|yes|on)$/i.test(process.env.PI_TOOLSEARCH_OFF ?? "");
const EXTRA_KEEP = (process.env.PI_TOOLSEARCH_KEEP ?? "")
	.split(",")
	.map((s) => s.trim().toLowerCase())
	.filter(Boolean);
const MAX_ACTIVATE = Math.max(1, Number(process.env.PI_TOOLSEARCH_MAX) || 6);
// Opt-in until real-session measurements establish a safe default. A reclaimed tool is
// still discoverable and can be reactivated by tool_search on demand.
const TOOL_TTL_TURNS = Math.max(0, Number(process.env.PI_TOOLSEARCH_TTL_TURNS) || 0);
// Per-turn manifest verbosity: "names" (default, cheapest — comma-joined tool names only)
// or "brief" (one line + short blurb per tool). Full descriptions are always available on
// demand via `tool_search {"query":"list"}`, so names-only rarely costs discovery.
const MANIFEST_BRIEF = /^brief$/i.test(process.env.PI_TOOLSEARCH_MANIFEST ?? "");
// Opt-in: collapse pi's `<available_skills>` block to skill names only (drops the verbose
// per-skill <description>/<location>), saving ~1k+ tokens/turn when packages ship chatty
// skills. OFF by default: those descriptions are how the model knows *when/how* to use a
// skill — e.g. the `workflow-patterns` / `workflow-authoring` blurbs drive the `workflow`
// tool, so compacting them would weaken that capability. The /skill:<name> commands and the
// skills themselves are never touched; this only trims the always-on prompt text.
const COMPACT_SKILLS = /^(1|true|yes|on|names|compact)$/i.test(
	process.env.PI_TOOLSEARCH_COMPACT_SKILLS ?? "",
);

// name -> { desc, hay } for every deferred (schema-suppressed) tool.
type Deferred = { name: string; desc: string; hay: string };
const deferred = new Map<string, Deferred>();
const knownDeferred = new Map<string, Deferred>();
const loaded = new Set<string>();
const lastUsedTurn = new Map<string, number>();
let currentTurn = 0;
let gated = false; // did we actually defer anything this session?

/** Small, read-only snapshot consumed by token telemetry; no tool descriptions cross the boundary. */
export function getToolSearchSnapshot():
	| { deferredToolCount: number; deferredManifestHash: string }
	| undefined {
	if (!gated) return undefined;
	const names = [...deferred.keys()].sort((a, b) => a.localeCompare(b));
	let hash = 0x811c9dc5;
	for (const char of names.join("\n")) {
		hash ^= char.charCodeAt(0);
		hash = Math.imul(hash, 0x01000193);
	}
	return {
		deferredToolCount: names.length,
		deferredManifestHash: (hash >>> 0).toString(16).padStart(8, "0"),
	};
}

function syncToolStatus(pi: any, ctx?: any): void {
	try {
		if (!ctx?.ui?.setStatus || !gated) return;
		const active = new Set<string>(pi.getActiveTools?.() ?? []);
		for (const name of [...deferred.keys()]) {
			if (active.has(name)) {
				deferred.delete(name);
				loaded.add(name);
			}
		}
		const theme = ctx.ui.theme;
		ctx.ui.setStatus(
			"tool-search",
			theme.fg("muted", "⛁  ") +
				theme.fg("text", String(deferred.size)) +
				theme.fg("muted", " deferred · ") +
				theme.fg("text", String(loaded.size)) +
				theme.fg("muted", " loaded"),
		);
	} catch {
		/* status bar is optional */
	}
}

/** First sentence / clause of a tool description, trimmed for the manifest. */
function blurb(desc: string | undefined, max = 88): string {
	const one = (desc ?? "").replace(/\s+/g, " ").trim();
	const cut = one.split(/(?<=[.!?])\s/)[0] || one;
	return cut.length > max ? cut.slice(0, max - 1).trimEnd() + "…" : cut;
}

/** Score a deferred tool against the query. Word overlap on name+desc, name hits weighted. */
function score(query: string, d: Deferred): number {
	const words = query
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((w) => w.length >= 3);
	if (words.length === 0) return d.hay.includes(query.toLowerCase().trim()) ? 1 : 0;
	const nameL = d.name.toLowerCase();
	let s = 0;
	for (const w of words) {
		if (nameL.includes(w)) s += 3;
		else if (d.hay.includes(w)) s += 1;
	}
	return s;
}

/** Compact manifest of the tools still deferred — cheap enough to ship every turn.
 *  Default is names-only (comma-joined); `PI_TOOLSEARCH_MANIFEST=brief` adds a blurb each. */
function manifestBlock(): string {
	if (deferred.size === 0) return "";
	const names = [...deferred.values()].map((d) => d.name).sort((a, b) => a.localeCompare(b));
	const header =
		"## More tools available (schemas deferred to save context)\n" +
		"Call `tool_search` with a short capability query to load any of these, then call it directly. " +
		'(`tool_search {"query":"list"}` shows full descriptions.)';
	if (!MANIFEST_BRIEF) {
		return `${header}\nAvailable: ${names.join(", ")}`;
	}
	const lines = [...deferred.values()]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((d) => `- ${d.name} — ${d.desc}`);
	return `${header}\n\n${lines.join("\n")}`;
}

/** Collapse the `<available_skills>` block to skill names only, dropping each
 *  `<description>`/`<location>`. Scoped to that block; fail-open (returns the input
 *  unchanged) if the block or an entry doesn't match the expected shape. */
function compactSkills(sp: string): string {
	try {
		return sp.replace(/<available_skills>[\s\S]*?<\/available_skills>/, (block) => {
			const names = [...block.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => m[1].trim());
			if (names.length === 0) return block;
			return `<available_skills>\n${names
				.map((n) => `  <skill><name>${n}</name></skill>`)
				.join("\n")}\n</available_skills>`;
		});
	} catch {
		return sp;
	}
}

export default function (pi: ExtensionAPI) {
	if (OFF) return; // fully disabled — no gate, no tool_search tool.

	// The gate itself. Registered unconditionally at load so its schema is tiny and
	// always present; it does nothing until session_start populates `deferred`.
	pi.registerTool({
		name: "tool_search",
		label: "Tool Search",
		description:
			"Activate deferred tools by capability. Most tools are not loaded upfront to save context; " +
			"call this with a short natural-language query describing the capability you need " +
			'(e.g. "web search", "delegate subagent", "task todo list", "memory"), and the matching ' +
			'tools become callable on the next step. Use query "list" to see every deferred tool.',
		promptSnippet:
			"When the active tools cannot do the task, call tool_search with a short capability query to activate more tools before giving up.",
		parameters: Type.Object({
			query: Type.String({
				description: 'Capability to search for, or "list" to dump the full deferred-tool manifest.',
			}),
		}),
		async execute(
			_toolCallId,
			params: { query: string },
			_signal?: any,
			_onUpdate?: any,
			ctx?: any,
		) {
			try {
				const q = (params.query ?? "").trim();
				if (deferred.size === 0) {
					return {
						content: [
							{ type: "text", text: "All tools are already active; no deferred tools to search." },
						],
						details: { matches: [], activated: [] },
					};
				}
				// "list" (and friends): dump the manifest without activating anything.
				if (/^(list|all|\*|\?|everything|tools)$/i.test(q)) {
					const list = [...deferred.values()]
						.sort((a, b) => a.name.localeCompare(b.name))
						.map((d) => `${d.name} — ${d.desc}`)
						.join("\n");
					return {
						content: [{ type: "text", text: `Deferred tools (${deferred.size}):\n${list}` }],
						details: { matches: [...deferred.keys()], activated: [] },
					};
				}

				const ranked = [...deferred.values()]
					.map((d) => ({ d, s: score(q, d) }))
					.filter((r) => r.s > 0)
					.sort((a, b) => b.s - a.s)
					.slice(0, MAX_ACTIVATE);

				if (ranked.length === 0) {
					const names = [...deferred.keys()].sort().join(", ");
					return {
						content: [
							{
								type: "text",
								text: `No deferred tool matched "${q}". Deferred tools available: ${names}. Retry with one of these names or a closer capability word.`,
							},
						],
						details: { matches: [], activated: [] },
					};
				}

				const activated = ranked.map((r) => r.d.name);
				const active = pi.getActiveTools();
				pi.setActiveTools([...new Set([...active, ...activated])]);
				for (const name of activated) {
					deferred.delete(name);
					loaded.add(name);
					lastUsedTurn.set(name, currentTurn);
				}

				// Refresh the footer count (or clear it once nothing is left deferred).
				// Without this the status was written once at session_start with the
				// initial count and never touched again, so it kept reading e.g. "43
				// tools deferred" for the rest of the session even after most of them had
				// already been activated — a stale/misleading residue, not a live count.
				syncToolStatus(pi, ctx);

				const summary = ranked.map((r) => `${r.d.name} — ${r.d.desc}`).join("\n");
				return {
					content: [
						{
							type: "text",
							text: `Activated ${activated.length} tool(s); call them directly now:\n${summary}`,
						},
					],
					details: { matches: activated, activated },
				};
			} catch (err) {
				return {
					content: [
						{ type: "text", text: `tool_search failed: ${(err as Error)?.message ?? String(err)}` },
					],
					details: { matches: [], activated: [] },
				};
			}
		},
	});

	// 1) Defer everything but core + tool_search, once per session, interactive only.
	pi.on("session_start", (_event: any, ctx?: any) => {
		try {
			const mode = ctx?.mode;
			if (mode === "json" || mode === "print") return; // child subagent: keep its tools.

			const all = pi.getAllTools();
			if (!Array.isArray(all) || all.length === 0) return;

			deferred.clear();
			knownDeferred.clear();
			loaded.clear();
			lastUsedTurn.clear();
			gated = false;
			const keep: string[] = [];
			for (const t of all) {
				const name: string = t?.name;
				if (!name) continue;
				const lower = name.toLowerCase();
				if (CORE_TOOLS.has(lower) || EXTRA_KEEP.includes(lower)) {
					keep.push(name);
					continue;
				}
				const desc = blurb(t?.description);
				const guide = Array.isArray(t?.promptGuidelines) ? t.promptGuidelines.join(" ") : "";
				const entry = {
					name,
					desc: desc || "(no description)",
					hay: `${name} ${t?.description ?? ""} ${guide}`.toLowerCase(),
				};
				deferred.set(name, entry);
				knownDeferred.set(name, entry);
			}

			if (deferred.size === 0) return; // nothing to gain (e.g. no packages loaded).
			pi.setActiveTools([...new Set([...keep, "tool_search"])]);
			gated = true;
			syncToolStatus(pi, ctx);
		} catch {
			/* fail-open: leave every tool active on any error. */
		}
	});

	// Track real calls, not merely activation. This prevents a rarely used tool from
	// pinning its full schema in every later request when opt-in TTL reclamation is enabled.
	pi.on("tool_execution_start", (event: any, ctx?: any) => {
		if (!gated || !ctx || ctx.mode === "json" || ctx.mode === "print") return;
		const name = typeof event?.toolName === "string" ? event.toolName : "";
		if (name && loaded.has(name)) lastUsedTurn.set(name, currentTurn);
	});

	pi.on("turn_start", (event: any, ctx?: any) => {
		if (!gated || !ctx || ctx.mode === "json" || ctx.mode === "print") return;
		if (typeof event?.turnIndex === "number") currentTurn = event.turnIndex;
	});

	pi.on("turn_end", (_event: any, ctx?: any) => {
		if (!gated || TOOL_TTL_TURNS <= 0 || !ctx || ctx.mode === "json" || ctx.mode === "print")
			return;
		try {
			const reclaim = [...loaded].filter((name) => {
				const last = lastUsedTurn.get(name) ?? currentTurn;
				return currentTurn - last >= TOOL_TTL_TURNS;
			});
			if (reclaim.length === 0) return;
			const active = new Set<string>(pi.getActiveTools());
			for (const name of reclaim) {
				active.delete(name);
				loaded.delete(name);
				lastUsedTurn.delete(name);
				const entry = knownDeferred.get(name);
				if (entry) deferred.set(name, entry);
			}
			pi.setActiveTools([...active]);
			syncToolStatus(pi, ctx);
		} catch {
			// Reclamation is optional; never break a turn.
		}
	});

	// 2) Keep the model aware of what it can search for, cheaply, every turn — and,
	//    when enabled, compact the verbose <available_skills> block to names only.
	pi.on("before_agent_start", (event: any, ctx?: any) => {
		try {
			const mode = ctx?.mode;
			syncToolStatus(pi, ctx);
			if (mode === "json" || mode === "print") return;
			let sp = typeof event?.systemPrompt === "string" ? event.systemPrompt : "";
			let changed = false;
			if (COMPACT_SKILLS) {
				const trimmed = compactSkills(sp);
				if (trimmed !== sp) {
					sp = trimmed;
					changed = true;
				}
			}
			if (gated && deferred.size > 0) {
				const block = manifestBlock();
				if (block) {
					sp = `${sp}\n\n${block}`;
					changed = true;
				}
			}
			return changed ? { systemPrompt: sp } : undefined;
		} catch {
			/* fail-open: no manifest rather than a broken turn. */
		}
	});
}
