/**
 * Turn the user's picker answers into the follow-up task sent to the planner on resume.
 * Pure, so the exact text the planner receives is testable without a model or a TUI.
 */
import type { QuestionSpec } from "./question-block.ts";

/** Maximum planner question rounds per call. Matches planner.md: ask at most one round. */
export const MAX_PLANNER_ROUNDS = 1;

/**
 * Format answers as the resume prompt. Questions stay in their original order, and an
 * unanswered question is named explicitly rather than dropped.
 */
export function answerTask(
	questions: readonly QuestionSpec[],
	answers: Readonly<Record<string, string>>,
): string {
	const lines = questions.map((question) => {
		const answer = answers[question.id];
		return `- ${question.label}: ${answer ?? "(no answer)"}`;
	});
	return [
		"The user answered your questions:",
		...lines,
		"Continue the plan using these answers. Do not ask the same questions again.",
	].join("\n");
}

/** Text returned to the main session when the user cancels the picker. */
export function cancelledNotice(questions: readonly QuestionSpec[]): string {
	const labels = questions.map((question) => question.label).join(", ");
	return `The user cancelled these questions without answering: ${labels}. No plan was resumed.`;
}
