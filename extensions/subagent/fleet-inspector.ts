import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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
const ANSI_ESCAPE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;

let activeInspectorClose: (() => void) | undefined;

export function closeSubagentFleetInspector(): boolean {
	const close = activeInspectorClose;
	if (!close) return false;
	close();
	return true;
}

function clean(value: string): string {
	return value.replace(ANSI_ESCAPE, "");
}

function oneLine(value: string, max: number): string {
	const text = clean(value).replace(/\s+/g, " ").trim();
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

function statusColor(status: SubagentRunStatus): string {
	if (status === "completed") return "success";
	if (status === "failed") return "error";
	if (status === "cancelled") return "muted";
	return "warning";
}

function frame(lines: string[], width: number, theme: any): string[] {
	const innerWidth = Math.max(1, width - 2);
	const border = (text: string) => theme.fg("border", text);
	const top = border(`╭${"─".repeat(Math.max(0, innerWidth))}╮`);
	const body = lines.map((line) => {
		const content = truncateToWidth(line, innerWidth, "");
		return `${border("│")}${content}${" ".repeat(Math.max(0, innerWidth - visibleWidth(content)))}${border("│")}`;
	});
	return [top, ...body, border(`╰${"─".repeat(Math.max(0, innerWidth))}╯`)];
}

export function buildSubagentListRows(runs: SubagentFleetRun[], now = Date.now()): string[] {
	return runs.map((run) => {
		const model = run.model ? ` · ${oneLine(run.model, 36)}` : "";
		const tokens =
			run.inputTokens || run.outputTokens
				? ` · ↑${run.inputTokens.toLocaleString()} ↓${run.outputTokens.toLocaleString()}`
				: "";
		return `${icon(run.status)} ${oneLine(run.agent, 24)} · ${run.status} ${duration(run, now)}${model}${tokens} · ${oneLine(taskTitle(run.task), MAX_TASK_LEN)}`;
	});
}

function renderOutput(run: SubagentFleetRun, width: number, theme: any): string[] {
	const text = clean(run.output || run.stderr || "(no output yet)");
	return text
		.split("\n")
		.slice(-MAX_OUTPUT_LINES)
		.map((line) => truncateToWidth(theme.fg("muted", `  ${line}`), width, ""));
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
		if (runs.length === 0) {
			return frame(
				[
					this.theme.bold("Subagent monitor"),
					this.theme.fg("muted", " No active or recent runs."),
					"",
					this.theme.fg("dim", " Ctrl+Alt+I toggle · q close"),
				],
				width,
				this.theme,
			);
		}
		this.selected = Math.max(0, Math.min(this.selected, runs.length - 1));
		const selected = runs[this.selected];
		const rows = runs.map((run, index) => {
			const row = buildSubagentListRows([run])[0];
			const text = index === this.selected ? `› ${row}` : `  ${row}`;
			return truncateToWidth(
				index === this.selected
					? this.theme.fg("accent", text)
					: this.theme.fg(statusColor(run.status), text),
				width,
				"",
			);
		});
		const details = [
			"",
			this.theme.bold(`Selected: ${oneLine(selected.agent, 32)} · ${selected.id}`),
			this.theme.fg("muted", `Task: ${oneLine(taskTitle(selected.task), width - 8)}`),
			this.theme.fg(
				statusColor(selected.status),
				`Status: ${selected.status} · ${duration(selected, Date.now())}`,
			),
			...renderOutput(selected, width, this.theme),
			"",
			this.theme.fg(
				"dim",
				"j/k or ↑/↓ select   c cancel   p guide   q close   · monitor focused",
			),
		];
		return frame(
			[this.theme.bold(`Subagent monitor · ${runs.length} run(s)`), ...rows, ...details].slice(0, 38),
			width,
			this.theme,
		);
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
				overlayOptions: { width: "80%", minWidth: 80, maxHeight: "80%", anchor: "center", margin: 1 },
				onHandle: (handle) => handle.focus(),
			},
		);
	} finally {
		if (activeInspectorClose === closeInspector) activeInspectorClose = undefined;
	}
}
