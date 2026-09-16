/**
 * Lightweight per-turn token/cache telemetry. Best effort: failures never affect a turn.
 * Records provider usage (fresh input, cache read/write, output), tool-schema estimate,
 * tool-call count, latency, and deferred-tool manifest identity in JSONL.
 */

import fs from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getToolSearchSnapshot } from "./tool-search.ts";

export const TOKEN_METRICS_FILE = path.join(getAgentDir(), "token-efficiency-metrics.jsonl");

export type TokenEfficiencyRecord = {
	schema: 1;
	at: number;
	sessionId: string;
	turnIndex: number;
	provider?: string;
	model?: string;
	freshInputTokens: number; // provider usage.input: uncached prompt tokens
	cacheReadTokens: number;
	cacheCreateTokens: number;
	outputTokens: number;
	activeToolCount: number;
	activeToolSchemaTokens: number; // estimate: serialized active definitions / 4
	deferredToolCount: number; // names-only manifest entries, if tool-search is active
	deferredManifestHash?: string;
	toolCallCount: number; // tool_execution_start events in this turn
	latencyMs: number;
	quality?: "accepted" | "rework" | "unknown";
};

const OFF = /^(1|true|yes|on)$/i.test(process.env.PI_TOKEN_METRICS_OFF ?? "");

function finite(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function sessionId(ctx: ExtensionContext): string {
	try {
		return ctx.sessionManager.getSessionId() ?? "";
	} catch {
		return "";
	}
}

function hashText(text: string): string {
	// Stable, dependency-free FNV-1a. Hash is for cache-shape comparison, not security.
	let hash = 0x811c9dc5;
	for (let index = 0; index < text.length; index += 1) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

function activeToolSchema(pi: any): { count: number; tokens: number } {
	try {
		const active = new Set<string>(pi.getActiveTools?.() ?? []);
		const all = Array.isArray(pi.getAllTools?.()) ? pi.getAllTools() : [];
		const definitions = all
			.filter((tool: any) => typeof tool?.name === "string" && active.has(tool.name))
			.map((tool: any) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
				promptSnippet: tool.promptSnippet,
				promptGuidelines: tool.promptGuidelines,
			}));
		return { count: active.size, tokens: Math.ceil(JSON.stringify(definitions).length / 4) };
	} catch {
		return { count: 0, tokens: 0 };
	}
}

function append(record: TokenEfficiencyRecord): void {
	try {
		fs.mkdirSync(path.dirname(TOKEN_METRICS_FILE), { recursive: true });
		fs.appendFileSync(TOKEN_METRICS_FILE, `${JSON.stringify(record)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		try {
			fs.chmodSync(TOKEN_METRICS_FILE, 0o600);
		} catch {
			// Existing files may be on a filesystem that rejects chmod.
		}
	} catch {
		// Telemetry must never make the session fail.
	}
}

export default function metricsLogger(pi: ExtensionAPI): void {
	if (OFF) return;

	let activeSession: ExtensionContext["sessionManager"] | undefined;
	let currentTurn = -1;
	let turnStartedAt = 0;
	let toolCallCount = 0;
	let lastAssistantMessage: any;

	const ownsSession = (ctx: ExtensionContext): boolean => ctx.sessionManager === activeSession;

	pi.on("session_start", (_event, ctx) => {
		activeSession = ctx.sessionManager;
		currentTurn = -1;
		turnStartedAt = 0;
		toolCallCount = 0;
		lastAssistantMessage = undefined;
	});

	pi.on("turn_start", (event: any, ctx) => {
		if (!ownsSession(ctx) || ctx.mode === "json" || ctx.mode === "print") return;
		currentTurn = typeof event?.turnIndex === "number" ? event.turnIndex : currentTurn + 1;
		turnStartedAt = Date.now();
		toolCallCount = 0;
		lastAssistantMessage = undefined;
	});

	pi.on("tool_execution_start", (_event, ctx) => {
		if (ownsSession(ctx)) toolCallCount += 1;
	});

	pi.on("message_end", (event: any, ctx) => {
		if (ownsSession(ctx) && event?.message?.role === "assistant")
			lastAssistantMessage = event.message;
	});

	pi.on("turn_end", (event: any, ctx) => {
		if (!ownsSession(ctx) || ctx.mode === "json" || ctx.mode === "print") return;
		const message = event?.message?.role === "assistant" ? event.message : lastAssistantMessage;
		const usage = message?.usage ?? {};
		const tools = activeToolSchema(pi);
		const deferred = getToolSearchSnapshot();
		const provider = typeof message?.provider === "string" ? message.provider : ctx.model?.provider;
		const model = typeof message?.model === "string" ? message.model : ctx.model?.id;
		const startedAt = turnStartedAt || Date.now();
		append({
			schema: 1,
			at: Date.now(),
			sessionId: sessionId(ctx),
			turnIndex: typeof event?.turnIndex === "number" ? event.turnIndex : currentTurn,
			provider,
			model,
			freshInputTokens: finite(usage.input),
			cacheReadTokens: finite(usage.cacheRead),
			cacheCreateTokens: finite(usage.cacheWrite),
			outputTokens: finite(usage.output),
			activeToolCount: tools.count,
			activeToolSchemaTokens: tools.tokens,
			deferredToolCount: deferred?.deferredToolCount ?? 0,
			deferredManifestHash: deferred?.deferredManifestHash,
			toolCallCount,
			latencyMs: Math.max(0, Date.now() - startedAt),
		});
		lastAssistantMessage = undefined;
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ownsSession(ctx)) activeSession = undefined;
	});
}

export function hashDeferredManifest(names: readonly string[]): string {
	return hashText(
		names
			.slice()
			.sort((a, b) => a.localeCompare(b))
			.join("\n"),
	);
}
