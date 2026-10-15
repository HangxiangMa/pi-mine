/**
 * Grouped picker UI. Thin layer: it maps keys to PickerAction and renders PickerState. All
 * navigation and answer rules live in picker-state.ts, which is covered by its own tests.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
	type PickerAction,
	type PickerQuestion,
	type PickerState,
	allAnswered,
	createPicker,
	markFor,
	onSubmitTab,
	reducePicker,
} from "./picker-state.ts";

export interface PickerResult {
	/** Chosen option text per question id, or undefined when the picker was cancelled. */
	readonly answers: Readonly<Record<string, string>> | undefined;
}

/** Map a raw key sequence to a picker action, or undefined when the key is not bound. */
export function actionForKey(data: string, onSubmit: boolean): PickerAction | undefined {
	if (matchesKey(data, "escape")) return { type: "escape" };
	if (matchesKey(data, "tab") || matchesKey(data, "right")) return { type: "next-tab" };
	if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) return { type: "prev-tab" };
	if (matchesKey(data, "up")) return { type: "cursor-up" };
	if (matchesKey(data, "down")) return { type: "cursor-down" };
	if (matchesKey(data, "enter")) return onSubmit ? undefined : { type: "choose" };
	return undefined;
}

/** Turn a finished state into the answer map. Only a fully answered, uncancelled picker submits. */
export function resultFor(state: PickerState): PickerResult {
	if (state.cancelled || !allAnswered(state)) return { answers: undefined };
	const answers: Record<string, string> = {};
	state.questions.forEach((question, index) => {
		const chosen = state.answers[index];
		if (chosen !== undefined) answers[question.id] = question.options[chosen];
	});
	return { answers };
}

type Paint = (text: string, role: PaintRole) => string;
/** Foreground roles the picker uses; each is a ThemeColor token in the host theme. */
type PaintRole = "accent" | "muted" | "dim" | "success";

function renderTabs(state: PickerState, paint: Paint): string {
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

function renderQuestion(question: PickerQuestion, state: PickerState, paint: Paint): string[] {
	const lines = [paint(question.label, "accent")];
	question.options.forEach((option, index) => {
		const focused = index === state.cursor;
		const chosen = state.answers[state.tab] === index;
		const pointer = focused ? paint("›", "accent") : " ";
		const text = chosen ? paint(option, "success") : paint(option, focused ? "accent" : "muted");
		lines.push(`${pointer} ${text}`);
	});
	return lines;
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
					lines.push(paint("Review your answers", "accent"));
					questions.forEach((question, index) => {
						const chosen = state.answers[index];
						const value = chosen === undefined ? "(unanswered)" : question.options[chosen];
						lines.push(`  ${markFor(state, index)} ${question.label}: ${value}`);
					});
					lines.push("");
					lines.push(
						allAnswered(state)
							? paint("Enter to submit · Esc to cancel", "dim")
							: paint("Answer every question before submitting · Esc to cancel", "dim"),
					);
				} else {
					lines.push(...renderQuestion(questions[state.tab], state, paint));
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
				if (onSubmitTab(state) && matchesKey(data, "enter")) {
					if (allAnswered(state)) done(resultFor(state));
					return;
				}
				const action = actionForKey(data, onSubmitTab(state));
				if (action) update(action);
			},
			invalidate(): void {
				cachedLines = undefined;
			},
		};
	});
}
