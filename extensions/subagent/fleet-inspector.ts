import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { taskTitle } from "../task-title.ts";

export type SubagentRunStatus = "running" | "completed" | "failed" | "cancelled";

export interface SubagentFleetRun {
	id: string;
	agent: string;
	task: string;
	model?: string;
	status: SubagentRunStatus;
	startedAt: number;
	finishedAt?: number;
	output: string;
	stderr: string;
	inputTokens: number;
	outputTokens: number;
}

export interface SubagentFleetActions {
	cancel?(runId: string): void;
	guide?(runId: string): void;
}

interface Keybindings {
	matches(data: string, binding: string): boolean;
}

const REFRESH_MS = 500;
const MAX_TASK_LEN = 64;
const MAX_OUTPUT_LINES = 10;

let activeInspectorClose: (() => void) | undefined;

/** Close the visible inspector without requiring it to own editor focus. */
export function closeSubagentFleetInspector(): boolean {
	const close = activeInspectorClose;
	if (!close) return false;
	close();
	return true;
}

function oneLine(value: string, max: number): string {
	const text = value.replace(/\s+/g, " ").trim();
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function duration(run: SubagentFleetRun, now: number): string {
	const seconds = Math.max(0, Math.floor(((run.finishedAt ?? now) - run.startedAt) / 1000));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

function icon(status: SubagentRunStatus): string {
	if (status === "completed") return "✓";
	if (status === "failed") return "✗";
	if (status === "cancelled") return "⊘";
	return "●";
}

export function buildSubagentListRows(runs: SubagentFleetRun[], now = Date.now()): string[] {
	return runs.map((run) => {
		const model = run.model ? ` · ${run.model}` : "";
		const tokens =
			run.inputTokens || run.outputTokens
				? ` · ↑${run.inputTokens.toLocaleString()} ↓${run.outputTokens.toLocaleString()}`
				: "";
		return `${icon(run.status)} ${run.agent} · ${run.status} ${duration(run, now)}${model}${tokens} · ${oneLine(taskTitle(run.task), MAX_TASK_LEN)}`;
	});
}

function renderOutput(run: SubagentFleetRun, width: number, theme: any): string[] {
	const text = run.output || run.stderr || "(no output yet)";
	const lines = text.split("\n").slice(-MAX_OUTPUT_LINES);
	return lines.map((line) => truncateToWidth(theme.fg("muted", `  ${line}`), width, ""));
}

class SubagentFleetComponent {
	private selected = 0;
	private closed = false;
	private readonly refreshTimer: ReturnType<typeof setInterval>;

	constructor(
		private readonly tui: { requestRender(force?: boolean): void },
		private readonly theme: any,
		private readonly keybindings: Keybindings,
		private readonly done: () => void,
		private readonly snapshot: () => SubagentFleetRun[],
		private readonly actions: SubagentFleetActions,
	) {
		this.refreshTimer = setInterval(() => this.tui.requestRender(), REFRESH_MS);
		this.refreshTimer.unref?.();
	}

	private runs(): SubagentFleetRun[] {
		return this.snapshot();
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		clearInterval(this.refreshTimer);
		this.done();
	}

	render(width: number): string[] {
		const runs = this.runs();
		if (runs.length === 0)
			return [
				this.theme.fg("muted", " No subagent runs."),
				"",
				" Ctrl+Alt+I toggle · editor remains active",
			];
		this.selected = Math.max(0, Math.min(this.selected, runs.length - 1));
		const selected = runs[this.selected];
		const rows = runs.map((run, index) => {
			const row = buildSubagentListRows([run])[0];
			return truncateToWidth(
				index === this.selected ? this.theme.fg("accent", `› ${row}`) : `  ${row}`,
				width,
				"",
			);
		});
		const details = [
			"",
			this.theme.bold(`Selected: ${selected.agent} (${selected.id})`),
			this.theme.fg("muted", `Task: ${taskTitle(selected.task)}`),
			...renderOutput(selected, width, this.theme),
			"",
			this.theme.fg("dim", "Ctrl+Alt+I toggle · editor input remains active"),
		];
		return [this.theme.bold("Subagent fleet"), ...rows, ...details].slice(0, 40);
	}

	handleInput(data: string): void {
		const runs = this.runs();
		if (this.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, "q")) {
			this.close();
			return;
		}
		if (runs.length === 0) return;
		if (this.keybindings.matches(data, "tui.select.up") || matchesKey(data, "k")) {
			this.selected = Math.max(0, this.selected - 1);
			this.tui.requestRender();
		} else if (this.keybindings.matches(data, "tui.select.down") || matchesKey(data, "j")) {
			this.selected = Math.min(runs.length - 1, this.selected + 1);
			this.tui.requestRender();
		} else if (matchesKey(data, "c")) {
			this.actions.cancel?.(runs[this.selected].id);
			this.tui.requestRender();
		} else if (matchesKey(data, "p")) {
			const runId = runs[this.selected].id;
			this.close();
			this.actions.guide?.(runId);
		} else if (this.keybindings.matches(data, "tui.select.confirm")) {
			this.tui.requestRender();
		}
	}

	invalidate(): void {}
}

export async function openSubagentFleetInspector(
	ctx: ExtensionContext,
	snapshot: () => SubagentFleetRun[],
	actions: SubagentFleetActions = {},
): Promise<void> {
	if (!ctx.hasUI) return;
	if (typeof ctx.ui.custom !== "function") {
		ctx.ui.notify("Subagent fleet inspector requires interactive UI", "warning");
		return;
	}
	let closeInspector: (() => void) | undefined;
	try {
		await ctx.ui.custom(
			async (tui, theme, keybindings, done) => {
				const close = () => done(undefined);
				closeInspector = close;
				activeInspectorClose = close;
				const component = new SubagentFleetComponent(
					tui,
					theme,
					keybindings,
					close,
					snapshot,
					actions,
				);
				tui.requestRender();
				return component;
			},
			{
				overlay: true,
				overlayOptions: { width: "100%", minWidth: 80, anchor: "center" },
				// Keep editor input active. Ctrl+Alt+I toggles this view closed.
				onHandle: (handle) => handle.unfocus(),
			},
		);
	} finally {
		if (activeInspectorClose === closeInspector) activeInspectorClose = undefined;
	}
}
