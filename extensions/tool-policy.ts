/** Shared, conservative policy primitives for Pi tool calls.
 *
 * The Pi extension API can only block a tool call (and handlers mutate input in
 * place), so this module keeps the richer Claude-style decision separate from
 * the small adapter returned by individual extensions.
 */
import { createHash } from "node:crypto";
import { isAbsolute, normalize, resolve } from "node:path";

export type ToolPolicyBehavior = "allow" | "deny" | "ask" | "passthrough";

export type ToolPolicyResult =
	| { behavior: "allow"; updatedInput?: unknown; reason?: string; source?: string }
	| { behavior: "deny"; reason: string; source?: string }
	| { behavior: "ask"; reason: string; source?: string }
	| { behavior: "passthrough" };

export type PolicyRuleEffect = "allow" | "deny" | "ask";
export interface PolicyRule {
	effect: PolicyRuleEffect;
	matcher: string;
	source?: string;
}

const PATH_FIELDS = new Set(["path", "file_path", "notebook_path"]);
const PATH_TOOLS = new Set(["read", "write", "edit", "ls", "find", "grep"]);

export function normalizePath(value: string, cwd = process.cwd()): string {
	const expanded = value
		.replace(/^~(?=\/|$)/, process.env.HOME ?? "~")
		.replace(/^\$(?:HOME|\{HOME\})(?=\/|$)/, process.env.HOME ?? "$HOME");
	return normalize(isAbsolute(expanded) ? expanded : resolve(cwd, expanded));
}

export function normalizedInput(
	toolName: string,
	input: Record<string, unknown>,
	cwd = process.cwd(),
): Record<string, unknown> {
	if (!PATH_TOOLS.has(toolName)) return input;
	const result = { ...input };
	for (const key of PATH_FIELDS) {
		if (typeof result[key] === "string") result[key] = normalizePath(result[key], cwd);
	}
	return result;
}

function primarySubject(toolName: string, input: Record<string, unknown>): string | undefined {
	if (toolName === "bash" || toolName === "powershell")
		return typeof input.command === "string" ? input.command : undefined;
	if (toolName === "grep" || toolName === "find")
		return typeof input.pattern === "string" ? input.pattern : undefined;
	if (PATH_TOOLS.has(toolName)) {
		const value = input.path ?? input.file_path ?? input.notebook_path;
		return typeof value === "string" ? value : undefined;
	}
	return undefined;
}

function globToRegExp(glob: string): RegExp {
	const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`);
}

export function parsePolicyRule(
	rule: string,
	effect: PolicyRuleEffect,
	source?: string,
): PolicyRule | undefined {
	const matcher = rule.trim();
	return matcher ? { effect, matcher, source } : undefined;
}

export function ruleMatches(
	rule: string,
	toolName: string,
	input: Record<string, unknown>,
	cwd = process.cwd(),
): boolean {
	const parsed = /^([^()]+)(?:\((.*)\))?$/.exec(rule.trim());
	if (!parsed || parsed[1].trim() !== toolName) return false;
	if (parsed[2] === undefined) return true;
	const matcher = globToRegExp(parsed[2]);
	const rawSubject = primarySubject(toolName, input);
	const rawPathTool = new Set(["read", "write", "edit", "ls"]).has(toolName);
	if (
		rawSubject !== undefined &&
		(!rawPathTool || !isAbsolute(rawSubject)) &&
		matcher.test(rawSubject)
	)
		return true;
	const subject = primarySubject(toolName, normalizedInput(toolName, input, cwd));
	return subject !== undefined && matcher.test(subject);
}

function specificity(rule: string): number {
	const match = /^([^()]+)(?:\((.*)\))?$/.exec(rule.trim());
	if (!match) return -1;
	return match[1].length + (match[2] ? match[2].replace(/\*/g, "").length * 2 + 1 : 0);
}

/** Resolve static rules. A narrow deny/ask beats a broad allow. */
export function resolvePolicyRules(
	rules: readonly PolicyRule[],
	toolName: string,
	input: Record<string, unknown>,
	cwd = process.cwd(),
): ToolPolicyResult {
	const matches = rules
		.filter((rule) => ruleMatches(rule.matcher, toolName, input, cwd))
		.sort((a, b) => specificity(b.matcher) - specificity(a.matcher));
	const selected = matches[0];
	if (!selected) return { behavior: "passthrough" };
	if (selected.effect === "allow") return { behavior: "allow", source: selected.source };
	return {
		behavior: selected.effect,
		reason: `${selected.effect} by ${selected.source ?? "policy"} rule "${selected.matcher}"`,
		source: selected.source,
	};
}

export interface ToolPolicyRequest {
	toolName: string;
	input: Record<string, unknown>;
	cwd?: string;
	rules?: readonly PolicyRule[];
	checks?: readonly (() => ToolPolicyResult | undefined)[];
}

export function evaluateToolPolicy(request: ToolPolicyRequest): ToolPolicyResult {
	for (const check of request.checks ?? []) {
		const result = check();
		if (result && result.behavior !== "passthrough") return result;
	}
	return resolvePolicyRules(request.rules ?? [], request.toolName, request.input, request.cwd);
}

export function hashPolicyInput(input: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(input) ?? "null")
		.digest("hex");
}

export interface PolicyAuditRecord {
	sessionId?: string;
	runId?: string;
	agentId?: string;
	toolName: string;
	inputHash: string;
	decision: ToolPolicyBehavior;
	source?: string;
	reason?: string;
	updatedInput?: boolean;
	latencyMs?: number;
}

export function makePolicyAuditRecord(
	value: Omit<PolicyAuditRecord, "inputHash"> & { input: unknown },
): PolicyAuditRecord {
	const { input, ...record } = value;
	return { ...record, inputHash: hashPolicyInput(input) };
}

export const __test = { globToRegExp, primarySubject, specificity };
