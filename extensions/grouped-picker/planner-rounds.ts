/**
 * Planner question loop. Pure control flow: every effect (read the planner's text, show the
 * picker, resume the planner) is a dependency, so each branch is testable with fakes. The real
 * wiring lives in subagent/index.ts and passes runSingleAgent, the picker, and the parser in.
 */
import { MAX_PLANNER_ROUNDS, answerTask, cancelledNotice } from "./answer-task.ts";
import type { QuestionBlock } from "./question-block.ts";

export interface PlannerRoundsDeps {
	/** Final assistant text of the latest planner run. */
	readonly outputOf: () => string;
	/** Parse a question block out of the text; undefined when none is present or it is invalid. */
	readonly parseBlock: (text: string) => QuestionBlock | undefined;
	/** False when there is no UI, so the questions are returned as text instead of shown. */
	readonly hasUI: boolean;
	/** Show the picker. Resolves with answers keyed by question id, or undefined if cancelled. */
	readonly ask: (block: QuestionBlock) => Promise<Readonly<Record<string, string>> | undefined>;
	/** Resume the planner in place with the answer prompt, then read its new output. */
	readonly resume: (task: string) => Promise<void>;
}

export interface PlannerRoundsOutcome {
	/** Final text the main session receives. */
	readonly text: string;
	/** How many follow-up rounds the planner was resumed for. */
	readonly rounds: number;
	readonly cancelled: boolean;
}

/**
 * Run the question loop. Returns the final planner text. A malformed or missing block returns the
 * current text unchanged, so the model sees exactly what the planner wrote.
 */
export async function runPlannerRounds(deps: PlannerRoundsDeps): Promise<PlannerRoundsOutcome> {
	let rounds = 0;
	for (;;) {
		const text = deps.outputOf();
		const block = deps.parseBlock(text);
		if (!block) return { text, rounds, cancelled: false };
		if (!deps.hasUI) return { text, rounds, cancelled: false };
		if (rounds >= MAX_PLANNER_ROUNDS) return { text, rounds, cancelled: false };

		const answers = await deps.ask(block);
		if (answers === undefined) {
			return { text: cancelledNotice(block.questions), rounds, cancelled: true };
		}
		rounds += 1;
		await deps.resume(answerTask(block.questions, answers));
	}
}
