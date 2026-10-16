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
	/** Typed text per question, set only when the answer came from the Other row. */
	readonly typed: readonly (string | undefined)[];
	/** Highlighted row on the current question tab; the Other row is otherIndex(question). */
	readonly cursor: number;
	/** True while the free-text field under the Other row is open. */
	readonly editing: boolean;
	/** Text being typed in the open field. Discarded on Escape. */
	readonly draft: string;
	readonly cancelled: boolean;
}

export type PickerAction =
	| { readonly type: "next-tab" }
	| { readonly type: "prev-tab" }
	| { readonly type: "cursor-up" }
	| { readonly type: "cursor-down" }
	| { readonly type: "choose" }
	| { readonly type: "escape" }
	| { readonly type: "text"; readonly char: string }
	| { readonly type: "backspace" }
	| { readonly type: "submit-text" }
	| { readonly type: "escape-text" };

export const CHECKED_MARK = "\u2612";
export const UNCHECKED_MARK = "\u2610";
export const SUBMIT_MARK = "\u221A";

export function createPicker(questions: readonly PickerQuestion[]): PickerState {
	return {
		questions,
		tab: 0,
		answers: questions.map(() => undefined),
		typed: questions.map(() => undefined),
		cursor: 0,
		editing: false,
		draft: "",
		cancelled: false,
	};
}

/** Index of the trailing Other row for a question. It sits after the last preset option. */
export function otherIndex(question: PickerQuestion): number {
	return question.options.length;
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
	// While the free-text field is open, only the text actions apply. Navigation keys are inert,
	// so a stray arrow cannot move the cursor under a half-typed answer.
	if (state.editing) return reduceEditing(state, action);
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
			const last = otherIndex(state.questions[state.tab]);
			return { ...state, cursor: Math.min(last, state.cursor + 1) };
		}
		case "choose": {
			if (onSubmitTab(state)) return state;
			// The Other row opens the free-text field instead of answering. The tab stays put until
			// the typed text is submitted.
			if (state.cursor === otherIndex(state.questions[state.tab])) {
				return { ...state, editing: true, draft: "" };
			}
			const answers = state.answers.map((answer, index) =>
				index === state.tab ? state.cursor : answer,
			);
			const typed = state.typed.map((value, index) => (index === state.tab ? undefined : value));
			// Answering moves to the next tab, clamped so the last question stays on its tab.
			const advanced = { ...state, answers, typed };
			return clampTab(advanced, state.tab + 1);
		}
		case "escape":
			return { ...state, cancelled: true };
		case "text":
		case "backspace":
		case "submit-text":
		case "escape-text":
			// Text actions outside the field have no meaning.
			return state;
	}
}

/** Reducer for the open free-text field. Only text actions and Escape are meaningful here. */
function reduceEditing(state: PickerState, action: PickerAction): PickerState {
	switch (action.type) {
		case "text":
			return { ...state, draft: state.draft + action.char };
		case "backspace":
			return { ...state, draft: state.draft.slice(0, -1) };
		case "submit-text": {
			const text = state.draft.trim();
			// Empty text is not an answer. The field stays open so the user can type one.
			if (text.length === 0) return state;
			const index = state.tab;
			const answers = state.answers.map((answer, i) =>
				i === index ? otherIndex(state.questions[index]) : answer,
			);
			const typed = state.typed.map((value, i) => (i === index ? text : value));
			const closed = { ...state, answers, typed, editing: false, draft: "" };
			return clampTab(closed, state.tab + 1);
		}
		case "escape-text":
			// Leaves the field and discards the draft. The picker itself stays open.
			return { ...state, editing: false, draft: "" };
		default:
			// Navigation and cancel keys do nothing while typing.
			return state;
	}
}
