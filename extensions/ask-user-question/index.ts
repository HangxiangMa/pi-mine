/**
 * ask_user_question: let the model ask the user a multiple-choice question during normal work,
 * the way Claude Code's AskUserQuestion does. It is always visible (CORE_TOOLS in tool-search),
 * not gated by Plan mode, and it reuses the grouped picker the planner already uses.
 *
 * Use only for a decision the user must make. Claude Code 2.1.286 reserves the tool for a
 * decision whose answer changes the next step; a choice with a sensible default is made directly.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runGroupedPicker } from "../grouped-picker/grouped-picker.ts";
import { type AskQuestionInput, MIN_OPTIONS, validateAskQuestions } from "./validate.ts";

export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";

const DESCRIPTION =
	"Ask the user multiple-choice questions and wait for their answers. Use only when blocked on a decision that is genuinely the user's to make: one whose answer changes what you do next. For a choice with a conventional default, or a fact you can check in the code, pick the obvious option, say so, and proceed.";

const PROMPT_GUIDELINES = [
	"Use ask_user_question only when blocked on a decision that is the user's to make. Do not use it for choices with a conventional default or facts you can verify yourself.",
	"Ask 1 to 4 questions. Each has 2 to 4 options with distinct labels and a header of at most 12 characters.",
	"Put the recommended option first and add (Recommended) to its label.",
	"Do not add an Other option; the user can always type a custom answer.",
	"Do not use it to ask whether a plan is ready or whether to proceed. Plan approval belongs to the plan tools.",
];

const OPTION = Type.Object({
	label: Type.String({ description: "Short option text the user sees (1 to 5 words)." }),
	description: Type.Optional(
		Type.String({ description: "What the option means or changes. Optional." }),
	),
});

const QUESTION = Type.Object({
	question: Type.String({ description: "The full question, ending with a question mark." }),
	header: Type.String({ description: "Short tab label, at most 12 characters." }),
	options: Type.Array(OPTION, { minItems: MIN_OPTIONS, maxItems: 4 }),
	multiSelect: Type.Optional(
		Type.Boolean({ description: "Not supported. Leave unset; ask one choice per question." }),
	),
});

const PARAMETERS = Type.Object({
	questions: Type.Array(QUESTION, { minItems: 1, maxItems: 4 }),
});

interface ToolResultDetails {
	readonly cancelled: boolean;
	readonly reason?: "ui_unavailable" | "invalid_input" | "cancelled";
	readonly questions: readonly string[];
	readonly answers?: Readonly<Record<string, string>>;
}

function textResult(text: string, details: ToolResultDetails) {
	return { content: [{ type: "text" as const, text }], details };
}

/**
 * Map the picker's answers (keyed by q0, q1, ...) back to each question's text, so the model
 * reads "question text" = "answer" as Claude Code returns it.
 */
function keyByQuestionText(
	questions: readonly AskQuestionInput[],
	answers: Readonly<Record<string, string>>,
): Record<string, string> {
	const out: Record<string, string> = {};
	questions.forEach((question, index) => {
		const answer = answers[`q${index}`];
		if (answer !== undefined) out[question.question] = answer;
	});
	return out;
}

export default function askUserQuestion(pi: ExtensionAPI): void {
	pi.registerTool({
		name: ASK_USER_QUESTION_TOOL_NAME,
		label: "Ask user",
		description: DESCRIPTION,
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: PARAMETERS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const questions = (params.questions ?? []) as AskQuestionInput[];
			const asked = questions.map((question) => question.question);

			const checked = validateAskQuestions({ questions });
			if (!checked.ok) {
				return textResult(`Error: ${checked.error}`, {
					cancelled: true,
					reason: "invalid_input",
					questions: asked,
				});
			}
			if (!ctx.hasUI) {
				return textResult(
					"Unable to ask the user: interactive UI is not available. Ask the question in plain text instead.",
					{ cancelled: true, reason: "ui_unavailable", questions: asked },
				);
			}

			const picked = await runGroupedPicker(ctx, checked.questions);
			if (picked.answers === undefined) {
				return textResult(
					"The user cancelled the questions without answering. Continue without these answers, or ask again in plain text if the missing answer is high impact.",
					{ cancelled: true, reason: "cancelled", questions: asked },
				);
			}

			const answers = keyByQuestionText(questions, picked.answers);
			const lines = Object.entries(answers).map(([text, answer]) => `"${text}"="${answer}"`);
			return textResult(
				`User has answered your questions: ${lines.join(", ")}. You can now continue with the user's answers in mind.`,
				{ cancelled: false, questions: asked, answers },
			);
		},
	});
}
