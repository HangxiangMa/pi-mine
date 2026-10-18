import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as piTui from "@earendil-works/pi-tui";
import { dockRowCount } from "../task-dock.ts";
import { enterPicker, exitPicker } from "../grouped-picker/picker-busy.ts";
import { taskTitle } from "../task-title.ts";

const { Input, matchesKey, truncateToWidth, visibleWidth } = piTui;

type StyleText = (text: string, style: { bold: boolean }) => string;
const styleText: StyleText =
	(piTui as unknown as { styleText?: StyleText }).styleText ??
	((text, style) => (style.bold ? `\x1b[1m${text}\x1b[22m` : text));

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
	/** The child's structured transcript (pi-ai Message[]). Optional: bg rows and older callers have none, and the monitor then falls back to plain output. */
	messages?: readonly Message[];
	source?: string;
}

export interface SubagentFleetActions {
	cancel?(runId: string): void;
	guide?(runId: string, guidance: string): void | string | Promise<void | string>;
	/** Run to bind when the monitor opens. If absent, the first construction-time run is bound. */
	initialRunId?: string;
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
 * Overlay placement for the monitor. The width and height follow the terminal, and the frame is
 * centered with only pi chrome reserved; dock rows may be covered. Pure, so the layout has a
 * test.
 */
export function monitorOverlayOptions(_termCols: number, termRows: number, _footerRows: number) {
	const rows = Math.max(1, termRows);
	const width = "80%" as const;
	const maxHeight = "80%" as const;
	const capRows = Math.floor(rows * 0.8) - 2;
	return {
		width,
		maxHeight,
		capRows,
		anchor: "center" as const,
		margin: { top: 1, left: 1, right: 1, bottom: FOOTER_CHROME_ROWS },
	};
}

/**
 * The footer's height right now: pi's chrome plus the dock's own line count. Read from the same
 * dock layout the dock draws with, so the reserve follows the dock as runs start and finish.
 */
export function footerRowsNow(): number {
	return FOOTER_CHROME_ROWS + dockRowCount();
}

const REFRESH_MS = 500;
const MAX_TASK_LEN = 64;
const MAX_SENT_GUIDES = 5;
const ANSI_ESCAPE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;
const SGR_SEQUENCE = /^\x1B\[[0-9;:]*m$/;

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

/** Child output keeps its SGR colour codes (ESC[...m). Every other control sequence is dropped. */
function outputText(value: string): string {
	return value.replace(ANSI_ESCAPE, (sequence) => (SGR_SEQUENCE.test(sequence) ? sequence : ""));
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

/** The last `maxLines` rows of the run's output, with SGR colour kept and each row cut to `width`. */
function renderOutput(
	run: SubagentFleetRun,
	width: number,
	theme: any,
	maxLines: number,
): string[] {
	const text = outputText(run.output || run.stderr || "(no output yet)");
	// The reset closes any colour the child left open, so it cannot tint the frame border.
	return text
		.split("\n")
		.slice(-maxLines)
		.map((line) => truncateToWidth(`${theme.fg("muted", `  ${line}`)}\x1B[0m`, width, ""));
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => part?.type === "text")
		.map((part) => part.text)
		.join("");
}

function transcriptHasUser(messages: readonly Message[] | undefined, prompt: string): boolean {
	return Boolean(messages?.some((message) => message.role === "user" && messageText(message.content) === prompt));
}

function renderTranscript(messages: readonly Message[], width: number, theme: any): string[] {
	const rows: string[] = [];
	const addLines = (text: string, prefix: string, color: string) => {
		for (const [index, line] of text.split("\n").entries()) {
			const linePrefix = index === 0 ? prefix : "  ";
			rows.push(truncateToWidth(theme.fg(color, `${linePrefix}${line}`), width, ""));
		}
	};
	for (const message of messages) {
		if (message.role === "user") {
			addLines(messageText(message.content), "> ", "accent");
		} else if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type === "text") addLines(part.text, "  ", "muted");
				else if (part.type === "toolCall")
					rows.push(truncateToWidth(theme.fg("muted", `  [tool] ${part.name}`), width, ""));
			}
		} else {
			const result = clean(messageText(message.content)).replace(/\s+/g, " ").trim().slice(0, 80);
			rows.push(
				truncateToWidth(
					theme.fg(message.isError ? "error" : "muted", `  [result] ${message.toolName} ${result}`),
					width,
					"",
				),
			);
		}
	}
	return rows;
}

/**
 * Fits the monitor body into `capRows` rows. A body that already fits is returned unchanged.
 * Otherwise the title and list rows stay, and the footer stays last. The middle (details
 * and output) gives way first and keeps its newest rows. Only when the list cannot fit above the
 * footer is it windowed around the selected run.
 */
function fitBody(
	top: string[],
	rows: string[],
	selected: number,
	middle: string[],
	footer: string[],
	capRows: number,
): string[] {
	const body = [...top, ...rows, ...middle, ...footer];
	if (body.length <= capRows) return body;
	const room = Math.max(0, capRows - footer.length);
	if (room >= top.length + rows.length) {
		const kept = room - top.length - rows.length;
		return [...top, ...rows, ...middle.slice(middle.length - kept), ...footer];
	}
	const listRows = Math.max(0, room - top.length);
	const start = Math.min(
		Math.max(0, selected - Math.floor(listRows / 2)),
		Math.max(0, rows.length - listRows),
	);
	return [...top.slice(0, room), ...rows.slice(start, start + listRows), ...footer];
}

type SentGuide = {
	prompt: string;
	state: "sending" | "done" | "failed";
	result: string;
};

class SubagentFleetComponent {
	private readonly initialRunId: string | undefined;
	private lastKnownRun: SubagentFleetRun | undefined;
	private readonly sent: SentGuide[] = [];
	private input = new Input();
	private closed = false;
	private cancelSent = false;
	private readonly refreshTimer: ReturnType<typeof setInterval>;

	constructor(
		private readonly tui: {
			requestRender(force?: boolean): void;
			terminal?: { rows: number; columns: number };
		},
		private readonly theme: any,
		private readonly keybindings: { matches(data: string, binding: string): boolean },
		private readonly done: () => void,
		private readonly snapshot: () => SubagentFleetRun[],
		private readonly actions: SubagentFleetActions,
		// The overlay options object pi-tui holds by reference. Mutating it in place is what moves
		// the frame, so the footer reserve follows the dock without reopening the monitor.
		private readonly liveOptions: {
			maxHeight: string;
			capRows: number;
			margin: { bottom: number };
		},
		initialRunId?: string,
	) {
		const initialRuns = snapshot();
		this.initialRunId = initialRunId ?? initialRuns[0]?.id;
		const initial = this.initialRunId
			? initialRuns.find((run) => run.id === this.initialRunId)
			: undefined;
		if (initial) this.lastKnownRun = { ...initial };
		this.input.focused = true;
		this.bindInput();
		this.refreshTimer = setInterval(() => {
			this.syncFooterReserve();
			this.tui.requestRender();
		}, REFRESH_MS);
		this.refreshTimer.unref?.();
	}

	private selectedRun(): { run: SubagentFleetRun | undefined; ended: boolean } {
		const current = this.initialRunId
			? this.snapshot().find((run) => run.id === this.initialRunId)
			: undefined;
		if (current) this.lastKnownRun = { ...current };
		return {
			run: current ?? this.lastKnownRun,
			ended: !current && this.lastKnownRun !== undefined,
		};
	}

	/**
	 * Re-derive the footer reserve from the dock's current rows and resize the frame in place.
	 * Called on the refresh timer, so the frame tracks the dock as runs start and finish.
	 */
	private syncFooterReserve(): void {
		const termRows = this.tui.terminal?.rows ?? 50;
		const termCols = this.tui.terminal?.columns ?? 120;
		const next = monitorOverlayOptions(termCols, termRows, footerRowsNow());
		this.liveOptions.capRows = next.capRows;
		this.liveOptions.margin.bottom = next.margin.bottom;
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		this.input.focused = false;
		clearInterval(this.refreshTimer);
		this.done();
	}

	private bindInput(): void {
		this.input.onSubmit = (value) => {
			const text = value.trim().slice(0, 16_384);
			const { run } = this.selectedRun();
			if (!text || !run || !this.canGuide(run)) return;
			const sent: SentGuide = { prompt: text, state: "sending", result: "" };
			this.sent.push(sent);
			if (this.sent.length > MAX_SENT_GUIDES) this.sent.splice(0, this.sent.length - MAX_SENT_GUIDES);
			this.input = new Input();
			this.input.focused = true;
			this.bindInput();
			void (async () => {
				try {
					const result = await this.actions.guide?.(run.id, text);
					sent.state = "done";
					sent.result = typeof result === "string" ? result.trim().slice(0, 240) : "";
				} catch (error) {
					sent.state = "failed";
					sent.result = String(error).slice(0, 240);
				}
				this.tui.requestRender();
			})();
			this.tui.requestRender();
		};
	}

	private canGuide(run: SubagentFleetRun): boolean {
		return run.source !== "bg" && !run.id.startsWith("bg:");
	}

	private promptLine(run: SubagentFleetRun | undefined, width: number): string {
		if (!run || !this.canGuide(run)) return this.theme.fg("muted", " bg tasks take no input");
		return truncateToWidth(`${this.input.render(Math.max(1, width - 2))}`, width, "");
	}

	render(width: number): string[] {
		const { run: selected, ended } = this.selectedRun();
		if (!selected) {
			return frame(
				[
					styleText("Subagent monitor", { bold: true }),
					this.theme.fg("muted", " No run selected."),
					"",
					this.theme.fg("muted", "Enter send · Esc interrupt · ctrl+q close"),
				],
				width,
				this.theme,
			);
		}
		const row = buildSubagentListRows([selected])[0];
		const rows = [truncateToWidth(this.theme.fg("accent", `› ${row}`), width, "")];
		// capRows is the overlay's percentage height in rows, excluding the frame borders.
		const capRows = this.liveOptions.capRows;
		// Title, one run row, and the four detail rows come before the output.
		const footerRows = 2;
		const statusLine = ended
			? `Run ended · status: ${selected.status} · ${duration(selected, Date.now())}`
			: `Status: ${selected.status} · ${duration(selected, Date.now())}`;
		const detailRows = [
			"",
			styleText(`Selected: ${oneLine(selected.agent, 32)} · ${selected.id}`, { bold: true }),
			this.theme.fg("muted", `Task: ${oneLine(taskTitle(selected.task), width - 8)}`),
			this.theme.fg(statusColor(selected.status), statusLine),
		];
		const middleRoom = Math.max(0, capRows - 1 - rows.length - footerRows);
		const pending = this.sent.filter((entry) => !transcriptHasUser(selected.messages, entry.prompt));
		const maxSentEntries = Math.floor(Math.max(0, middleRoom - detailRows.length - 1) / 2);
		const visibleSentCount =
			maxSentEntries ||
			(pending.length > 0 && middleRoom >= detailRows.length + 2 ? 1 : 0);
		const sentRows = (visibleSentCount > 0 ? pending.slice(-visibleSentCount) : []).flatMap((entry) => [
			this.theme.fg("accent", truncateToWidth(`> ${oneLine(entry.prompt, Math.max(1, width - 2))}`, width, "")),
			entry.state === "sending"
				? this.theme.fg("muted", "  sending…")
				: this.theme.fg(
						entry.state === "failed" ? "error" : "muted",
						`  ${oneLine(entry.result || (entry.state === "failed" ? "failed" : "delivered"), Math.max(1, width - 2))}`,
					),
		]);
		const outputBudget = Math.max(0, middleRoom - detailRows.length - sentRows.length);
		const outputRows =
			selected.messages && selected.messages.length > 0
				? renderTranscript(selected.messages, width, this.theme)
				: outputBudget > 0
					? renderOutput(selected, width, this.theme, outputBudget)
					: [];
		const footer = [
			this.promptLine(selected, width),
			this.theme.fg("muted", "Enter send · Esc interrupt · ctrl+q close"),
		];
		return frame(
			fitBody(
				[styleText(`Subagent monitor · ${oneLine(selected.agent, 32)}`, { bold: true })],
				rows,
				0,
				[...detailRows, ...outputRows, ...sentRows],
				footer,
				capRows,
			),
			width,
			this.theme,
		);
	}

	handleInput(data: string): void {
		if (this.closed) return;
		if (matchesKey(data, "ctrl+q")) {
			this.close();
			return;
		}
		if (data === "\x1b" || this.keybindings.matches(data, "tui.select.cancel")) {
			if (this.input.getValue()) {
				this.input.setValue("");
				this.tui.requestRender();
				return;
			}
			const { run } = this.selectedRun();
			if (run?.status === "running" && this.initialRunId && !this.cancelSent) {
				this.cancelSent = true;
				this.actions.cancel?.(this.initialRunId);
			}
			this.tui.requestRender();
			return;
		}
		this.input.handleInput(data);
		this.tui.requestRender();
	}

	invalidate(): void {
		this.input.invalidate();
	}
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
	let pickerBusyEntered = false;
	try {
		enterPicker();
		pickerBusyEntered = true;
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
					actions.initialRunId,
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
		if (pickerBusyEntered) exitPicker();
		if (activeInspectorClose === closeInspector) activeInspectorClose = undefined;
	}
}
