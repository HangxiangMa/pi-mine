/**
 * Grouped picker UI. Thin layer: it maps keys to PickerAction and renders PickerState. All
 * navigation and answer rules live in picker-state.ts, which is covered by its own tests.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	type PickerAction,
	type PickerQuestion,
	type PickerState,
	allAnswered,
	createPicker,
	markFor,
	onSubmitTab,
	otherIndex,
	reducePicker,
} from "./picker-state.ts";

export interface PickerResult {
	/** Chosen option text per question id, or undefined when the picker was cancelled. */
	readonly answers: Readonly<Record<string, string>> | undefined;
}

/**
 * Map a raw key sequence to a picker action, or undefined when the key is not bound.
 * While the free-text field is open (`editing`), printable keys are text, not navigation.
 */
export function actionForKey(
	data: string,
	onSubmit: boolean,
	editing = false,
): PickerAction | undefined {
	if (editing) return actionForTyping(data);
	if (matchesKey(data, "escape")) return { type: "escape" };
	if (matchesKey(data, "tab") || matchesKey(data, "right")) return { type: "next-tab" };
	if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) return { type: "prev-tab" };
	if (matchesKey(data, "up")) return { type: "cursor-up" };
	if (matchesKey(data, "down")) return { type: "cursor-down" };
	if (matchesKey(data, "enter")) return onSubmit ? undefined : { type: "choose" };
	return undefined;
}

/** Keys inside the open free-text field: printable characters type, Enter submits, Esc backs out. */
function actionForTyping(data: string): PickerAction | undefined {
	if (matchesKey(data, "escape")) return { type: "escape-text" };
	if (matchesKey(data, "enter")) return { type: "submit-text" };
	if (matchesKey(data, "backspace")) return { type: "backspace" };
	// A single printable character. Control sequences and multi-byte escape codes are not text.
	if (data.length === 1 && data >= " " && data !== "\x7f") return { type: "text", char: data };
	return undefined;
}

/** Turn a finished state into the answer map. Only a fully answered, uncancelled picker submits. */
export function resultFor(state: PickerState): PickerResult {
	if (state.cancelled || !allAnswered(state)) return { answers: undefined };
	const answers: Record<string, string> = {};
	state.questions.forEach((question, index) => {
		const chosen = state.answers[index];
		if (chosen === undefined) return;
		// The Other row has no preset label; its answer is the text the user typed.
		const typed = state.typed[index];
		answers[question.id] = typed ?? question.options[chosen];
	});
	return { answers };
}

type Paint = (text: string, role: PaintRole) => string;
/** Foreground roles the picker uses; each is a ThemeColor token in the host theme. */
type PaintRole = "accent" | "muted" | "dim" | "success";

/** Label shown on the trailing Other row. Its text is typed, so it has no preset answer. */
export const OTHER_LABEL = "Other: type your own answer";

/**
 * The answer shown for one question on the review page. It reads the same source as resultFor:
 * the typed text for an Other answer, the preset label otherwise. Using one rule keeps the page
 * and the submitted result from disagreeing.
 */
function answerText(question: PickerQuestion, state: PickerState, index: number): string {
	const chosen = state.answers[index];
	if (chosen === undefined) return "(unanswered)";
	return state.typed[index] ?? question.options[chosen];
}

/** Review page lines: one row per question with its answer. Pure, so the page is testable. */
export function renderReview(state: PickerState, paint: Paint): string[] {
	const rows = state.questions.map((question, index) => {
		return `  ${markFor(state, index)} ${question.label}: ${answerText(question, state, index)}`;
	});
	return [paint("Review your answers", "accent"), ...rows];
}

export function renderTabs(state: PickerState, paint: Paint): string {
	const tabs = state.questions.map((question, index) => {
		const label = `${markFor(state, index)} ${question.label}`;
		return index === state.tab ? paint(` ${label} `, "accent") : paint(` ${label} `, "muted");
	});
	const submitLabel = `${markFor(state, state.questions.length)} Submit`;
	tabs.push(
		onSubmitTab(state) ? paint(` ${submitLabel} `, "accent") : paint(` ${submitLabel} `, "muted"),
	);
	return tabs.join(" ");
}

/**
 * One question as a rounded card. Each preset option is a row, then the trailing Other row. The
 * row under the cursor carries a pointer. While the free-text field is open, the draft shows
 * under the Other row. Every interior row is padded to the card width, so the right border lines up.
 */
export function renderQuestionCard(
	question: PickerQuestion,
	state: PickerState,
	paint: Paint,
	width: number,
): string[] {
	const inner = Math.max(4, width - 2);
	const row = (content: string) => {
		const fitted = truncateToWidth(content, inner, "", true);
		const pad = Math.max(0, inner - visibleWidth(fitted));
		return `${paint("│", "dim")}${fitted}${" ".repeat(pad)}${paint("│", "dim")}`;
	};
	const rule = paint(`╭${"─".repeat(inner)}╮`, "dim");
	const bottom = paint(`╰${"─".repeat(inner)}╯`, "dim");

	const body: string[] = [row(` ${paint(question.label, "accent")}`)];
	const chosen = state.answers[state.tab];
	const typed = state.typed[state.tab];
	const rows = [...question.options, OTHER_LABEL];
	rows.forEach((option, index) => {
		const focused = index === state.cursor;
		const pointer = focused ? paint("›", "accent") : " ";
		const isOther = index === otherIndex(question);
		const isChosen = isOther ? chosen === index && typed !== undefined : chosen === index;
		const text = isChosen
			? paint(isOther ? `${typed}` : option, "success")
			: paint(option, focused ? "accent" : "muted");
		body.push(row(` ${pointer} ${text}`));
		// The text field sits directly under the Other row while it is open.
		if (isOther && focused && state.editing) {
			body.push(row(`     ${paint(`> ${state.draft}`, "accent")}${paint("▏", "accent")}`));
			body.push(row(`     ${paint("Enter to submit · Esc to go back", "dim")}`));
		}
	});
	return [rule, ...body, bottom];
}

/** Show the picker in the main session and resolve with the answers, or undefined on cancel. */
export async function runGroupedPicker(
	ctx: ExtensionContext,
	questions: readonly PickerQuestion[],
): Promise<PickerResult> {
	if (!ctx.hasUI) return { answers: undefined };
	return ctx.ui.custom<PickerResult>((tui, theme, _keybindings, done) => {
		let state = createPicker(questions);
		let cachedLines: string[] | undefined;
		const paint: Paint = (text, role) => theme.fg(role, text);

		const update = (action: PickerAction) => {
			state = reducePicker(state, action);
			cachedLines = undefined;
			if (state.cancelled) {
				done({ answers: undefined });
				return;
			}
			tui.requestRender();
		};

		return {
			render(width: number): string[] {
				if (cachedLines) return cachedLines;
				const lines: string[] = [];
				lines.push(truncateToWidth(renderTabs(state, paint), width));
				lines.push("");
				if (onSubmitTab(state)) {
					lines.push(...renderReview(state, paint));
					lines.push("");
					lines.push(
						allAnswered(state)
							? paint("Enter to submit · Esc to cancel", "dim")
							: paint("Answer every question before submitting · Esc to cancel", "dim"),
					);
				} else {
					lines.push(...renderQuestionCard(questions[state.tab], state, paint, width));
					lines.push("");
					lines.push(
						paint("Tab/→ next · Shift+Tab/← back · ↑↓ move · Enter choose · Esc cancel", "dim"),
					);
				}
				cachedLines = lines.map((line) => truncateToWidth(line, width));
				return cachedLines;
			},
			handleInput(data: string): void {
				// Enter on Submit submits, but only when every question is answered. Otherwise it is ignored.
				if (!state.editing && onSubmitTab(state) && matchesKey(data, "enter")) {
					if (allAnswered(state)) done(resultFor(state));
					return;
				}
				const action = actionForKey(data, onSubmitTab(state), state.editing);
				if (action) update(action);
			},
			invalidate(): void {
				cachedLines = undefined;
			},
		};
	});
}
