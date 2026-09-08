/**
 * permissions — tool-call allow/deny rules read from `~/.pi/agent/permissions.json`,
 * analogous to Claude Code's `permissions.allow`/`permissions.deny` glob rules.
 *
 * Rule syntax mirrors Claude's flat-string style: bare `"toolName"` matches any
 * call to that tool; `"toolName(glob)"` additionally matches the tool's primary
 * subject string against a `*`-glob (bash/powershell -> input.command, edit/write/
 * read/ls -> input.path, grep/find -> input.pattern). Tools without a known
 * subject field (custom tools like subagent_routed, mcp__*, bg_run) only support
 * bare-name rules — a `(glob)` suffix on those never matches (fails open).
 *
 * An `allow` match always wins over `deny` for that call. No rule matching =
 * no opinion (call proceeds), same as returning nothing from `tool_call`.
 *
 * WHY try/catch wraps every branch: `tool_call` is the one pi event NOT wrapped
 * in try/catch by the runtime (`runner.js` emitToolCall) — an uncaught throw here
 * is re-raised as a hard "Extension failed, blocking execution" for the call, so
 * this extension must fail open on its own, same discipline as `claude/read-guard.py`.
 *
 * CONFIG (env):
 *   PI_PERMISSIONS_OFF=1   disable entirely.
 *
 * FILE (~/.pi/agent/permissions.json):
 *   { "allow": ["bash(git status*)"], "deny": ["bash(git push*)", "subagent_routed"] }
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface Rules {
	allow: string[];
	deny: string[];
}

const EMPTY_RULES: Rules = { allow: [], deny: [] };

function loadRules(): Rules {
	try {
		const raw = readFileSync(join(getAgentDir(), "permissions.json"), "utf-8");
		const parsed = JSON.parse(raw) as Partial<Rules>;
		return {
			allow: Array.isArray(parsed.allow) ? parsed.allow.filter((r) => typeof r === "string") : [],
			deny: Array.isArray(parsed.deny) ? parsed.deny.filter((r) => typeof r === "string") : [],
		};
	} catch {
		return EMPTY_RULES;
	}
}

function primarySubject(toolName: string, input: Record<string, unknown>): string | undefined {
	const field =
		toolName === "bash" || toolName === "powershell"
			? "command"
			: toolName === "edit" || toolName === "write" || toolName === "read" || toolName === "ls"
				? "path"
				: toolName === "grep" || toolName === "find"
					? "pattern"
					: undefined;
	if (!field) return undefined;
	const value = input[field];
	return typeof value === "string" ? value : undefined;
}

function globToRegExp(glob: string): RegExp {
	const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`);
}

function ruleMatches(rule: string, toolName: string, input: Record<string, unknown>): boolean {
	const parsed = /^([^()]+)(?:\((.*)\))?$/.exec(rule.trim());
	if (!parsed) return false;
	const [, name, pattern] = parsed;
	if (name.trim() !== toolName) return false;
	if (pattern === undefined) return true;
	const subject = primarySubject(toolName, input);
	if (subject === undefined) return false;
	return globToRegExp(pattern).test(subject);
}

export default function permissions(pi: ExtensionAPI) {
	if (process.env.PI_PERMISSIONS_OFF === "1") return;

	let rules: Rules = loadRules();

	pi.on("session_start", async () => {
		try {
			rules = loadRules();
		} catch {
			rules = EMPTY_RULES;
		}
	});

	pi.on("tool_call", async (event) => {
		try {
			const input = "input" in event ? (event.input as Record<string, unknown>) : {};
			if (rules.allow.some((rule) => ruleMatches(rule, event.toolName, input))) return;
			const hit = rules.deny.find((rule) => ruleMatches(rule, event.toolName, input));
			if (hit) return { block: true, reason: `blocked by permissions.json rule "${hit}"` };
		} catch {
			// fail open — never let a permissions bug block or crash a tool call
		}
	});
}
