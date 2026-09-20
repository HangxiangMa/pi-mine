import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setGraftStatus } from "./thinking-profiles.ts";

const OFF = process.env.PI_GRAFT_OFF === "1";
const QUERY_TIMEOUT_MS = 3_000;
const BUILD_TIMEOUT_MS = 30_000;
const MAX_PROMPT_CHARS = 4_000;
const MAX_OUTPUT_CHARS = 12_000;
const MIN_PROMPT_CHARS = 12;
const EDIT_TOOLS = new Set(["edit", "write", "apply_patch", "multiedit"]);
const PI_SKILL_RELATIVE_PATH = join(".pi", "skills", "graft", "SKILL.md");
const GRAFT_SKILL_FALLBACK = `---
name: graft
description: Use Graft's local code graph to understand, locate, trace, and scope changes before reading source files.
---

# Graft

Use the local Graft graph for repository understanding. Prefer one focused command before broad source inspection:

- \`graft ask "<question>" --source\` for conceptual or locational questions.
- \`graft grep "<pattern>"\` for exhaustive symbol or text search.
- \`graft skeleton <file>\` for a file API overview.
- \`graft callers <symbol> --depth 2\` for call relationships and blast radius.
- \`graft map\` for repository orientation.
- \`graft check\` to verify graph freshness.

Run \`/graft-init\` once in a repository to build the graph and install this Pi skill. Graft is advisory: if it is unavailable or stale, continue with Pi's normal tools.
`;

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

type GraftResult = { code: number | null; stdout: string; stderr: string };

function runGraft(args: string[], cwd: string, timeoutMs: number): Promise<GraftResult> {
	return new Promise((resolve) => {
		let settled = false;
		let stdout = "";
		let stderr = "";
		let child;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (value: GraftResult) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve(value);
		};

		try {
			child = spawn("graft", args, {
				cwd,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch {
			finish({ code: null, stdout, stderr });
			return;
		}

		child.stdout?.on("data", (chunk: Buffer | string) => {
			if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk.toString();
			if (stdout.length >= MAX_OUTPUT_CHARS) child.kill();
		});
		child.stderr?.on("data", (chunk: Buffer | string) => {
			if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk.toString();
		});
		child.once("error", () => finish({ code: null, stdout, stderr }));
		child.once("close", (code) => finish({ code, stdout, stderr }));
		timer = setTimeout(() => {
			child.kill();
			finish({ code: null, stdout, stderr });
		}, timeoutMs);
	});
}

async function askGraft(prompt: string, cwd: string): Promise<string | undefined> {
	const result = await runGraft(
		["ask", prompt.slice(0, MAX_PROMPT_CHARS), "--source", "-n", "6"],
		cwd,
		QUERY_TIMEOUT_MS,
	);
	return result.code === 0 ? result.stdout : undefined;
}

export function hasPiSkill(cwd: string): boolean {
	return existsSync(join(cwd, PI_SKILL_RELATIVE_PATH));
}

export function installPiSkill(cwd: string): string {
	const destination = join(cwd, PI_SKILL_RELATIVE_PATH);
	const sourceCandidates = [
		join(cwd, ".claude", "skills", "graft", "SKILL.md"),
		join(cwd, ".agents", "skills", "graft", "SKILL.md"),
	];
	const source = sourceCandidates.find((candidate) => existsSync(candidate));
	mkdirSync(join(cwd, ".pi", "skills", "graft"), { recursive: true });
	writeFileSync(destination, source ? readFileSync(source) : GRAFT_SKILL_FALLBACK);
	return destination;
}

export default function graft(pi: ExtensionAPI): void {
	if (OFF) return;

	pi.registerCommand("graft-init", {
		description: "Build Graft and install its repository skill for Pi",
		handler: async (args, ctx) => {
			const options = args.trim();
			if (options && options !== "--no-build") {
				ctx.ui.notify("Usage: /graft-init [--no-build]", "warning");
				return;
			}
			try {
				setGraftStatus(ctx, "graft: installing");
				if (options !== "--no-build") {
					const result = await runGraft(["build"], ctx.cwd, BUILD_TIMEOUT_MS);
					if (result.code !== 0) {
						setGraftStatus(ctx, "graft: unavailable");
						ctx.ui.notify(result.stderr.trim() || "graft build failed", "warning");
						return;
					}
				}
				const destination = installPiSkill(ctx.cwd);
				setGraftStatus(ctx, "graft: ready");
				ctx.ui.notify(`Installed Pi Graft skill at ${destination}`, "info");
			} catch (error) {
				setGraftStatus(ctx, "graft: unavailable");
				ctx.ui.notify(
					error instanceof Error ? error.message : "Could not install Pi Graft skill",
					"warning",
				);
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		setGraftStatus(ctx, hasPiSkill(ctx.cwd) ? "graft: ready" : "graft: run /graft-init");
	});

	pi.on("before_agent_start", async (event: any, ctx?: ExtensionContext) => {
		try {
			if (ctx?.mode === "json" || ctx?.mode === "print") return;
			const prompt = typeof event?.prompt === "string" ? event.prompt : "";
			if (!shouldRetrieve(prompt)) return;

			setGraftStatus(ctx, "graft: querying");
			const output = await askGraft(prompt, ctx?.cwd ?? process.cwd());
			const context = output ? formatGraftContext(output) : undefined;
			if (!context) {
				setGraftStatus(ctx, "graft: unavailable");
				return;
			}
			setGraftStatus(ctx, "graft: ready");
			return {
				systemPrompt: `${typeof event?.systemPrompt === "string" ? event.systemPrompt : ""}\n\n${context}`,
			};
		} catch {
			setGraftStatus(ctx, "graft: unavailable");
			// Retrieval is advisory. Never turn a Graft failure into a Pi failure.
			return;
		}
	});

	pi.on("tool_execution_end", async (event: any, ctx?: ExtensionContext) => {
		try {
			if (EDIT_TOOLS.has(String(event?.toolName ?? "").toLowerCase())) {
				setGraftStatus(ctx, "graft: changes pending");
			}
		} catch {
			// Optional freshness status must never affect the turn.
		}
	});
}
