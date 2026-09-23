import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setGraftStatus } from "./thinking-profiles.ts";

const OFF = process.env.PI_GRAFT_OFF === "1";
const QUERY_TIMEOUT_MS = 3_000;
// Large vendor trees can take several minutes; keep the UI alive with progress
// updates instead of treating normal parsing as a failed 30-second request.
const BUILD_TIMEOUT_MS = 10 * 60_000;
const MAX_PROMPT_CHARS = 4_000;
const MAX_OUTPUT_CHARS = 12_000;
const MIN_PROMPT_CHARS = 12;
const EDIT_TOOLS = new Set(["edit", "write", "apply_patch", "multiedit"]);
const PI_SKILL_RELATIVE_PATH = join(".pi", "skills", "graft", "SKILL.md");
const REVISION_FILE = join("graft", ".pi-revision");
const execFileAsync = promisify(execFile);
const initPrompted = new Set<string>();

/** Keep the parent graph isolated unless the repo explicitly opted into recursion. */
export function buildArgsFor(cwd: string): string[] {
	let config: { followSubmodules?: boolean; followNestedRepos?: boolean } = {};
	try {
		config = JSON.parse(readFileSync(join(cwd, ".graft", "config.json"), "utf8"));
	} catch {
		// Missing or malformed local state gets the safe, isolated default.
	}
	const args = ["build"];
	if (config.followSubmodules !== true) args.push("--no-follow-submodules");
	if (config.followNestedRepos !== true) args.push("--no-follow-nested-repos");
	return args;
}

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

The default build keeps Git submodules and nested repositories out of the parent graph. This avoids indexing vendor repositories twice; use \`--follow-submodules\` (and, for a skipped \`vendor/\` tree, an explicit \`--include-dir vendor\`) only when an aggregate graph is intentional.

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
type GraftOutput = (stream: "stdout" | "stderr", chunk: string) => void;

export function formatBuildProgress(text: string): string | undefined {
	const line = text
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!line) return undefined;
	return line.length <= 180 ? line : `${line.slice(0, 177)}...`;
}

function runGraft(
	args: string[],
	cwd: string,
	timeoutMs: number,
	onOutput?: GraftOutput,
): Promise<GraftResult> {
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
			const text = chunk.toString();
			onOutput?.("stdout", text);
			if (stdout.length < MAX_OUTPUT_CHARS) stdout += text;
			if (stdout.length >= MAX_OUTPUT_CHARS) child.kill();
		});
		child.stderr?.on("data", (chunk: Buffer | string) => {
			const text = chunk.toString();
			onOutput?.("stderr", text);
			if (stderr.length < MAX_OUTPUT_CHARS) stderr += text;
		});
		child.once("error", () => finish({ code: null, stdout, stderr }));
		child.once("close", (code) => finish({ code, stdout, stderr }));
		timer = setTimeout(() => {
			child.kill();
			finish({ code: null, stdout, stderr });
		}, timeoutMs);
	});
}

async function currentRevision(cwd: string): Promise<string | undefined> {
	try {
		const result = await execFileAsync("git", ["rev-parse", "HEAD"], {
			cwd,
			encoding: "utf8",
			timeout: QUERY_TIMEOUT_MS,
		});
		const revision = String(result.stdout).trim();
		return revision || undefined;
	} catch {
		return undefined;
	}
}

function recordRevision(cwd: string, revision: string | undefined): void {
	if (!revision) return;
	try {
		mkdirSync(join(cwd, "graft"), { recursive: true });
		writeFileSync(join(cwd, REVISION_FILE), `${revision}\n`);
	} catch {
		// A read-only cache must not make an otherwise successful build fail.
	}
}

function buildProgress(ctx: ExtensionContext | undefined): GraftOutput | undefined {
	if (!ctx?.hasUI) return undefined;
	let pending = "";
	return (_stream, chunk) => {
		pending += chunk;
		const lines = pending.split(/[\r\n]+/);
		pending = lines.pop() ?? "";
		const line = formatBuildProgress(lines.at(-1) ?? pending);
		if (line) setGraftStatus(ctx, `graft: building · ${line}`);
	};
}

async function buildGraft(cwd: string, ctx?: ExtensionContext): Promise<boolean> {
	const result = await runGraft(buildArgsFor(cwd), cwd, BUILD_TIMEOUT_MS, buildProgress(ctx));
	if (result.code !== 0) return false;
	recordRevision(cwd, await currentRevision(cwd));
	return true;
}

async function ensureFresh(cwd: string, ctx?: ExtensionContext): Promise<boolean> {
	const revision = await currentRevision(cwd);
	if (!revision) return true;

	const cached = (() => {
		try {
			return readFileSync(join(cwd, REVISION_FILE), "utf8").trim();
		} catch {
			return "";
		}
	})();
	if (cached === revision) return true;
	return buildGraft(cwd, ctx);
}

async function askGraft(prompt: string, cwd: string): Promise<string | undefined> {
	const result = await runGraft(
		["ask", prompt.slice(0, MAX_PROMPT_CHARS), "--source", "-n", "6"],
		cwd,
		QUERY_TIMEOUT_MS,
	);
	return result.code === 0 ? result.stdout : undefined;
}

export function shouldRetrieveSubagent(prompt: string): boolean {
	const text = prompt.trim();
	return (
		text.length >= 24 &&
		!text.startsWith("/") &&
		/(code|source|file|function|symbol|caller|call graph|trace|implement|debug|bug|flow|locate|repository|repo|refactor|test)/i.test(
			text,
		)
	);
}

/** Query an already-built graph for a child dispatch; never builds synchronously. */
export async function retrieveGraftContext(
	prompt: string,
	cwd: string,
): Promise<string | undefined> {
	if (!shouldRetrieveSubagent(prompt) || !hasPiSkill(cwd)) return undefined;
	const revision = await currentRevision(cwd);
	if (revision) {
		try {
			if (readFileSync(join(cwd, REVISION_FILE), "utf8").trim() !== revision) return undefined;
		} catch {
			return undefined;
		}
	}
	return formatGraftContext((await askGraft(prompt, cwd)) ?? "");
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

async function confirmInitialization(
	cwd: string,
	ctx: ExtensionContext | undefined,
): Promise<boolean> {
	if (hasPiSkill(cwd)) return true;
	if (initPrompted.has(cwd)) return false;
	initPrompted.add(cwd);
	if (!ctx?.hasUI || !ctx.ui?.confirm) return false;
	const approved = await ctx.ui.confirm(
		"Initialize Graft for this repository?",
		"Graft will build an isolated local code graph and install the Pi skill. Choose No to skip it for this session.",
	);
	if (!approved) return false;
	setGraftStatus(ctx, "graft: installing");
	if (!(await buildGraft(cwd, ctx))) {
		setGraftStatus(ctx, "graft: unavailable");
		return false;
	}
	installPiSkill(cwd);
	return true;
}

export default function graft(pi: ExtensionAPI): void {
	if (OFF) return;

	pi.registerCommand("graft-init", {
		description: "Build an isolated Graft graph and install its repository skill for Pi",
		handler: async (args, ctx) => {
			const options = args.trim();
			if (options && options !== "--no-build") {
				ctx.ui.notify("Usage: /graft-init [--no-build]", "warning");
				return;
			}
			try {
				setGraftStatus(ctx, "graft: installing");
				if (options !== "--no-build") {
					const result = await runGraft(
						buildArgsFor(ctx.cwd),
						ctx.cwd,
						BUILD_TIMEOUT_MS,
						buildProgress(ctx),
					);
					if (result.code !== 0) {
						setGraftStatus(ctx, "graft: unavailable");
						ctx.ui.notify(result.stderr.trim() || "graft build failed", "warning");
						return;
					}
					recordRevision(ctx.cwd, await currentRevision(ctx.cwd));
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

			const cwd = ctx?.cwd ?? process.cwd();
			if (!(await confirmInitialization(cwd, ctx))) {
				setGraftStatus(ctx, "graft: skipped");
				return;
			}
			setGraftStatus(ctx, "graft: checking");
			if (!(await ensureFresh(cwd, ctx))) {
				setGraftStatus(ctx, "graft: unavailable");
				return;
			}
			setGraftStatus(ctx, "graft: querying");
			const output = await askGraft(prompt, cwd);
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
