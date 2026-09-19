/** Structured handoff between scout/reason/execute chain stages. */

export type PacketConfidence = "confirmed" | "inferred" | "unverified";
export type VerificationStatus = "pass" | "fail" | "blocked" | "partial";

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
`;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
