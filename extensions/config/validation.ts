export type Diagnostic = { level: "error" | "warning"; path: string; message: string };

const HOOK_EVENTS = new Set([
	"session_start",
	"before_agent_start",
	"tool_call",
	"tool_result",
	"session_before_compact",
	"session_compact",
	"session_compact_failed",
	"notification",
	"agent_settled",
	"session_shutdown",
]);
const POLICY_KEYS = new Set(["version", "allow", "deny", "ask"]);
const HOOK_KEYS = new Set(["version", ...HOOK_EVENTS]);
const TOOL_SUBJECTS = new Set([
	"bash",
	"powershell",
	"read",
	"write",
	"edit",
	"ls",
	"find",
	"grep",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value && typeof value === "object" && !Array.isArray(value));

export function validatePermissionsConfig(input: unknown): Diagnostic[] {
	if (!isRecord(input)) return [{ level: "error", path: "$", message: "must be an object" }];
	const diagnostics: Diagnostic[] = [];
	for (const key of Object.keys(input)) {
		if (!POLICY_KEYS.has(key))
			diagnostics.push({ level: "warning", path: key, message: "unknown field" });
	}
	if (input.version !== undefined && input.version !== 1)
		diagnostics.push({ level: "error", path: "version", message: "must be 1" });
	for (const key of ["allow", "deny", "ask"] as const) {
		const value = input[key];
		if (value === undefined) continue;
		if (!Array.isArray(value)) {
			diagnostics.push({ level: "error", path: key, message: "must be an array" });
			continue;
		}
		for (const [index, matcher] of value.entries()) {
			if (typeof matcher !== "string" || !matcher.trim()) {
				diagnostics.push({
					level: "error",
					path: `${key}[${index}]`,
					message: "must be a non-empty string",
				});
				continue;
			}
			const parsed = /^([^()]+)(?:\((.*)\))?$/.exec(matcher.trim());
			if (!parsed || !parsed[1].trim()) {
				diagnostics.push({ level: "error", path: `${key}[${index}]`, message: "invalid matcher" });
			} else if (parsed[2] !== undefined && !TOOL_SUBJECTS.has(parsed[1].trim())) {
				diagnostics.push({
					level: "warning",
					path: `${key}[${index}]`,
					message: "argument glob is unsupported for this tool",
				});
			}
		}
	}
	return diagnostics;
}

export function validateHooksConfig(input: unknown): Diagnostic[] {
	if (!isRecord(input)) return [{ level: "error", path: "$", message: "must be an object" }];
	const diagnostics: Diagnostic[] = [];
	for (const key of Object.keys(input)) {
		if (!HOOK_KEYS.has(key))
			diagnostics.push({ level: "warning", path: key, message: "unknown event" });
	}
	if (input.version !== undefined && input.version !== 1)
		diagnostics.push({ level: "error", path: "version", message: "must be 1" });
	for (const event of HOOK_EVENTS) {
		const groups = input[event];
		if (groups === undefined) continue;
		if (!Array.isArray(groups)) {
			diagnostics.push({ level: "error", path: event, message: "must be an array" });
			continue;
		}
		for (const [i, group] of groups.entries()) {
			if (!isRecord(group)) {
				diagnostics.push({ level: "error", path: `${event}[${i}]`, message: "must be an object" });
				continue;
			}
			if (group.matcher !== undefined && typeof group.matcher !== "string")
				diagnostics.push({
					level: "error",
					path: `${event}[${i}].matcher`,
					message: "must be a string",
				});
			if (typeof group.matcher === "string") {
				try {
					new RegExp(`^(?:${group.matcher})$`);
				} catch {
					diagnostics.push({
						level: "error",
						path: `${event}[${i}].matcher`,
						message: "invalid regular expression",
					});
				}
			}
			if (!Array.isArray(group.hooks)) {
				diagnostics.push({
					level: "error",
					path: `${event}[${i}].hooks`,
					message: "must be an array",
				});
				continue;
			}
			for (const [j, hook] of group.hooks.entries()) {
				if (
					!isRecord(hook) ||
					hook.type !== "command" ||
					typeof hook.command !== "string" ||
					!hook.command.trim()
				)
					diagnostics.push({
						level: "error",
						path: `${event}[${i}].hooks[${j}]`,
						message: "requires type=command and a non-empty command",
					});
				if (
					isRecord(hook) &&
					hook.timeoutMs !== undefined &&
					(typeof hook.timeoutMs !== "number" || hook.timeoutMs <= 0)
				)
					diagnostics.push({
						level: "error",
						path: `${event}[${i}].hooks[${j}].timeoutMs`,
						message: "must be a positive number",
					});
			}
		}
	}
	return diagnostics;
}

export function hasErrors(diagnostics: Diagnostic[]): boolean {
	return diagnostics.some((diagnostic) => diagnostic.level === "error");
}

export function diagnosticsText(file: string, diagnostics: Diagnostic[]): string {
	return diagnostics.map((d) => `${file}:${d.path}: ${d.level}: ${d.message}`).join("; ");
}
