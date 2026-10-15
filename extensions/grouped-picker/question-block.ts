/**
 * Parse the structured question block a planner subagent emits in its final text.
 *
 * Contract (same fenced-JSON convention as subagent/packet.ts parseTaskPacket):
 *
 *   ```question
 *   {"questions":[{"id":"scope","label":"Scope","options":["narrow","broad"]}]}
 *   ```
 *
 * Rules: 1 to 4 questions; each id unique and non-empty; each label non-empty; 2 to 4 options,
 * each a non-empty string. Anything else is rejected with undefined. The parser never repairs
 * or partially accepts a block, so a malformed question cannot silently change what is asked.
 */

export interface QuestionSpec {
	readonly id: string;
	readonly label: string;
	readonly options: readonly string[];
}

export interface QuestionBlock {
	readonly questions: readonly QuestionSpec[];
}

export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;

const FENCE = /```question[ \t]*\r?\n([\s\S]*?)```/i;

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function parseQuestion(value: unknown): QuestionSpec | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (!isNonEmptyString(record.id) || !isNonEmptyString(record.label)) return undefined;
	if (!Array.isArray(record.options)) return undefined;
	if (record.options.length < MIN_OPTIONS || record.options.length > MAX_OPTIONS) return undefined;
	if (!record.options.every(isNonEmptyString)) return undefined;
	return { id: record.id, label: record.label, options: [...record.options] };
}

/** Return the parsed block, or undefined when there is no fence or it is invalid. */
export function parseQuestionBlock(text: string): QuestionBlock | undefined {
	const match = FENCE.exec(text);
	if (!match) return undefined;
	let raw: unknown;
	try {
		raw = JSON.parse(match[1]);
	} catch {
		return undefined;
	}
	if (typeof raw !== "object" || raw === null) return undefined;
	const list = (raw as Record<string, unknown>).questions;
	if (!Array.isArray(list) || list.length < 1 || list.length > MAX_QUESTIONS) return undefined;
	const questions: QuestionSpec[] = [];
	for (const item of list) {
		const question = parseQuestion(item);
		if (!question) return undefined;
		questions.push(question);
	}
	const ids = new Set(questions.map((question) => question.id));
	if (ids.size !== questions.length) return undefined;
	return { questions };
}
