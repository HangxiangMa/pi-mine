/**
 * Pure validation for the ask_user_question tool. No UI, no I/O: the tool wrapper maps the
 * accepted questions onto the grouped picker, and this module decides what is accepted.
 *
 * Mirrors Claude Code's AskUserQuestion limits (2.1.286): 1 to 4 questions, 2 to 4 options each,
 * unique question texts, unique option labels within a question. Two Claude Code features are
 * deliberately rejected here, not silently dropped: multiSelect (the picker is single-select)
 * and per-option preview (the picker has no preview pane).
 */
import type { PickerQuestion } from "../grouped-picker/picker-state.ts";

export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_HEADER_CHARS = 12;

/** The picker adds its own Other row to every question, so a model-written Other would show twice. */
const RESERVED_OPTION_LABEL = "other";

/** Raw tool input as the model sends it. Fields are checked here, not trusted. */
export interface AskQuestionInput {
	readonly question: string;
	readonly header: string;
	readonly options: readonly {
		readonly label: string;
		readonly description?: string;
		readonly preview?: string;
	}[];
	readonly multiSelect?: boolean;
}

export type ValidationResult =
	| { readonly ok: true; readonly questions: readonly PickerQuestion[] }
	| { readonly ok: false; readonly error: string };

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

/**
 * Check every question and return picker questions. The first problem found is reported, so the
 * model gets one actionable message instead of a list it has to parse.
 */
export function validateAskQuestions(input: { readonly questions?: unknown }): ValidationResult {
	const list = input.questions;
	if (!Array.isArray(list) || list.length < 1 || list.length > MAX_QUESTIONS) {
		return { ok: false, error: `questions must be a list of 1 to ${MAX_QUESTIONS} items` };
	}
	const questions: PickerQuestion[] = [];
	const seenQuestions = new Set<string>();
	for (let index = 0; index < list.length; index += 1) {
		const item = list[index] as Partial<AskQuestionInput> | null;
		const at = `questions[${index}]`;
		if (typeof item !== "object" || item === null)
			return { ok: false, error: `${at} must be an object` };
		if (!nonEmpty(item.question))
			return { ok: false, error: `${at}.question must be a non-empty string` };
		if (!nonEmpty(item.header))
			return { ok: false, error: `${at}.header must be a non-empty string` };
		if (item.header.length > MAX_HEADER_CHARS) {
			return { ok: false, error: `${at}.header must be at most ${MAX_HEADER_CHARS} characters` };
		}
		if (item.multiSelect === true) {
			return {
				ok: false,
				error: `${at}.multiSelect is not supported; ask one choice per question`,
			};
		}
		if (seenQuestions.has(item.question)) {
			return { ok: false, error: `question texts must be unique; "${item.question}" repeats` };
		}
		seenQuestions.add(item.question);
		if (
			!Array.isArray(item.options) ||
			item.options.length < MIN_OPTIONS ||
			item.options.length > MAX_OPTIONS
		) {
			return {
				ok: false,
				error: `${at}.options must have ${MIN_OPTIONS} to ${MAX_OPTIONS} entries`,
			};
		}
		const labels = new Set<string>();
		for (let option = 0; option < item.options.length; option += 1) {
			const entry = item.options[option] as { label?: unknown; preview?: unknown } | null;
			if (typeof entry !== "object" || entry === null || !nonEmpty(entry.label)) {
				return { ok: false, error: `${at}.options[${option}].label must be a non-empty string` };
			}
			if (entry.preview !== undefined) {
				return {
					ok: false,
					error: `${at}.options[${option}].preview is not supported in this picker`,
				};
			}
			if (entry.label.trim().toLowerCase() === RESERVED_OPTION_LABEL) {
				return {
					ok: false,
					error: `${at}.options[${option}] "${entry.label}" is reserved: the picker already adds an Other row, so remove this option`,
				};
			}
			if (labels.has(entry.label)) {
				return { ok: false, error: `${at} option labels must be unique; "${entry.label}" repeats` };
			}
			labels.add(entry.label);
		}
		questions.push({
			id: `q${index}`,
			label: item.header,
			options: item.options.map((entry) => entry.label),
		});
	}
	return { ok: true, questions };
}
