/**
 * Pure state for the grouped picker. No TUI, no I/O: the UI maps keys to these actions.
 *
 * Rules follow Claude Code's AskUserQuestion picker:
 * - Tabs are the questions plus a final Submit tab. Tab/Right move forward and Shift+Tab/Left
 *   move back. Both clamp at the ends and never wrap.
 * - An answered question shows the checked mark, an unanswered one the empty mark; the Submit
 *   tab shows the tick.
 * - Escape in the option list cancels the whole picker, not just the title row.
 */

export interface PickerQuestion {
	readonly id: string;
	readonly label: string;
	readonly options: readonly string[];
}

export interface PickerState {
	readonly questions: readonly PickerQuestion[];
	/** Index into questions; equals questions.length when on the Submit tab. */
	readonly tab: number;
	/** Chosen option index per question, or undefined while unanswered. */
	readonly answers: readonly (number | undefined)[];
	/** Highlighted option index on the current question tab. */
	readonly cursor: number;
	readonly cancelled: boolean;
}

export type PickerAction =
	| { readonly type: "next-tab" }
	| { readonly type: "prev-tab" }
	| { readonly type: "cursor-up" }
	| { readonly type: "cursor-down" }
	| { readonly type: "choose" }
	| { readonly type: "escape" };

export const CHECKED_MARK = "\u2612";
export const UNCHECKED_MARK = "\u2610";
export const SUBMIT_MARK = "\u221A";

export function createPicker(questions: readonly PickerQuestion[]): PickerState {
	return {
		questions,
		tab: 0,
		answers: questions.map(() => undefined),
		cursor: 0,
		cancelled: false,
	};
}

/** Number of tabs including Submit. */
export function tabCount(state: PickerState): number {
	return state.questions.length + 1;
}

export function onSubmitTab(state: PickerState): boolean {
	return state.tab === state.questions.length;
}

export function allAnswered(state: PickerState): boolean {
	return state.answers.every((answer) => answer !== undefined);
}

export function markFor(state: PickerState, index: number): string {
	if (index === state.questions.length) return SUBMIT_MARK;
	return state.answers[index] === undefined ? UNCHECKED_MARK : CHECKED_MARK;
}

function clampTab(state: PickerState, tab: number): PickerState {
	const last = tabCount(state) - 1;
	const next = Math.min(last, Math.max(0, tab));
	return { ...state, tab: next, cursor: state.answers[next] ?? 0 };
}

export function reducePicker(state: PickerState, action: PickerAction): PickerState {
	if (state.cancelled) return state;
	switch (action.type) {
		case "next-tab":
			return clampTab(state, state.tab + 1);
		case "prev-tab":
			return clampTab(state, state.tab - 1);
		case "cursor-up":
			if (onSubmitTab(state)) return state;
			return { ...state, cursor: Math.max(0, state.cursor - 1) };
		case "cursor-down": {
			if (onSubmitTab(state)) return state;
			const last = state.questions[state.tab].options.length - 1;
			return { ...state, cursor: Math.min(last, state.cursor + 1) };
		}
		case "choose": {
			if (onSubmitTab(state)) return state;
			const answers = state.answers.map((answer, index) =>
				index === state.tab ? state.cursor : answer,
			);
			// Answering moves to the next tab, clamped so the last question stays on its tab.
			const advanced = { ...state, answers };
			return clampTab(advanced, state.tab + 1);
		}
		case "escape":
			return { ...state, cancelled: true };
	}
}
