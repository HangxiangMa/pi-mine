import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { dockRowCount } from "../task-dock.ts";
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

/**
 * Rows pi draws below the dock on every frame, which pi-tui does not report to overlays: the
 * Working line, its blank and separator, the status line, and the AICP line. Derived, not
 * directly measured: the dock adds one line per row, so the footer minus its dock rows gives 5
 * (7 - 1 at one run, 12 - 7 at six). The 12-row capture was at 100x24, not 160x50. The idle
 * (non-Working) chrome has not been measured separately.
 */
export const FOOTER_CHROME_ROWS = 5;

/**
 * Overlay placement for the monitor. The width follows the terminal (never more than the columns
 * left after the side margins). The bottom margin reserves `footerRows` so the frame never covers
 * the footer, and the height is capped to the rows above it. Pure, so the layout has a test.
 */
export function monitorOverlayOptions(termCols: number, termRows: number, footerRows: number) {
	const cols = Math.max(20, termCols);
	const rows = Math.max(6, termRows);
	const width = Math.max(20, cols - 4);
	const maxHeight = Math.max(4, rows - footerRows - 1);
	return {
		width,
		maxHeight,
		anchor: "center" as const,
		margin: { top: 1, left: 1, right: 1, bottom: footerRows },
	};
}

/**
 * The footer's height right now: pi's chrome plus the dock's own line count. Read from the same
 * dock layout the dock draws with, so the reserve follows the dock as runs start and finish.
 */
export function footerRowsNow(): number {
	return FOOTER_CHROME_ROWS + dockRowCount();
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
		// Put the task title before low-priority metadata so a narrow row drops
		// model/token details before dropping the work being performed.
		return `${icon(run.status)} ${oneLine(run.agent, 24)} · ${oneLine(taskTitle(run.task), MAX_TASK_LEN)} · ${run.status} ${duration(run, now)}${model}${tokens}`;
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
		private readonly tui: {
			requestRender(force?: boolean): void;
			terminal?: { rows: number; columns: number };
		},
		private readonly theme: any,
		private readonly keybindings: Keybindings,
		private readonly done: () => void,
		private readonly snapshot: () => SubagentFleetRun[],
		private readonly actions: SubagentFleetActions,
		// The overlay options object pi-tui holds by reference. Mutating it in place is what moves
		// the frame, so the footer reserve follows the dock without reopening the monitor.
		private readonly liveOptions: { maxHeight: number; margin: { bottom: number } },
	) {
		this.refreshTimer = setInterval(() => {
			this.syncFooterReserve();
			this.tui.requestRender();
		}, REFRESH_MS);
		this.refreshTimer.unref?.();
	}

	private runs(): SubagentFleetRun[] {
		return this.snapshot();
	}

	/**
	 * Re-derive the footer reserve from the dock's current rows and resize the frame in place.
	 * Called on the refresh timer, so the frame tracks the dock as runs start and finish.
	 */
	private syncFooterReserve(): void {
		const termRows = this.tui.terminal?.rows ?? 50;
		const termCols = this.tui.terminal?.columns ?? 120;
		const next = monitorOverlayOptions(termCols, termRows, footerRowsNow());
		this.liveOptions.maxHeight = next.maxHeight;
		this.liveOptions.margin.bottom = next.margin.bottom;
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
				"muted",
				"j/k or ↑/↓ select   c cancel   p guide   q close   · monitor focused",
			),
		];
		// Keep the window inside the rows above the footer. The key hint sits right under the
		// title, so it stays visible even when the body is cut to fit a short terminal.
		const capRows = this.liveOptions.maxHeight - 2;
		const hint =
			this.theme.fg("accent", "Ctrl+Alt+I") + this.theme.fg("muted", " toggle this monitor");
		return frame(
			[
				this.theme.bold(`Subagent monitor · ${runs.length} run(s)`),
				hint,
				...rows,
				...details,
			].slice(0, Math.max(4, capRows)),
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
	// One options object for the life of the monitor. pi-tui keeps this reference and reads it
	// every frame, so syncFooterReserve() can resize the frame in place.
	const liveOptions = monitorOverlayOptions(
		process.stdout.columns || 120,
		process.stdout.rows || 50,
		footerRowsNow(),
	);
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
					liveOptions,
				);
				tui.requestRender();
				return component;
			},
			{
				overlay: true,
				overlayOptions: liveOptions,
				onHandle: (handle) => handle.focus(),
			},
		);
	} finally {
		if (activeInspectorClose === closeInspector) activeInspectorClose = undefined;
	}
}
