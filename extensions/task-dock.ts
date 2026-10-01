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
import { estimateModelCost } from "./model-pricing.ts";
import { taskTitle } from "./task-title.ts";

export type TaskState = "running" | "waiting" | "done" | "error";

export interface TaskPatch {
	source: string;
	label?: string;
	/** Full provider/model reference, e.g. `anthropic/claude-sonnet`. */
	model?: string;
	state?: TaskState;
	/** Provider lifecycle phase, when available. */
	stage?: string;
	startedAt?: number;
	detail?: string;
	/** Retained final output summary. */
	summary?: string;
	/** Latest tool/activity summary while running. */
	activity?: string;
	/** Complete live transcript file when provider exposes one. */
	transcriptFile?: string;
	tokens?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
	/** Undefined means provider did not expose a cost; render `cost n/a`. */
	cost?: number;
	costEstimated?: boolean;
}

interface DelegateUsage {
	input: number;
	output: number;
	cost: number;
}

export interface TaskDockRun {
	id: string;
	source: string;
	label: string;
	model?: string;
	state: TaskState;
	startedAt: number;
	detail?: string;
	summary?: string;
	activity?: string;
	tokens?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
	cost?: number;
	costEstimated?: boolean;
}

interface TaskEntry {
	id: string;
	source: string;
	label: string;
	model?: string;
	state: TaskState;
	stage?: string;
	startedAt: number;
	detail?: string;
	summary?: string;
	activity?: string;
	transcriptFile?: string;
	tokens?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
	cost?: number;
	costEstimated?: boolean;
}

const TASK_DOCK_KEY = "task-dock";
const WIDGET_OPTIONS = { placement: "belowEditor" } as const;
const REFRESH_INTERVAL_MS = 1_000;
const DONE_LINGER_MS = 15_000;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TASK_SUMMARY_MAX = 48;

const TASK_CONTROL_KEY = "__piMineTaskDockControl";

type TaskControlHandler = (request: {
	id: string;
	action: "cancel" | "guide";
	guidance?: string;
}) => void;
type TaskDockRunProvider = () => TaskDockRun[];
const TASK_DOCK_PROVIDER_KEY = "__piMineRegisterTaskDockProvider";

type TaskDockGlobal = typeof globalThis & {
	[TASK_CONTROL_KEY]?: TaskControlHandler;
	__piMineTaskDockRuns?: TaskDockRunProvider;
	[TASK_DOCK_PROVIDER_KEY]?: (provider: TaskDockRunProvider) => () => void;
};

const registry = new Map<string, TaskEntry>();
const lingerTimers = new Map<string, ReturnType<typeof setTimeout>>();
// Background-task status polling returns completed tasks forever. Keep terminal
// ids separate from the visible registry so a row removed after its linger
// window is not resurrected on the next poll tick.
const bgFinalized = new Set<string>();
let delegateUsage: DelegateUsage | undefined;
let liveCtx: ExtensionContext | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let widgetRegistered = false;
let widgetRequestRender: (() => void) | undefined;
let delegateUsageClearTimer: ReturnType<typeof setTimeout> | undefined;
let sessionGeneration = 0;
let sessionActive = false;
let delegateSnapshotPrimed = false;
let bgSnapshotPrimed = false;
let lastDelegateBridgeSignature: string | undefined;
let delegateFleetShortcut = "";
const historicalDelegateIds = new Set<string>();
const historicalBgIds = new Set<string>();

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

function formatCost(cost: number | undefined, estimated = false): string {
	return typeof cost === "number" && Number.isFinite(cost)
		? `${estimated ? "~" : ""}$${cost.toFixed(4)}`
		: "cost n/a";
}

export function estimateCost(
	ctx: ExtensionContext,
	modelRef: string | undefined,
	tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number } | undefined,
): number | undefined {
	if (
		!modelRef ||
		!tokens ||
		(tokens.input <= 0 && tokens.output <= 0 && !(tokens.cacheRead || tokens.cacheWrite))
	)
		return undefined;
	const separator = modelRef.indexOf("/");
	if (separator <= 0) return undefined;
	try {
		const model = ctx.modelRegistry.find(
			modelRef.slice(0, separator),
			modelRef.slice(separator + 1),
		) as
			| {
					cost?: Record<string, unknown>;
			  }
			| undefined;
		const rate = (key: string) =>
			typeof model?.cost?.[key] === "number" ? (model.cost[key] as number) : 0;
		const cost =
			tokens.input * rate("input") +
			tokens.output * rate("output") +
			(tokens.cacheRead ?? 0) * rate("cacheRead") +
			(tokens.cacheWrite ?? 0) * rate("cacheWrite");
		if (cost > 0) return cost / 1_000_000;
	} catch {
		// Fall back to the bundled catalog when the runtime registry is unavailable.
	}
	return estimateModelCost(modelRef, tokens);
}

function formatShortcutLabel(shortcut: string): string {
	return shortcut
		.split("+")
		.map((part) => {
			const normalized = part.trim().toLowerCase();
			if (normalized === "ctrl") return "Ctrl";
			if (normalized === "alt") return "Alt";
			if (normalized === "shift") return "Shift";
			if (normalized === "super") return "Super";
			return normalized.length === 1 ? normalized.toUpperCase() : part.trim();
		})
		.join("+");
}

function formatCompactTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

function formatTokenUsage(
	tokens: { input: number; output: number },
	formatter = formatTokens,
): string {
	const parts = [
		tokens.input ? `↑${formatter(tokens.input)}` : "",
		tokens.output ? `↓${formatter(tokens.output)}` : "",
	].filter(Boolean);
	return parts.length > 0 ? `${parts.join(" ")} tok` : "";
}

function icon(entry: TaskEntry): string {
	if (entry.state === "done") return "✓";
	if (entry.state === "error") return "✗";
	if (entry.state === "waiting") return "?";
	return spinnerFrame(entry.startedAt);
}

function compactSummary(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const oneLine = value.replace(/\s+/g, " ").trim();
	if (!oneLine) return undefined;
	return oneLine.length > TASK_SUMMARY_MAX
		? `${oneLine.slice(0, TASK_SUMMARY_MAX - 1).trimEnd()}…`
		: oneLine;
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
	const tokenText = entry.tokens ? formatTokenUsage(entry.tokens) : "";
	const statusText = entry.stage ?? (entry.state === "running" ? "running" : entry.state);
	const rest = [
		model,
		statusText,
		formatElapsed(entry.startedAt),
		entry.detail,
		compactSummary(entry.summary ?? entry.activity),
		tokenText,
		formatCost(entry.cost, entry.costEstimated),
	].filter((part): part is string => Boolean(part && part.length > 0));
	const line = ` ${theme.fg(symbolColor, icon(entry))} ${theme.fg("text", entry.label)}${
		rest.length ? theme.fg("muted", ` · ${rest.join(" · ")}`) : ""
	}`;
	return truncateToWidth(line, width, "");
}

function externalEntries(): TaskEntry[] {
	const providers = (
		globalThis as typeof globalThis & { __piMineTaskDockProviders?: Set<TaskDockRunProvider> }
	).__piMineTaskDockProviders;
	if (!providers) return [];
	const entries: TaskEntry[] = [];
	for (const provider of providers) {
		try {
			for (const run of provider()) {
				entries.push({ ...run, label: run.label, state: run.state, startedAt: run.startedAt });
			}
		} catch {
			// Optional providers must not break the shared task panel.
		}
	}
	return entries;
}

function render(theme: Theme, width: number): string[] {
	const entries = [...registry.values(), ...externalEntries()].sort(
		(a, b) => a.startedAt - b.startedAt,
	);
	if (entries.length === 0 && !(delegateUsage && delegateUsage.input + delegateUsage.output > 0))
		return [];
	const running = entries.filter((entry) => entry.state === "running").length;
	const waiting = entries.filter((entry) => entry.state === "waiting").length;
	const shortcutHints = new Set<string>();
	if (entries.some((entry) => entry.source === "bg")) shortcutHints.add("Shift↓");
	if (entries.some((entry) => entry.source === "delegate" || entry.source === "routed")) {
		shortcutHints.add("Ctrl+Alt+I");
		if (delegateFleetShortcut)
			shortcutHints.add(`/acp-fleet · ${formatShortcutLabel(delegateFleetShortcut)}`);
	}
	const rows = maxRows();
	const shown = entries.slice(0, rows);
	const hidden = entries.length - shown.length;
	const activity = [
		`${running} active`,
		waiting ? `${waiting} waiting` : "",
		shortcutHints.size > 0 ? [...shortcutHints].join(" / ") : "",
	]
		.filter(Boolean)
		.join(" · ");
	const lines = [
		truncateToWidth(theme.fg("muted", `Tasks · ${activity}`), width, ""),
		...(delegateUsage && delegateUsage.input + delegateUsage.output > 0
			? [
					truncateToWidth(
						theme.fg(
							"muted",
							`Sub-agents · ${formatTokenUsage(delegateUsage, formatCompactTokens)}${delegateUsage.cost > 0 ? ` ($${delegateUsage.cost.toFixed(4)})` : ""}`,
						),
						width,
						"",
					),
				]
			: []),
		...shown.map((entry) => renderRow(entry, theme, width)),
	];
	if (hidden > 0) lines.push(truncateToWidth(theme.fg("muted", ` +${hidden} more`), width, ""));
	return lines;
}

function clearTerminalRows(source: string): void {
	for (const [id, entry] of registry) {
		if (entry.source === source && entry.state !== "running" && entry.state !== "waiting")
			removeTask(id);
	}
}

function ownsSession(ctx: ExtensionContext, generation: number): boolean {
	return sessionActive && generation === sessionGeneration && liveCtx === ctx;
}

function safeLiveCtx(): ExtensionContext | undefined {
	try {
		if (!liveCtx?.hasUI) return undefined;
		return liveCtx;
	} catch {
		// `hasUI` itself asserts context freshness.
		liveCtx = undefined;
		return undefined;
	}
}

function publish(): void {
	// `hasUI` is a guarded getter. It throws when this timer fires after the
	// session that supplied `liveCtx` was replaced or reloaded.
	try {
		if (isOff()) return;
		const ctx = safeLiveCtx();
		if (!ctx) return;
		const hasEntries =
			registry.size > 0 || Boolean(delegateUsage && delegateUsage.input + delegateUsage.output > 0);
		if (!hasEntries) {
			if (widgetRegistered) {
				ctx.ui.setWidget(TASK_DOCK_KEY, undefined);
				widgetRegistered = false;
				widgetRequestRender = undefined;
			}
			return;
		}
		if (widgetRegistered) {
			// Keep one widget instance. Re-registering it every second causes visible
			// layout churn; the renderer's requestRender is enough for updates.
			widgetRequestRender?.();
			return;
		}
		ctx.ui.setWidget(
			TASK_DOCK_KEY,
			(_tui: unknown, theme: Theme) => {
				widgetRequestRender = () => {
					(_tui as { requestRender?: () => void }).requestRender?.();
				};
				return {
					render: (width: number) => render(theme, width),
					invalidate: () => {},
				};
			},
			WIDGET_OPTIONS,
		);
		widgetRegistered = true;
		// setWidget may only register the factory; request again after the factory
		// captures TUI so the first state transition is visible immediately.
		widgetRequestRender?.();
	} catch {
		// A timer may outlive its session. Drop all captured UI state; the next
		// session_start supplies a fresh context. Never let optional UI crash Pi.
		liveCtx = undefined;
		widgetRegistered = false;
		widgetRequestRender = undefined;
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

function clearDelegateUsageTimer(): void {
	if (!delegateUsageClearTimer) return;
	clearTimeout(delegateUsageClearTimer);
	delegateUsageClearTimer = undefined;
}

function syncDelegateUsageExpiry(runs: DelegateRunLike[]): void {
	const active = runs.some(
		(run) => run.status === "running" || run.status === "queued" || run.status === "waiting",
	);
	clearDelegateUsageTimer();
	if (active || !delegateUsage || delegateUsage.input + delegateUsage.output <= 0) return;
	delegateUsageClearTimer = setTimeout(() => {
		delegateUsageClearTimer = undefined;
		delegateUsage = undefined;
		publish();
	}, DONE_LINGER_MS);
	delegateUsageClearTimer.unref?.();
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
		stage: patch.stage ?? existing?.stage,
		startedAt: patch.startedAt ?? existing?.startedAt ?? Date.now(),
		detail: patch.detail ?? existing?.detail,
		summary: patch.summary ?? existing?.summary,
		activity: patch.activity ?? existing?.activity,
		transcriptFile: patch.transcriptFile ?? existing?.transcriptFile,
		tokens: patch.tokens ?? existing?.tokens,
		cost: patch.cost ?? existing?.cost,
		costEstimated: patch.costEstimated ?? existing?.costEstimated,
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

export function registerTaskDockProvider(provider: TaskDockRunProvider): () => void {
	const global = globalThis as typeof globalThis & {
		__piMineTaskDockProviders?: Set<TaskDockRunProvider>;
	};
	const providers = (global.__piMineTaskDockProviders ??= new Set());
	providers.add(provider);
	return () => providers.delete(provider);
}

export function taskDockSnapshot(): TaskDockRun[] {
	const local = [...registry.values()].map(
		({
			id,
			source,
			label,
			model,
			state,
			startedAt,
			detail,
			summary,
			activity,
			tokens,
			cost,
			costEstimated,
		}) => ({
			id,
			source,
			label,
			model,
			state,
			startedAt,
			detail,
			summary,
			activity,
			tokens,
			cost,
			costEstimated,
		}),
	);
	const legacy = (globalThis as TaskDockGlobal).__piMineTaskDockRuns?.() ?? [];
	const providers = (
		globalThis as typeof globalThis & { __piMineTaskDockProviders?: Set<TaskDockRunProvider> }
	).__piMineTaskDockProviders;
	const external = providers
		? [...providers].flatMap((provider) => {
				try {
					return provider();
				} catch {
					return [];
				}
			})
		: [];
	return [...local, ...legacy, ...external];
}

export function requestTaskControl(
	id: string,
	action: "cancel" | "guide",
	guidance?: string,
): boolean {
	const handler = (globalThis as TaskDockGlobal)[TASK_CONTROL_KEY];
	if (!handler) return false;
	handler({ id, action, guidance });
	return true;
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

function applyBgSnapshot(
	ctx: ExtensionContext,
	task: BgTaskSnapshotLike | undefined,
	fromTerminalEvent = false,
): void {
	if (!task || typeof task.id !== "string") return;
	const status = task.status;
	const terminal = status !== "running" && status !== "waiting";
	const id = bgRowId(task.id);
	if (terminal && !fromTerminalEvent && historicalBgIds.has(task.id)) return;
	if (terminal && !fromTerminalEvent && !bgSnapshotPrimed && !registry.has(id)) {
		historicalBgIds.add(task.id);
		return;
	}
	if (terminal && bgFinalized.has(task.id) && !registry.has(id)) return;
	if (!terminal) {
		historicalBgIds.delete(task.id);
		bgFinalized.delete(task.id);
	}
	const state: TaskState =
		status === "running"
			? "running"
			: status === "waiting"
				? "waiting"
				: status === "completed"
					? "done"
					: "error";
	const label = taskTitle(
		typeof task.name === "string" && task.name
			? task.name
			: typeof task.command === "string"
				? task.command
				: undefined,
		task.id,
	);
	const usage = task.tokenUsage
		? { input: Number(task.tokenUsage.input) || 0, output: Number(task.tokenUsage.output) || 0 }
		: undefined;
	const explicitCost = typeof task.cost === "number" ? task.cost : undefined;
	const estimatedCost =
		explicitCost === undefined
			? estimateCost(ctx, typeof task.model === "string" ? task.model : undefined, usage)
			: undefined;
	upsertTask(ctx, id, {
		source: "bg",
		label,
		model: typeof task.model === "string" ? task.model : undefined,
		state,
		startedAt: typeof task.startTime === "number" ? task.startTime : Date.now(),
		tokens: usage,
		cost: explicitCost ?? estimatedCost,
		costEstimated: estimatedCost !== undefined,
		summary: typeof task.summary === "string" ? task.summary : undefined,
		activity: typeof task.activity === "string" ? task.activity : undefined,
	});
	if (terminal) bgFinalized.add(task.id);
}

function pollBackgroundTasks(pi: ExtensionAPI, ctx: ExtensionContext, generation: number): void {
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
				if (!ownsSession(ctx, generation)) return;
				for (const task of response.result.tasks) applyBgSnapshot(ctx, task);
				bgSnapshotPrimed = true;
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
	stage?: unknown;
	transcriptFile?: unknown;
	cost?: unknown;
	finishedAt?: unknown;
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
	if (terminal && historicalDelegateIds.has(run.id)) return;
	if (terminal && !delegateSnapshotPrimed && !registry.has(id)) {
		historicalDelegateIds.add(run.id);
		return;
	}
	if (terminal && delegateFinalized.has(run.id) && !registry.has(id)) return;
	if (!terminal) historicalDelegateIds.delete(run.id);
	const state: TaskState =
		status === "completed"
			? "done"
			: terminal
				? "error"
				: status === "waiting"
					? "waiting"
					: "running";
	const tokens = run.tokens
		? { input: Number(run.tokens.input) || 0, output: Number(run.tokens.output) || 0 }
		: undefined;
	const explicitCost = typeof run.cost === "number" ? run.cost : undefined;
	const estimatedCost =
		explicitCost === undefined
			? estimateCost(ctx, typeof run.model === "string" ? run.model : undefined, tokens)
			: undefined;
	upsertTask(ctx, id, {
		source: "delegate",
		label: typeof run.agent === "string" ? run.agent : run.id,
		state,
		stage: typeof run.stage === "string" ? run.stage : undefined,
		startedAt: typeof run.startedAt === "number" ? run.startedAt : Date.now(),
		detail: typeof run.task === "string" ? taskTitle(run.task) : undefined,
		model: typeof run.model === "string" ? run.model : undefined,
		summary: typeof run.summary === "string" ? run.summary : undefined,
		activity: typeof run.activity === "string" ? run.activity : undefined,
		transcriptFile: typeof run.transcriptFile === "string" ? run.transcriptFile : undefined,
		tokens,
		cost: explicitCost ?? estimatedCost,
		costEstimated: estimatedCost !== undefined,
	});
	if (terminal) delegateFinalized.add(run.id);
}

const UI_PROMPT_ROW_ID = "ui:prompt";

export default function taskDock(pi: ExtensionAPI): void {
	if (isOff()) return;
	(globalThis as TaskDockGlobal)[TASK_DOCK_PROVIDER_KEY] = registerTaskDockProvider;

	let bgTimer: ReturnType<typeof setInterval> | undefined;

	pi.on("session_start", async (_event, ctx) => {
		sessionGeneration += 1;
		sessionActive = true;
		delegateSnapshotPrimed = false;
		bgSnapshotPrimed = false;
		lastDelegateBridgeSignature = undefined;
		delegateFleetShortcut = "";
		historicalDelegateIds.clear();
		historicalBgIds.clear();
		clearTerminalRows("delegate");
		clearTerminalRows("bg");
		liveCtx = ctx;
		widgetRegistered = false;
		clearDelegateUsageTimer();
		delegateUsage = undefined;
		// Re-arm on every session_start, not just the first — a session replacement
		// (ESC-fork, /tree, etc.) fires this again with a fresh ctx, and the old
		// timer (bound to the now-stale ctx) must be retired, not left running.
		if (bgTimer) {
			clearInterval(bgTimer);
			bgTimer = undefined;
		}
		if (!ctx.hasUI) return;
		const generation = sessionGeneration;
		bgTimer = setInterval(() => {
			if (ownsSession(ctx, generation)) pollBackgroundTasks(pi, ctx, generation);
		}, bgPollIntervalMs());
		bgTimer.unref?.();
		pollBackgroundTasks(pi, ctx, generation);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		sessionActive = false;
		sessionGeneration += 1;
		if (bgTimer) {
			clearInterval(bgTimer);
			bgTimer = undefined;
		}
		if (refreshTimer) {
			clearInterval(refreshTimer);
			refreshTimer = undefined;
		}
		clearDelegateUsageTimer();
		try {
			if (ctx.hasUI) ctx.ui.setWidget(TASK_DOCK_KEY, undefined);
		} catch {
			/* shutdown may already have invalidated the context */
		}
		liveCtx = undefined;
		widgetRegistered = false;
		widgetRequestRender = undefined;
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
		const ctx = safeLiveCtx();
		if (!ctx) return;
		applyBgSnapshot(ctx, (data as { task?: BgTaskSnapshotLike })?.task, true);
	});

	pi.events.on(DELEGATE_CHANNEL, (data: unknown) => {
		const ctx = safeLiveCtx();
		if (!ctx) return;
		const payload = data as {
			runs?: DelegateRunLike[];
			usage?: { input?: unknown; output?: unknown; cost?: unknown };
			fleetShortcut?: unknown;
		};
		const runs = payload?.runs;
		if (!Array.isArray(runs)) return;
		const fleetShortcut = typeof payload.fleetShortcut === "string" ? payload.fleetShortcut : "";
		// fleet-widget broadcasts the complete snapshot every 500ms. Ignore
		// identical snapshots; otherwise each broadcast forces a full TUI repaint
		// while reload is restoring the transcript.
		const signature = JSON.stringify({
			runs: runs.map((run) => ({
				id: run.id,
				status: run.status,
				startedAt: run.startedAt,
				finishedAt: run.finishedAt,
				stage: run.stage,
				summary: run.summary,
				activity: run.activity,
				tokens: run.tokens,
				cost: run.cost,
			})),
			usage: payload.usage,
			fleetShortcut,
		});
		if (signature === lastDelegateBridgeSignature) return;
		lastDelegateBridgeSignature = signature;
		delegateFleetShortcut = fleetShortcut;
		const usage = payload.usage;
		delegateUsage = usage
			? {
					input: Number(usage.input) || 0,
					output: Number(usage.output) || 0,
					cost: Number(usage.cost) || 0,
				}
			: undefined;
		for (const run of runs) applyDelegateSnapshot(ctx, run);
		delegateSnapshotPrimed = true;
		syncDelegateUsageExpiry(runs);
	});
}

export const __test = {
	estimateCost,
	formatCost,
	formatTokenUsage,
	renderRow,
	peekTask: (id: string) => registry.get(id),
};
