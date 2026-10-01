/** Structured handoff between scout/reason/execute chain stages. */

import { isAbsolute, normalize, relative } from "node:path";

export type PacketConfidence = "confirmed" | "inferred" | "unverified";
export type VerificationStatus = "pass" | "fail" | "blocked" | "partial";
export type TaskControlStatus =
	| "running"
	| "rework"
	| "takeover-ready"
	| "lead-writing"
	| "verifying"
	| "done"
	| "needs-user-decision";

export interface AcceptanceSpec {
	command: string;
	cwd?: string;
	timeoutMs?: number;
}

export interface TaskControl {
	version: 1;
	taskId?: string;
	allowedPaths: string[];
	acceptance: AcceptanceSpec[];
	maxRework: number;
	maxLeadSubmissions: number;
	allowTakeover: boolean;
}

export interface TaskAttempt {
	kind: "worker" | "rework" | "takeover";
	status: VerificationStatus | "error" | "blocked";
	reason?: string;
	at: number;
}

export interface TakeoverLease {
	owner: string;
	acquiredAt: number;
	expiresAt: number;
}

export interface TaskState {
	schema: 1;
	taskId: string;
	revision: number;
	status: TaskControlStatus;
	goal: string;
	cwd: string;
	control: TaskControl;
	reworkCount: number;
	leadSubmissions: number;
	attempts: TaskAttempt[];
	lease?: TakeoverLease;
	updatedAt: number;
	/** Workspace paths already dirty when the controlled task was created. */
	workspaceBaseline?: string[];
}

export interface AgentRuntimePolicy {
	cwd: string;
	isolation: "none" | "worktree";
	permissionMode: "default" | "plan" | "acceptEdits";
	allowedTools?: string[];
	deniedTools?: string[];
	/** Internal only; public routed tool schemas omit MCP until a lifecycle is wired. */
	mcpServers?: string[];
}

export function normalizeAgentRuntimePolicy(
	value: unknown,
	defaultCwd = process.cwd(),
): AgentRuntimePolicy {
	const raw = isRecord(value) ? value : {};
	const list = (item: unknown): string[] | undefined => {
		if (!Array.isArray(item)) return undefined;
		return item
			.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
			.map((entry) => entry.trim());
	};
	return {
		cwd: typeof raw.cwd === "string" && raw.cwd.trim() ? raw.cwd : defaultCwd,
		isolation: raw.isolation === "worktree" ? "worktree" : "none",
		permissionMode:
			raw.permissionMode === "plan" || raw.permissionMode === "acceptEdits"
				? raw.permissionMode
				: "default",
		allowedTools: list(raw.allowedTools),
		deniedTools: list(raw.deniedTools),
		mcpServers: list(raw.mcpServers),
	};
}

export interface PacketEvidence {
	location: string;
	fact: string;
	confidence: PacketConfidence;
}

export interface PacketStep {
	id: string;
	action: string;
	files: string[];
	acceptance?: string[];
	contract?: string;
}

export interface TaskPacket {
	version: 1;
	goal: string;
	runtimePolicy?: AgentRuntimePolicy;
	control?: TaskControl;
	scope: string[];
	constraints: string[];
	evidence: PacketEvidence[];
	decision?: {
		summary: string;
		rationale: string;
	};
	steps: PacketStep[];
	tests: string[];
	risks: string[];
	unknowns: string[];
	coverage: string;
}

/** Machine-readable terminal result sent back to the parent agent and task UI. */
export interface RoutedResultContract {
	version: 1;
	status: "done" | "error";
	mode: "single" | "parallel" | "chain";
	summary: string;
	stages: Array<{ agent: string; status: "done" | "error"; summary: string }>;
	control?: {
		taskId: string;
		status: TaskControlStatus;
		takeoverReady: boolean;
		reason?: string;
	};
}

export const MAX_HANDOFF_TOKENS = 3000;
export const MAX_HANDOFF_CHARS = MAX_HANDOFF_TOKENS * 4;

export const HANDOFF_CONTRACT = `

--- Handoff contract (injected by subagent-model-router) ---
This is an intermediate result for another agent, not a human report.
If this step gathers evidence or makes a plan, include one fenced JSON block:
\`\`\`task-packet
{"version":1,"goal":"...","scope":[],"constraints":[],"evidence":[{"location":"path:line","fact":"...","confidence":"confirmed|inferred|unverified"}],"decision":{"summary":"...","rationale":"..."},"steps":[{"id":"1","action":"...","files":["path:line"],"acceptance":[],"contract":"..."}],"tests":[],"risks":[],"unknowns":[],"coverage":"searched ...; did not check ..."}
\`\`\`
Keep the packet within roughly 1-3k tokens. Never invent anchors. If evidence is incomplete, put it in unknowns and coverage.
If a controlled task is present, report VERIFICATION_STATUS and the unmet acceptance conditions, but never claim that Lead takeover is authorized; only the Host control state can authorize it.
`;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function isSafeTaskId(value: unknown): value is string {
	return typeof value === "string" && SAFE_TASK_ID.test(value);
}

function normalizeAllowedPath(value: unknown, cwd: string): string | undefined {
	if (typeof value !== "string" || !value.trim() || isAbsolute(value)) return undefined;
	const normalized = normalize(value.trim());
	const resolved = relative(cwd, `${cwd}/${normalized}`);
	if (!resolved || resolved === ".." || resolved.startsWith(`..${"/"}`) || isAbsolute(resolved))
		return undefined;
	return normalized;
}

function parseAcceptance(value: unknown): AcceptanceSpec[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		if (typeof item === "string" && item.trim()) return [{ command: item.trim() }];
		if (!isRecord(item) || typeof item.command !== "string" || !item.command.trim()) return [];
		const spec: AcceptanceSpec = { command: item.command.trim() };
		if (typeof item.cwd === "string" && item.cwd.trim()) spec.cwd = item.cwd.trim();
		if (typeof item.timeoutMs === "number" && Number.isFinite(item.timeoutMs) && item.timeoutMs > 0)
			spec.timeoutMs = Math.floor(item.timeoutMs);
		return [spec];
	});
}

export function isTaskControlRequested(value: unknown): boolean {
	return isRecord(value) && value.allowTakeover === true;
}

export function normalizeTaskControl(value: unknown, cwd = process.cwd()): TaskControl | undefined {
	if (!isRecord(value)) return undefined;
	const allowedPaths = Array.isArray(value.allowedPaths)
		? Array.from(
				new Set(
					value.allowedPaths.flatMap((item) => {
						const normalized = normalizeAllowedPath(item, cwd);
						return normalized ? [normalized] : [];
					}),
				),
			)
		: [];
	const acceptance = parseAcceptance(value.acceptance);
	const maxRework =
		typeof value.maxRework === "number" && Number.isFinite(value.maxRework)
			? Math.max(0, Math.min(8, Math.floor(value.maxRework)))
			: 2;
	const maxLeadSubmissions =
		typeof value.maxLeadSubmissions === "number" && Number.isFinite(value.maxLeadSubmissions)
			? Math.max(1, Math.min(8, Math.floor(value.maxLeadSubmissions)))
			: 3;
	const taskId =
		typeof value.taskId === "string" && value.taskId.trim() ? value.taskId.trim() : undefined;
	const validTaskId = taskId === undefined || isSafeTaskId(taskId);
	return {
		version: 1,
		taskId: validTaskId ? taskId : undefined,
		allowedPaths,
		acceptance,
		maxRework,
		maxLeadSubmissions,
		allowTakeover:
			value.allowTakeover === true &&
			validTaskId &&
			allowedPaths.length > 0 &&
			acceptance.length > 0,
	};
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((item): item is string => typeof item === "string" && item.trim() !== "")
		.map((item) => item.trim());
}

function confidence(value: unknown): PacketConfidence {
	return value === "confirmed" || value === "inferred" || value === "unverified"
		? value
		: "unverified";
}

function parseStep(value: unknown, index: number): PacketStep | undefined {
	if (!isRecord(value)) return undefined;
	const action = stringValue(value.action);
	if (!action) return undefined;
	return {
		id: stringValue(value.id) ?? String(index + 1),
		action,
		files: stringArray(value.files),
		acceptance: stringArray(value.acceptance),
		contract: stringValue(value.contract),
	};
}

function parseEvidence(value: unknown): PacketEvidence[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		if (!isRecord(item)) return [];
		const location = stringValue(item.location);
		const fact = stringValue(item.fact);
		return location && fact ? [{ location, fact, confidence: confidence(item.confidence) }] : [];
	});
}

function fromUnknown(value: unknown): TaskPacket | undefined {
	if (!isRecord(value) || value.version !== 1) return undefined;
	const goal = stringValue(value.goal);
	const coverage = stringValue(value.coverage);
	const rawSteps = Array.isArray(value.steps)
		? value.steps
		: Array.isArray(value.plan)
			? value.plan
			: [];
	const steps = rawSteps.flatMap((item, index) => {
		const step = parseStep(item, index);
		return step ? [step] : [];
	});
	if (!goal || !coverage || steps.length === 0) return undefined;

	const rawDecision = isRecord(value.decision) ? value.decision : undefined;
	const summary = rawDecision ? stringValue(rawDecision.summary) : undefined;
	const rationale = rawDecision ? stringValue(rawDecision.rationale) : undefined;
	return {
		version: 1,
		goal,
		runtimePolicy: value.runtimePolicy
			? normalizeAgentRuntimePolicy(value.runtimePolicy)
			: undefined,
		control: value.control
			? normalizeTaskControl(value.control, normalizeAgentRuntimePolicy(value.runtimePolicy).cwd)
			: undefined,
		scope: stringArray(value.scope),
		constraints: stringArray(value.constraints),
		evidence: parseEvidence(value.evidence),
		decision: summary && rationale ? { summary, rationale } : undefined,
		steps,
		tests: stringArray(value.tests),
		risks: stringArray(value.risks),
		unknowns: stringArray(value.unknowns),
		coverage,
	};
}

/** Parse the first fenced task-packet JSON block. */
export function parseTaskPacket(text: string): TaskPacket | undefined {
	const match = /```task-packet\s*([\s\S]*?)```/i.exec(text);
	if (!match) return undefined;
	try {
		return fromUnknown(JSON.parse(match[1]));
	} catch {
		return undefined;
	}
}

function compact(packet: TaskPacket): string {
	return JSON.stringify(packet);
}

function trimText(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

/** Keep packet structure valid while fitting the bounded handoff budget. */
export function normalizeTaskPacket(packet: TaskPacket, maxChars = MAX_HANDOFF_CHARS): string {
	const result: TaskPacket = JSON.parse(JSON.stringify(packet)) as TaskPacket;
	const fallbackStep: PacketStep = result.steps[0] ?? {
		id: "1",
		action: "Review handoff plan",
		files: [],
	};
	if (result.steps.length === 0) result.steps.push(fallbackStep);
	const optionalArrays: Array<keyof TaskPacket> = [
		"evidence",
		"risks",
		"unknowns",
		"tests",
		"scope",
		"constraints",
	];
	while (compact(result).length > maxChars) {
		let changed = false;
		for (const key of optionalArrays) {
			const value = result[key];
			if (Array.isArray(value) && value.length > 0) {
				value.pop();
				changed = true;
				break;
			}
		}
		if (changed) continue;
		if (result.steps.length > 1) {
			result.steps.pop();
			continue;
		}
		result.goal = trimText(result.goal, 400);
		result.coverage = trimText(result.coverage, 800);
		result.steps[0].action = trimText(result.steps[0].action, 800);
		result.steps[0].files = result.steps[0].files.slice(0, 8).map((file) => trimText(file, 180));
		if (result.decision) {
			result.decision.summary = trimText(result.decision.summary, 500);
			result.decision.rationale = trimText(result.decision.rationale, 700);
		}
		break;
	}
	if (compact(result).length <= maxChars) return compact(result);

	// Very small caller-supplied budgets still get valid JSON rather than a sliced,
	// unparsable packet. The normal production budget is 12k characters.
	const minimal: TaskPacket = {
		version: 1,
		goal: trimText(packet.goal, 120),
		runtimePolicy: undefined,
		scope: [],
		constraints: [],
		evidence: [],
		steps: [{ id: "1", action: trimText(fallbackStep.action, 120), files: [] }],
		tests: [],
		risks: [],
		unknowns: [],
		coverage: trimText(packet.coverage, 120),
	};
	while (compact(minimal).length > maxChars) {
		minimal.goal = trimText(minimal.goal, Math.max(1, minimal.goal.length - 10));
		minimal.steps[0].action = trimText(
			minimal.steps[0].action,
			Math.max(1, minimal.steps[0].action.length - 10),
		);
		minimal.coverage = trimText(minimal.coverage, Math.max(1, minimal.coverage.length - 10));
		if (
			minimal.goal.length === 1 &&
			minimal.steps[0].action.length === 1 &&
			minimal.coverage.length === 1
		)
			break;
	}
	return compact(minimal);
}

function boundedRaw(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 100))}\n\n[handoff truncated; inspect source result before relying on omitted details]`;
}

export interface Handoff {
	text: string;
	packetValid: boolean;
	truncated: boolean;
}

/** Prefer a valid packet; otherwise preserve current behavior with a hard bound. */
export function prepareHandoff(text: string, maxChars = MAX_HANDOFF_CHARS): Handoff {
	const packet = parseTaskPacket(text);
	if (packet) {
		const normalized = normalizeTaskPacket(packet, maxChars);
		return { text: normalized, packetValid: true, truncated: normalized.length >= maxChars };
	}
	const bounded = boundedRaw(text, maxChars);
	return { text: bounded, packetValid: false, truncated: bounded !== text };
}

/** Parse only an explicit machine-readable verification marker. */
export function parseVerificationStatus(text: string): VerificationStatus | undefined {
	const match =
		/(?:VERIFICATION_STATUS|verification_status)\s*:\s*(pass|fail|blocked|partial)\b/i.exec(text);
	return match?.[1]?.toLowerCase() as VerificationStatus | undefined;
}
