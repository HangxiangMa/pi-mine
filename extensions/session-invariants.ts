/**
 * Carry mechanical session state across compaction.
 *
 * Pi exposes session_before_compact/session_compact rather than Claude's hook
 * matcher protocol. The pre-compaction event records files touched on the active
 * branch; before_agent_start injects that record exactly once on the next prompt.
 * All persistence is best-effort: a broken carry file must never break compaction
 * or a prompt.
 *
 * The core compaction API does not expose an append-only custom-instructions result
 * (session_before_compact can only cancel or replace the whole compaction). The
 * invariant text below is therefore kept in the carry block and the flag is
 * written before both manual and automatic compaction paths. This preserves the
 * model-visible mechanical state without replacing pi's compaction implementation.
 */

import {
	existsSync,
	readFileSync,
	readdirSync,
	statSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
	renameSync,
	mkdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const MAX_FILES = 14;
export const MAX_CARRY_CHARS = 800;
export const MAX_BLOCK_CHARS = 1400;
export const STALE_DAYS = 7;

const CUT = " [...truncated]";
const EXTENSIONS =
	/\.(?:py|sh|ps1|ts|tsx|js|jsx|c|h|cc|cpp|hpp|rs|go|java|md|json|ya?ml|toml|txt|log|csv)$/i;
export const COMPACT_INSTRUCTIONS =
	"Preserve explicit sections: CONSTRAINTS, RULED OUT, ANCHORS, and DEFINITION OF DONE. Drop tool-call narration and superseded reasoning.";
const COMPACT_SECTION_HINT = `COMPACTION INSTRUCTIONS: ${COMPACT_INSTRUCTIONS}`;

type FileState = { at: number; cwd: string; trigger: string; edited: string[]; read: string[] };

type CarryPayload = FileState;

function off(): boolean {
	return process.env.PI_SESSION_INVARIANTS_OFF === "1";
}

function carryDir(): string {
	return process.env.PI_SESSION_CARRY_DIR || join(getAgentDir(), "session-carry");
}

function safeSessionId(id: string): string {
	const safe = id.replace(/[^a-zA-Z0-9._-]/g, "_");
	return safe || "unknown";
}

function sessionId(ctx: ExtensionContext): string {
	try {
		return ctx.sessionManager.getSessionId();
	} catch {
		return "";
	}
}

function prune(dir: string, keep: string): void {
	const cutoff = Date.now() - STALE_DAYS * 86_400_000;
	try {
		for (const name of readdirSync(dir)) {
			if (name === `${keep}.json` || name === `${keep}.md` || !/\.(?:json|md)$/.test(name))
				continue;
			const file = join(dir, name);
			try {
				if (statSync(file).mtimeMs < cutoff) unlinkSync(file);
			} catch {
				// Another session may have removed it.
			}
		}
	} catch {
		// The directory is created by the caller when needed.
	}
}

function touch(file: string): void {
	try {
		if (existsSync(file)) utimesSync(file, new Date(), new Date());
	} catch {
		// Notes are optional.
	}
}

function asPath(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolvePath(value: string, cwd: string): string {
	const expanded = value
		.replace(/^\$(?:HOME|\{HOME\})(?=\/|$)/, homedir())
		.replace(/^~(?=\/|$)/, homedir());
	return normalize(isAbsolute(expanded) ? expanded : resolve(cwd, expanded));
}

function displayPath(file: string, cwd: string): string {
	const rel = relative(cwd, file);
	return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : file;
}

function addPath(
	bucket: Map<string, number>,
	value: string,
	cwd: string,
	order: number,
	requireFile: boolean,
): void {
	try {
		const file = resolvePath(value.replace(/[),;:'"`]+$/, ""), cwd);
		if (requireFile && !statSync(file).isFile()) return;
		bucket.set(file, order);
	} catch {
		// A missing or inaccessible path is not established state.
	}
}

function bashPaths(
	command: string,
	cwd: string,
	edited: Map<string, number>,
	read: Map<string, number>,
	order: number,
): void {
	const tokens = command.match(/[^\s]+/g) ?? [];
	const writes = /(?:^|\s)(?:\d*>>?|tee\b|sed\s+[^\n]*-i\b|perl\s+[^\n]*-i\b)/.test(command);
	for (let index = 0; index < tokens.length; index += 1) {
		const raw = tokens[index].replace(/^[|;&(){}]+|[|;&(){}]+$/g, "");
		if (!raw || raw.startsWith("-") || raw === ">" || raw === ">>") continue;
		const match = raw.match(/^(?:\d*>>?)(.+)$/);
		const token = (match?.[1] ?? raw).replace(/^['"`]|['"`]$/g, "");
		if (!token || token === command.split(/\s+/, 1)[0]) continue;
		if (!token.includes("/") && !EXTENSIONS.test(token)) continue;
		const file = resolvePath(token, cwd);
		try {
			if (!statSync(file).isFile()) continue;
		} catch {
			continue;
		}
		(writes ? edited : read).set(file, order + index / 1000);
	}
}

function extractFiles(
	entries: readonly unknown[],
	cwd: string,
): { edited: string[]; read: string[] } {
	const edited = new Map<string, number>();
	const read = new Map<string, number>();
	let order = 0;
	for (const entry of entries) {
		if (!entry || typeof entry !== "object" || (entry as { type?: unknown }).type !== "message")
			continue;
		const message = (entry as { message?: { content?: unknown } }).message;
		if (!message || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (!part || typeof part !== "object") continue;
			const block = part as {
				type?: unknown;
				name?: unknown;
				arguments?: unknown;
				input?: unknown;
			};
			if (block.type !== "toolCall" && block.type !== "tool_use") continue;
			const name = typeof block.name === "string" ? block.name : "";
			const args = ((block.arguments ?? block.input) as Record<string, unknown> | undefined) ?? {};
			order += 1;
			const pathValue = asPath(args.file_path) ?? asPath(args.notebook_path) ?? asPath(args.path);
			if (name === "read" && pathValue) addPath(read, pathValue, cwd, order, false);
			else if ((name === "edit" || name === "write") && pathValue)
				addPath(edited, pathValue, cwd, order, false);
			else if ((name === "bash" || name === "powershell") && typeof args.command === "string") {
				bashPaths(args.command, cwd, edited, read, order);
			}
		}
	}
	for (const file of edited.keys()) read.delete(file);
	const newest = (bucket: Map<string, number>) =>
		[...bucket.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, MAX_FILES)
			.map(([file]) => displayPath(file, cwd));
	return { edited: newest(edited), read: newest(read) };
}

function writeFlag(
	ctx: ExtensionContext,
	event: { reason: string },
	branchEntries: readonly unknown[],
): void {
	const rawId = sessionId(ctx);
	if (!rawId) return;
	const id = safeSessionId(rawId);
	const dir = carryDir();
	try {
		mkdirSync(dir, { recursive: true });
		prune(dir, id);
		const notes = join(dir, `${id}.md`);
		touch(notes);
		const state = extractFiles(branchEntries, ctx.cwd);
		const payload: CarryPayload = { at: Date.now(), cwd: ctx.cwd, trigger: event.reason, ...state };
		const tmp = join(dir, `${id}.json.tmp-${process.pid}`);
		writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
		renameSync(tmp, join(dir, `${id}.json`));
	} catch {
		// Carry is optional. Never fail compaction because persistence failed.
	}
}

function readNotes(file: string): string {
	try {
		const notes = readFileSync(file, "utf8").trim();
		return notes.length > MAX_CARRY_CHARS
			? `${notes.slice(0, MAX_CARRY_CHARS - CUT.length).trimEnd()}${CUT}`
			: notes;
	} catch {
		return "";
	}
}

function fitLine(label: string, values: string[], budget: number): string {
	if (!values.length || budget <= label.length + 4) return "";
	const suffix = ` (+${values.length} more)`;
	const kept: string[] = [];
	let used = label.length;
	for (const value of values) {
		const extra = `${kept.length ? ", " : ""}${value}`;
		if (used + extra.length + (kept.length + 1 < values.length ? suffix.length : 0) > budget) break;
		kept.push(value);
		used += extra.length;
	}
	if (!kept.length) return "";
	return `${label}${kept.join(", ")}${kept.length < values.length ? suffix : ""}`;
}

function buildBlock(payload: CarryPayload, notes: string, notesFile: string): string {
	const head = [
		"--- Session invariants (re-injected once after compaction) ---",
		"The conversation was compacted; preserve this mechanical state.",
		COMPACT_SECTION_HINT,
	];
	const trailer = `Record state that must survive the NEXT compaction by appending to ${notesFile}.`;
	const notesLine = notes ? `CARRIED NOTES:\n${notes}` : "";
	const fixed = head.join("\n") + (notesLine ? `\n${notesLine}` : "") + `\n${trailer}`;
	let budget = MAX_BLOCK_CHARS - fixed.length - 2;
	const body: string[] = [];
	const edited = fitLine("ALREADY CHANGED (do not re-read): ", payload.edited, budget);
	if (edited) {
		body.push(edited);
		budget -= edited.length + 1;
	}
	const read = fitLine("ALREADY READ (re-read only before changing): ", payload.read, budget);
	if (read) body.push(read);
	const block = [...head, ...body, ...(notesLine ? [notesLine] : []), trailer].join("\n");
	return block.length <= MAX_BLOCK_CHARS
		? block
		: `${block.slice(0, MAX_BLOCK_CHARS - CUT.length).trimEnd()}${CUT}`;
}

function consume(ctx: ExtensionContext): { block: string; flag: string } | undefined {
	const rawId = sessionId(ctx);
	if (!rawId) return undefined;
	const id = safeSessionId(rawId);
	const dir = carryDir();
	const flag = join(dir, `${id}.json`);
	if (!existsSync(flag)) return undefined;
	try {
		const payload = JSON.parse(readFileSync(flag, "utf8")) as Partial<CarryPayload>;
		const at = typeof payload.at === "number" ? payload.at : statSync(flag).mtimeMs;
		if (at < Date.now() - STALE_DAYS * 86_400_000) {
			unlinkSync(flag);
			return undefined;
		}
		const state: CarryPayload = {
			at,
			cwd: typeof payload.cwd === "string" ? payload.cwd : ctx.cwd,
			trigger: typeof payload.trigger === "string" ? payload.trigger : "",
			edited: Array.isArray(payload.edited)
				? payload.edited.filter((x): x is string => typeof x === "string")
				: [],
			read: Array.isArray(payload.read)
				? payload.read.filter((x): x is string => typeof x === "string")
				: [],
		};
		const notesFile = join(dir, `${id}.md`);
		const block = buildBlock(state, readNotes(notesFile), notesFile);
		unlinkSync(flag);
		return block ? { block, flag } : undefined;
	} catch {
		try {
			unlinkSync(flag);
		} catch {
			// Corrupt flags are consumed to avoid retrying forever.
		}
		return undefined;
	}
}

export default function sessionInvariants(pi: ExtensionAPI): void {
	if (off()) return;

	pi.on("session_before_compact", async (event, ctx) => {
		try {
			writeFlag(ctx, event, event.branchEntries);
			// Pi does not support appending custom compaction instructions from this
			// handler. Keep default compaction intact; carry is injected next turn.
		} catch {
			// fail open
		}
	});

	pi.on("session_compact_failed", async (_event, ctx) => {
		try {
			const id = safeSessionId(sessionId(ctx));
			if (id) unlinkSync(join(carryDir(), `${id}.json`));
		} catch {
			// fail open
		}
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		try {
			const carry = consume(ctx);
			if (!carry) return undefined;
			return {
				message: {
					customType: "pi-mine.session-invariants",
					content: carry.block,
					display: false,
					details: { oneShot: true },
				},
			};
		} catch {
			// fail open
			return undefined;
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		try {
			prune(carryDir(), safeSessionId(sessionId(ctx)));
		} catch {
			// fail open
		}
	});
}

export const __test = { buildBlock, extractFiles, safeSessionId };
