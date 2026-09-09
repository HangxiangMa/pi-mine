/**
 * task-dock — one multi-line panel for every concurrently running task (routed
 * subagents + background tasks), instead of each provider fighting over its own
 * single `ctx.ui.setStatus` line.
 *
 * pi's UI already supports this: `ctx.ui.setWidget(key, renderer, {placement})`
 * takes an arbitrary number of lines. The gap was call sites — `subagent/index.ts`
 * and `subagent-model-router.ts` only ever called `setStatus`, which caps them at
 * one collapsed line and forces N parallel tasks into a single "2/4 running" blob.
 *
 * This module owns a process-wide registry keyed by an id the caller controls
 * (`upsertTask`/`removeTask`) and renders it as one row per task, folding beyond
 * `maxRows` into "+K more". Providers upsert their own rows; this file does not
 * fork or duplicate their business logic (per the plan: pi-background-tasks and
 * pi's own subagent dispatch stay untouched — this only reads their public
 * surface: `subagent/index.ts` passes rows in directly, and background tasks are
 * read via `pi-background-tasks`'s own EventBus wire protocol, never its source).
 *
 * CONFIG (env):
 *   PI_TASK_DOCK_OFF=1            disable the panel; providers keep working, this
 *                                 file just never calls setWidget.
 *   PI_TASK_DOCK_MAX_ROWS=6       rows shown before folding into "+K more".
 *   PI_TASK_DOCK_BG_POLL_MS=2000  background-task status poll interval; terminal
 *                                 completions also arrive immediately over the
 *                                 EventBus and do not wait for this poll.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

export type TaskState = "running" | "waiting" | "done" | "error";

export interface TaskPatch {
	source: string;
	label?: string;
	/** Full provider/model reference, e.g. `anthropic/claude-sonnet`. */
	model?: string;
	state?: TaskState;
	startedAt?: number;
	detail?: string;
	/** Retained final output summary. */
	summary?: string;
	/** Latest tool/activity summary while running. */
	activity?: string;
	tokens?: { input: number; output: number };
	/** Undefined means provider did not expose a cost; render `cost n/a`. */
	cost?: number;
}

interface TaskEntry {
	id: string;
	source: string;
	label: string;
	model?: string;
	state: TaskState;
	startedAt: number;
	detail?: string;
	summary?: string;
	activity?: string;
	tokens?: { input: number; output: number };
	cost?: number;
}

const TASK_DOCK_KEY = "task-dock";
const WIDGET_OPTIONS = { placement: "aboveEditor" } as const;
const REFRESH_INTERVAL_MS = 1_000;
const DONE_LINGER_MS = 15_000;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const registry = new Map<string, TaskEntry>();
const lingerTimers = new Map<string, ReturnType<typeof setTimeout>>();
let liveCtx: ExtensionContext | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;

function isOff(): boolean {
	return process.env.PI_TASK_DOCK_OFF === "1";
}

function maxRows(): number {
	const raw = Number(process.env.PI_TASK_DOCK_MAX_ROWS);
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 6;
}

function bgPollIntervalMs(): number {
	const raw = Number(process.env.PI_TASK_DOCK_BG_POLL_MS);
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2_000;
}

function formatElapsed(startedAt: number): string {
	const elapsed = Math.floor(Math.max(0, Date.now() - startedAt) / 1000);
	if (elapsed < 60) return `${elapsed}s`;
	return `${Math.floor(elapsed / 60)}m${String(elapsed % 60).padStart(2, "0")}s`;
}

function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

function spinnerFrame(startedAt: number): string {
	return SPINNER_FRAMES[Math.floor((Date.now() - startedAt) / 100) % SPINNER_FRAMES.length];
}

function formatCost(cost: number | undefined): string {
	return typeof cost === "number" && Number.isFinite(cost) ? `$${cost.toFixed(4)}` : "cost n/a";
}

function icon(entry: TaskEntry): string {
	if (entry.state === "done") return "✓";
	if (entry.state === "error") return "✗";
	if (entry.state === "waiting") return "?";
	return spinnerFrame(entry.startedAt);
}

function renderRow(entry: TaskEntry, theme: Theme, width: number): string {
	const running = entry.state === "running";
	const symbolColor =
		entry.state === "error"
			? "error"
			: entry.state === "waiting"
				? "warning"
				: running
					? "accent"
					: "muted";
	const model = entry.model;
	const tokenText = entry.tokens
		? [
				entry.tokens.input ? `↑${formatTokens(entry.tokens.input)}` : "",
				entry.tokens.output ? `↓${formatTokens(entry.tokens.output)}` : "",
			]
				.filter(Boolean)
				.join(" ")
		: "";
	const statusText = entry.state === "running" ? "running" : entry.state;
	const rest = [
		model,
		statusText,
		formatElapsed(entry.startedAt),
		entry.detail,
		entry.summary ? `summary: ${entry.summary}` : "",
		entry.activity ? `activity: ${entry.activity}` : "",
		tokenText,
		formatCost(entry.cost),
	].filter((part): part is string => Boolean(part && part.length > 0));
	const line = ` ${theme.fg(symbolColor, icon(entry))} ${theme.fg("text", entry.label)}${
		rest.length ? theme.fg("muted", ` · ${rest.join(" · ")}`) : ""
	}`;
	return truncateToWidth(line, width, "");
}

function render(theme: Theme, width: number): string[] {
	const entries = [...registry.values()].sort((a, b) => a.startedAt - b.startedAt);
	if (entries.length === 0) return [];
	const running = entries.filter((entry) => entry.state === "running").length;
	const waiting = entries.filter((entry) => entry.state === "waiting").length;
	const rows = maxRows();
	const shown = entries.slice(0, rows);
	const hidden = entries.length - shown.length;
	const activity = [`${running} active`, waiting ? `${waiting} waiting` : ""]
		.filter(Boolean)
		.join(" · ");
	const lines = [
		truncateToWidth(theme.fg("muted", `Tasks · ${activity}`), width, ""),
		...shown.map((entry) => renderRow(entry, theme, width)),
	];
	if (hidden > 0) lines.push(truncateToWidth(theme.fg("muted", ` +${hidden} more`), width, ""));
	return lines;
}

function publish(): void {
	if (isOff() || !liveCtx?.hasUI) return;
	try {
		if (registry.size === 0) {
			liveCtx.ui.setWidget(TASK_DOCK_KEY, undefined);
			return;
		}
		liveCtx.ui.setWidget(
			TASK_DOCK_KEY,
			(_tui: unknown, theme: Theme) => ({
				render: (width: number) => render(theme, width),
				invalidate: () => {},
			}),
			WIDGET_OPTIONS,
		);
	} catch {
		/* widget UI is optional */
	}
}

function ensureTimer(): void {
	if (refreshTimer) return;
	refreshTimer = setInterval(publish, REFRESH_INTERVAL_MS);
	refreshTimer.unref?.();
}

function stopTimerIfEmpty(): void {
	if (registry.size > 0 || !refreshTimer) return;
	clearInterval(refreshTimer);
	refreshTimer = undefined;
}

/** Add or update one row. Terminal rows auto-remove after a short linger; waiting rows remain until prompt end. */
export function upsertTask(ctx: ExtensionContext, id: string, patch: TaskPatch): void {
	if (isOff()) return;
	liveCtx = ctx;
	const existing = registry.get(id);
	const entry: TaskEntry = {
		id,
		source: patch.source,
		label: patch.label ?? existing?.label ?? id,
		model: patch.model ?? existing?.model,
		state: patch.state ?? existing?.state ?? "running",
		startedAt: patch.startedAt ?? existing?.startedAt ?? Date.now(),
		detail: patch.detail ?? existing?.detail,
		summary: patch.summary ?? existing?.summary,
		activity: patch.activity ?? existing?.activity,
		tokens: patch.tokens ?? existing?.tokens,
		cost: patch.cost ?? existing?.cost,
	};
	registry.set(id, entry);
	const pendingLinger = lingerTimers.get(id);
	if ((entry.state === "running" || entry.state === "waiting") && pendingLinger) {
		clearTimeout(pendingLinger);
		lingerTimers.delete(id);
	}
	ensureTimer();
	publish();
	if (entry.state !== "running" && entry.state !== "waiting" && !lingerTimers.has(id)) {
		const timer = setTimeout(() => removeTask(id), DONE_LINGER_MS);
		timer.unref?.();
		lingerTimers.set(id, timer);
	}
}

export function removeTask(id: string): void {
	const timer = lingerTimers.get(id);
	if (timer) {
		clearTimeout(timer);
		lingerTimers.delete(id);
	}
	if (!registry.delete(id)) return;
	publish();
	stopTimerIfEmpty();
}

/** Force every still-"running" row whose id starts with `${groupPrefix}:` to a terminal state. Safety net for a caller whose own lifecycle handling was skipped by an early error/throw. */
export function finalizeGroup(
	ctx: ExtensionContext,
	groupPrefix: string,
	state: "done" | "error",
): void {
	if (isOff()) return;
	const prefix = `${groupPrefix}:`;
	for (const [id, entry] of registry) {
		if (entry.state === "running" && id.startsWith(prefix)) {
			upsertTask(ctx, id, { source: entry.source, state });
		}
	}
}

const BG_REQUEST_CHANNEL = "pi-background-tasks:request:v1";
const BG_RESPONSE_CHANNEL = "pi-background-tasks:response:v1";
const BG_TERMINAL_CHANNEL = "pi-background-tasks:terminal:v1";
const BG_REQUEST_SCHEMA = "pi-background-tasks.extension-request.v1";

interface BgTaskSnapshotLike {
	id?: unknown;
	name?: unknown;
	command?: unknown;
	status?: unknown;
	startTime?: unknown;
	model?: unknown;
	tokenUsage?: { input?: unknown; output?: unknown };
	cost?: unknown;
	summary?: unknown;
	activity?: unknown;
}

function bgRowId(taskId: string): string {
	return `bg:${taskId}`;
}

function applyBgSnapshot(ctx: ExtensionContext, task: BgTaskSnapshotLike | undefined): void {
	if (!task || typeof task.id !== "string") return;
	const status = task.status;
	const state: TaskState =
		status === "running"
			? "running"
			: status === "waiting"
				? "waiting"
				: status === "completed"
					? "done"
					: "error";
	const label =
		typeof task.name === "string" && task.name
			? task.name
			: typeof task.command === "string"
				? task.command
				: task.id;
	const usage = task.tokenUsage;
	upsertTask(ctx, bgRowId(task.id), {
		source: "bg",
		label,
		model: typeof task.model === "string" ? task.model : undefined,
		state,
		startedAt: typeof task.startTime === "number" ? task.startTime : Date.now(),
		tokens: usage
			? { input: Number(usage.input) || 0, output: Number(usage.output) || 0 }
			: undefined,
		cost: typeof task.cost === "number" ? task.cost : undefined,
		summary: typeof task.summary === "string" ? task.summary : undefined,
		activity: typeof task.activity === "string" ? task.activity : undefined,
	});
}

function pollBackgroundTasks(pi: ExtensionAPI, ctx: ExtensionContext): void {
	// `pi`/`ctx` here are whatever session_start last captured them as. A session
	// replacement (ESC-fork, /tree, newSession/switchSession/reload) can land in the
	// gap between this timer tick and the next session_start refreshing them, at
	// which point pi.events.on/emit throw "ctx is stale" — and this fires from a
	// bare setInterval, not a pi.on() handler, so nothing else catches it. Must
	// fail open here or a stale tick takes the whole process down.
	try {
		const requestId = `task-dock-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const unsubscribe = pi.events.on(BG_RESPONSE_CHANNEL, (data: unknown) => {
			try {
				const response = data as {
					request_id?: string;
					ok?: boolean;
					result?: { tasks?: BgTaskSnapshotLike[] };
				};
				if (response?.request_id !== requestId) return;
				unsubscribe();
				if (!response.ok || !Array.isArray(response.result?.tasks)) return;
				for (const task of response.result.tasks) applyBgSnapshot(ctx, task);
			} catch {
				/* ctx may have gone stale between subscribe and response; drop it */
			}
		});
		pi.events.emit(BG_REQUEST_CHANNEL, {
			schema_version: BG_REQUEST_SCHEMA,
			request_id: requestId,
			operation: "status",
			payload: {},
		});
	} catch {
		/* pi/ctx stale after a session replacement; next session_start replaces this timer */
	}
}

const DELEGATE_CHANNEL = "billion-context-pi:delegate:v1";

interface DelegateRunLike {
	id?: unknown;
	agent?: unknown;
	task?: unknown;
	status?: unknown;
	startedAt?: unknown;
	tokens?: { input?: unknown; output?: unknown };
	model?: unknown;
	summary?: unknown;
	activity?: unknown;
	cost?: unknown;
}

function delegateRowId(runId: string): string {
	return `delegate:${runId}`;
}

// billion-context-pi's fleetRunsSnapshot() keeps up to 12 finished runs and the
// fork re-broadcasts the full snapshot every ~500ms, so a run this dock already
// finalized and let linger off would otherwise reappear on every subsequent
// tick until it ages out of that 12-run cap. Tracked here, not in `registry`,
// so a terminal run is forwarded exactly once regardless of how long it stays
// in billion-context-pi's own snapshot.
const delegateFinalized = new Set<string>();

function applyDelegateSnapshot(ctx: ExtensionContext, run: DelegateRunLike | undefined): void {
	if (!run || typeof run.id !== "string") return;
	const status = run.status;
	const terminal = status === "completed" || status === "failed" || status === "cancelled";
	const id = delegateRowId(run.id);
	if (terminal && delegateFinalized.has(run.id) && !registry.has(id)) return;
	const state: TaskState =
		status === "completed"
			? "done"
			: terminal
				? "error"
				: status === "waiting"
					? "waiting"
					: "running";
	const tokens = run.tokens;
	upsertTask(ctx, id, {
		source: "delegate",
		label: typeof run.agent === "string" ? run.agent : run.id,
		state,
		startedAt: typeof run.startedAt === "number" ? run.startedAt : Date.now(),
		detail: typeof run.task === "string" ? run.task : undefined,
		model: typeof run.model === "string" ? run.model : undefined,
		summary: typeof run.summary === "string" ? run.summary : undefined,
		activity: typeof run.activity === "string" ? run.activity : undefined,
		tokens: tokens
			? { input: Number(tokens.input) || 0, output: Number(tokens.output) || 0 }
			: undefined,
		cost: typeof run.cost === "number" ? run.cost : undefined,
	});
	if (terminal) delegateFinalized.add(run.id);
}

const UI_PROMPT_ROW_ID = "ui:prompt";

export default function taskDock(pi: ExtensionAPI): void {
	if (isOff()) return;

	let bgTimer: ReturnType<typeof setInterval> | undefined;

	pi.on("session_start", async (_event, ctx) => {
		liveCtx = ctx;
		// Re-arm on every session_start, not just the first — a session replacement
		// (ESC-fork, /tree, etc.) fires this again with a fresh ctx, and the old
		// timer (bound to the now-stale ctx) must be retired, not left running.
		if (bgTimer) {
			clearInterval(bgTimer);
			bgTimer = undefined;
		}
		if (!ctx.hasUI) return;
		bgTimer = setInterval(() => pollBackgroundTasks(pi, ctx), bgPollIntervalMs());
		bgTimer.unref?.();
		pollBackgroundTasks(pi, ctx);
	});

	pi.on("ui_prompt_start", async (event, ctx) => {
		if (!ctx.hasUI) return;
		const prompt = event as { kind?: unknown; title?: unknown };
		const kind = typeof prompt.kind === "string" ? prompt.kind : "prompt";
		const title = typeof prompt.title === "string" ? prompt.title : undefined;
		upsertTask(ctx, UI_PROMPT_ROW_ID, {
			source: "ui",
			label: "Waiting",
			state: "waiting",
			detail: title ? `${kind}: ${title}` : kind,
			startedAt: Date.now(),
		});
	});

	pi.on("ui_prompt_end", async () => {
		removeTask(UI_PROMPT_ROW_ID);
	});

	pi.events.on(BG_TERMINAL_CHANNEL, (data: unknown) => {
		if (!liveCtx?.hasUI) return;
		applyBgSnapshot(liveCtx, (data as { task?: BgTaskSnapshotLike })?.task);
	});

	pi.events.on(DELEGATE_CHANNEL, (data: unknown) => {
		if (!liveCtx?.hasUI) return;
		const runs = (data as { runs?: DelegateRunLike[] })?.runs;
		if (!Array.isArray(runs)) return;
		for (const run of runs) applyDelegateSnapshot(liveCtx, run);
	});
}
