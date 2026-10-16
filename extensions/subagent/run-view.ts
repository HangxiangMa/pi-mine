import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { SubagentFleetRun } from "./fleet-inspector.ts";

export type SendDecision =
	| { action: "steer" | "continue" | "guide" | "noop" }
	| { action: "refuse"; reason: string };

export function sendDecision(
	kind: "sub" | "delegate",
	runState: "running" | "finished" | "missing",
	text: string,
): SendDecision {
	if (!text.trim()) return { action: "noop" };
	if (kind === "delegate") {
		if (runState === "running") return { action: "guide" };
		return { action: "refuse", reason: "Delegate runs can only receive prompts while running." };
	}
	if (runState === "running") return { action: "steer" };
	// Missing in memory may still be in the persisted store. The resume resolver checks it.
	return { action: "continue" };
}

/** No agent-name matching or first-run fallback: a row must name its exact run. */
export function runIdForRow(
	rowId: string,
	rowRuns: ReadonlyMap<string, string>,
): string | undefined {
	if (rowId.startsWith("delegate:")) return rowId.slice("delegate:".length) || undefined;
	return rowId.startsWith("sub:") ? rowRuns.get(rowId) : undefined;
}

export type PromptDisposition = "queued" | "continued" | `refused: ${string}`;
export interface SentPrompt {
	text: string;
	disposition: PromptDisposition;
}
export interface RunViewActions {
	snapshot(): SubagentFleetRun | undefined;
	send(text: string): PromptDisposition | undefined;
	/** Cancel the live run. Returns a short status line for the view, or undefined when nothing is running. */
	cancel?(): string | undefined;
}

export const PROMPT_HINT = "Enter send · Esc close · c cancel (empty prompt)";
/** Cancel key. Only acts on an empty prompt, so typing a `c` into a prompt is never lost. */
export function isCancelKey(data: string, promptText: string): boolean {
	return data === "c" && promptText.length === 0;
}
const MAX_PROMPT_CHARS = 16_384;
const ANSI_ESCAPE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;
const clean = (text: string) =>
	text.replace(ANSI_ESCAPE, "").replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");
const oneLine = (text: string) => clean(text).replace(/\s+/g, " ").trim();

/** Pure, width/height-bounded rendering. Input's rendered cursor marker is kept intact. */
export function renderRunLines(
	run: SubagentFleetRun | undefined,
	width: number,
	prompts: readonly SentPrompt[] = [],
	now = Date.now(),
	inputLines: string[] = ["> "],
	maxRows = 24,
): string[] {
	maxRows = Math.max(0, Math.floor(maxRows));
	if (!maxRows) return [];
	if (width < 3) return [truncateToWidth(PROMPT_HINT, Math.max(0, width), "")];
	const inner = width - 2;
	const seconds = run
		? Math.max(0, Math.floor(((run.finishedAt ?? now) - run.startedAt) / 1000))
		: 0;
	const elapsed =
		seconds < 60
			? `${seconds}s`
			: `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
	const header = run
		? [
				`Subagent: ${oneLine(run.agent)} · ${oneLine(run.model ?? "model unknown")}`,
				`Status: ${run.status} · ${elapsed} · ↑${run.inputTokens.toLocaleString()} ↓${run.outputTokens.toLocaleString()}`,
			]
		: ["Subagent: unavailable", "Status: missing · no run mapped to this row"];
	if (maxRows < 7) {
		return [inputLines[0] ?? "> ", PROMPT_HINT, ...header]
			.slice(0, maxRows)
			.map((line) => truncateToWidth(line, width, ""));
	}
	const output = clean(run?.output || run?.stderr || "(no output yet)")
		.split("\n")
		.slice(-10)
		.map((line) => `  ${line}`);
	const history = prompts
		.slice(-3)
		.map(({ text, disposition }) => `${oneLine(disposition)} · ${oneLine(text)}`);
	const hintRoom = Math.max(1, maxRows - 2 - header.length - 2);
	const bottom = [
		"─ Prompt ─",
		inputLines[0] ?? "> ",
		...wrapTextWithAnsi(PROMPT_HINT, inner).slice(0, hintRoom),
	];
	// Prefer dropping output/history to hiding the prompt on a short terminal.
	const room = Math.max(0, maxRows - 2 - header.length - bottom.length);
	const recent = room ? history.slice(-Math.min(3, room)) : [];
	const outputRoom = Math.max(0, room - recent.length);
	const lines = [...header, ...(outputRoom ? output.slice(-outputRoom) : []), ...recent, ...bottom];
	return [
		`╭${"─".repeat(inner)}╮`,
		...lines.map((line) => {
			const text = truncateToWidth(line, inner, "");
			return `│${text}${" ".repeat(Math.max(0, inner - visibleWidth(text)))}│`;
		}),
		`╰${"─".repeat(inner)}╯`,
	];
}

/** Owns only view-local state; closing never cancels the child or a continuation. */
export class SubagentRunComponent {
	private input = new Input();
	private readonly prompts: SentPrompt[] = [];
	private closed = false;
	private readonly refreshTimer: ReturnType<typeof setInterval>;
	private readonly tui: { requestRender(): void; terminal?: { rows: number } };
	private readonly actions: RunViewActions;
	private readonly done: () => void;

	constructor(
		tui: { requestRender(): void; terminal?: { rows: number } },
		actions: RunViewActions,
		done: () => void,
	) {
		this.tui = tui;
		this.actions = actions;
		this.done = done;
		this.bindInput();
		this.refreshTimer = setInterval(() => this.tui.requestRender(), 500);
		this.refreshTimer.unref?.();
	}

	get focused(): boolean {
		return this.input.focused;
	}
	set focused(value: boolean) {
		this.input.focused = value;
	}

	private bindInput(): void {
		this.input.onEscape = () => this.close();
		this.input.onSubmit = (value) => {
			const text = value.trim().slice(0, MAX_PROMPT_CHARS);
			if (!text) return;
			let disposition: PromptDisposition | undefined;
			try {
				disposition = this.actions.send(text);
			} catch (error) {
				disposition = `refused: ${String(error).slice(0, 512)}`;
			}
			if (!disposition) return;
			this.prompts.push({
				text: text.slice(0, 1024),
				disposition: disposition.slice(0, 512) as PromptDisposition,
			});
			if (this.prompts.length > 3) this.prompts.shift();
			// Also release Input's undo/kill history after each submission.
			const focused = this.focused;
			this.input = new Input();
			this.focused = focused;
			this.bindInput();
			this.tui.requestRender();
		};
	}

	handleInput(data: string): void {
		if (this.closed) return;
		// `c` cancels only while the prompt is empty; otherwise Input types it.
		if (isCancelKey(data, this.input.getValue()) && this.actions.cancel) {
			this.actions.cancel();
			this.tui.requestRender();
			return;
		}
		// Input owns editing (including Ctrl+K), submit and escape.
		this.input.handleInput(data);
		if (this.input.getValue().length > MAX_PROMPT_CHARS)
			this.input.setValue(this.input.getValue().slice(0, MAX_PROMPT_CHARS));
		this.tui.requestRender();
	}

	render(width: number): string[] {
		return renderRunLines(
			this.actions.snapshot(),
			width,
			this.prompts,
			Date.now(),
			this.input.render(Math.max(1, width - 2)),
			Math.max(1, (this.tui.terminal?.rows ?? 26) - 2),
		);
	}

	invalidate(): void {
		this.input.invalidate();
	}
	dispose(): void {
		this.closed = true;
		clearInterval(this.refreshTimer);
	}
	private close(): void {
		if (this.closed) return;
		this.dispose();
		this.done();
	}
}

export async function openSubagentRunView(
	ctx: ExtensionContext,
	actions: RunViewActions,
): Promise<void> {
	if (!ctx.hasUI || typeof ctx.ui.custom !== "function") return;
	let component: SubagentRunComponent | undefined;
	try {
		await ctx.ui.custom<void>(
			(tui, _theme, _keybindings, done) => {
				component = new SubagentRunComponent(tui, actions, () => done());
				return component;
			},
			{
				overlay: true,
				overlayOptions: { width: "100%", anchor: "center", margin: { top: 1, bottom: 1 } },
				onHandle: (handle) => handle.focus(),
			},
		);
	} finally {
		component?.dispose();
	}
}
