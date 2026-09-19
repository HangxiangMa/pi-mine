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
 * More-specific deny/ask rules take precedence over broad allow rules. No rule
 * matching = no opinion (call proceeds), same as returning nothing from `tool_call`.
 * Security configuration errors are explicit blocks rather than silent allow.
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
import { resolvePolicyRules, type PolicyRule, type ToolPolicyResult } from "./tool-policy.ts";
import { diagnosticsText, hasErrors, validatePermissionsConfig } from "./config/validation.ts";

interface Rules {
	allow: string[];
	deny: string[];
	ask: string[];
	valid: boolean;
	error?: string;
}

const EMPTY_RULES: Rules = { allow: [], deny: [], ask: [], valid: true };

function loadRules(): Rules {
	try {
		const raw = readFileSync(join(getAgentDir(), "permissions.json"), "utf-8");
		const parsed = JSON.parse(raw) as Partial<Rules>;
		const diagnostics = validatePermissionsConfig(parsed);
		if (hasErrors(diagnostics))
			return {
				...EMPTY_RULES,
				valid: false,
				error: diagnosticsText("permissions.json", diagnostics),
			};
		for (const warning of diagnostics.filter((item) => item.level === "warning"))
			console.warn(diagnosticsText("permissions.json", [warning]));
		const arrays = ["allow", "deny", "ask"] as const;
		for (const key of arrays) {
			if (parsed[key] !== undefined && !Array.isArray(parsed[key])) {
				return { ...EMPTY_RULES, valid: false, error: `${key} must be an array` };
			}
		}
		return {
			allow: Array.isArray(parsed.allow) ? (parsed.allow as string[]) : [],
			deny: Array.isArray(parsed.deny) ? (parsed.deny as string[]) : [],
			ask: Array.isArray(parsed.ask) ? (parsed.ask as string[]) : [],
			valid: true,
		};
	} catch (error: unknown) {
		if (isMissingFile(error)) return EMPTY_RULES;
		return {
			...EMPTY_RULES,
			valid: false,
			error: configError(error),
		};
	}
}

function isMissingFile(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function configError(error: unknown): string {
	if (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof error.code === "string"
	) {
		return `unable to read configuration (${error.code})`;
	}
	return "invalid or unreadable configuration";
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

	pi.on("tool_call", async (event, ctx) => {
		try {
			if (!rules.valid)
				return {
					block: true,
					reason: `invalid permissions.json: ${rules.error ?? "unknown error"}`,
				};
			const input = "input" in event ? (event.input as Record<string, unknown>) : {};
			const policyRules: PolicyRule[] = [
				...rules.allow.map((matcher) => ({
					effect: "allow" as const,
					matcher,
					source: "permissions.json",
				})),
				...rules.deny.map((matcher) => ({
					effect: "deny" as const,
					matcher,
					source: "permissions.json",
				})),
				...rules.ask.map((matcher) => ({
					effect: "ask" as const,
					matcher,
					source: "permissions.json",
				})),
			];
			const decision: ToolPolicyResult = resolvePolicyRules(
				policyRules,
				event.toolName,
				input,
				ctx.cwd,
			);
			if (decision.behavior === "deny" || decision.behavior === "ask") {
				return { block: true, reason: decision.reason };
			}
		} catch (error) {
			// A security policy error must not silently become allow.
			return {
				block: true,
				reason: `permissions policy error: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	});
}
