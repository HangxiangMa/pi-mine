/**
 * Refuse unbounded reads of files whose result is guaranteed to be truncated or
 * is already an offloaded tool result. This is a safety valve, not a general
 * output-size policy: other tools remain unchanged and every guard failure opens.
 */

import { statSync } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

export const BIG_FILE_BYTES = 2 * 1024 * 1024;
export const TOOL_RESULT_BYTES = 32 * 1024;

const BINARY_EXTENSIONS = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".bmp",
	".ico",
	".tif",
	".tiff",
	".heic",
	".avif",
	".pdf",
	".svg",
	".ipynb",
]);

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SKILL_HINT =
	"Use the /log-triage skill: python3 ~/.pi/agent/skills/log-triage/scripts/logslice.py profile|grep|window|sweep <path>";

function disabled(): boolean {
	return ["1", "true", "yes", "on", "off"].includes(
		(process.env.PI_READ_GUARD_OFF ?? "").trim().toLowerCase(),
	);
}

function humanBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isToolResultPath(filePath: string): boolean {
	const parent = dirname(filePath);
	if (basename(parent) !== "tool-results" || !filePath.toLowerCase().endsWith(".txt")) return false;
	const holder = basename(dirname(parent));
	return SESSION_ID.test(holder) || filePath.split("/").includes("projects");
}

function hasBound(input: Record<string, unknown>): boolean {
	return (
		(input.limit !== undefined && input.limit !== null) ||
		(input.pages !== undefined && input.pages !== null)
	);
}

export function readGuardReason(
	toolName: string,
	input: Record<string, unknown>,
): string | undefined {
	if (toolName !== "read") return undefined;
	const filePath = input.path;
	if (typeof filePath !== "string" || !filePath || !isAbsolute(filePath)) return undefined;
	if (BINARY_EXTENSIONS.has(filePath.slice(filePath.lastIndexOf(".")).toLowerCase()))
		return undefined;
	if (hasBound(input)) return undefined;

	let size: number;
	try {
		const stat = statSync(filePath);
		if (!stat.isFile()) return undefined;
		size = stat.size;
	} catch {
		return undefined;
	}

	if (isToolResultPath(filePath) && size > TOOL_RESULT_BYTES) {
		return `This is offloaded tool output (${humanBytes(size)}) that the client already truncated once for being too large -- reading it whole undoes that. Re-run with limit (and offset), or grep it for what you need: grep -n <pattern> ${filePath}`;
	}
	if (size > BIG_FILE_BYTES) {
		return `${basename(filePath)} is ${humanBytes(size)}. An unbounded read will be truncated and cost a turn. Pass limit (with offset) to read a slice, or grep for an anchor first. For a log or dump: ${SKILL_HINT}`;
	}
	return undefined;
}

export default function readGuard(pi: ExtensionAPI): void {
	if (disabled()) return;
	pi.on("tool_call", async (event) => {
		try {
			if (!isToolCallEventType("read", event)) return;
			const reason = readGuardReason(event.toolName, event.input as Record<string, unknown>);
			if (reason) return { block: true, reason };
		} catch {
			// fail open: guard errors must never block ordinary reads
		}
	});
}

export const __test = { humanBytes, isToolResultPath, hasBound };
