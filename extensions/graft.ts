import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const OFF = process.env.PI_GRAFT_OFF === "1";
const QUERY_TIMEOUT_MS = 3_000;
const MAX_PROMPT_CHARS = 4_000;
const MAX_OUTPUT_CHARS = 12_000;
const MIN_PROMPT_CHARS = 12;
const EDIT_TOOLS = new Set(["edit", "write", "apply_patch", "multiedit"]);

export function shouldRetrieve(prompt: string): boolean {
	const text = prompt.trim();
	return text.length >= MIN_PROMPT_CHARS && !text.startsWith("/");
}

export function truncateOutput(output: string, limit = MAX_OUTPUT_CHARS): string {
	const text = output.trim();
	return text.length <= limit ? text : `${text.slice(0, limit)}\n[graft output truncated]`;
}

export function formatGraftContext(output: string): string | undefined {
	const text = truncateOutput(output);
	return text ? `<graft-context>\n${text}\n</graft-context>` : undefined;
}

function setStatus(ctx: ExtensionContext | undefined, text: string): void {
	try {
		if (ctx?.hasUI) ctx.ui.setStatus("pi-graft", text);
	} catch {
		// Optional status UI must never affect the turn.
	}
}

function askGraft(prompt: string, cwd: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		let settled = false;
		let stdout = "";
		let child;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (value?: string) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve(value);
		};

		try {
			child = spawn("graft", ["ask", prompt.slice(0, MAX_PROMPT_CHARS), "--source", "-n", "6"], {
				cwd,
				stdio: ["ignore", "pipe", "ignore"],
			});
		} catch {
			finish();
			return;
		}

		child.stdout?.on("data", (chunk: Buffer | string) => {
			if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk.toString();
			if (stdout.length >= MAX_OUTPUT_CHARS) child.kill();
		});
		child.once("error", () => finish());
		child.once("close", (code) => finish(code === 0 ? stdout : undefined));
		timer = setTimeout(() => {
			child.kill();
			finish();
		}, QUERY_TIMEOUT_MS);
	});
}

export default function graft(pi: ExtensionAPI): void {
	if (OFF) return;

	pi.on("session_start", async (_event, ctx) => {
		setStatus(ctx, "graft: ready");
	});

	pi.on("before_agent_start", async (event: any, ctx?: ExtensionContext) => {
		try {
			if (ctx?.mode === "json" || ctx?.mode === "print") return;
			const prompt = typeof event?.prompt === "string" ? event.prompt : "";
			if (!shouldRetrieve(prompt)) return;

			setStatus(ctx, "graft: querying");
			const output = await askGraft(prompt, ctx?.cwd ?? process.cwd());
			const context = output ? formatGraftContext(output) : undefined;
			if (!context) {
				setStatus(ctx, "graft: unavailable");
				return;
			}
			setStatus(ctx, "graft: ready");
			return {
				systemPrompt: `${typeof event?.systemPrompt === "string" ? event.systemPrompt : ""}\n\n${context}`,
			};
		} catch {
			setStatus(ctx, "graft: unavailable");
			// Retrieval is advisory. Never turn a Graft failure into a Pi failure.
			return;
		}
	});

	pi.on("tool_execution_end", async (event: any, ctx?: ExtensionContext) => {
		try {
			if (EDIT_TOOLS.has(String(event?.toolName ?? "").toLowerCase())) {
				setStatus(ctx, "graft: changes pending");
			}
		} catch {
			// Optional freshness status must never affect the turn.
		}
	});
}
