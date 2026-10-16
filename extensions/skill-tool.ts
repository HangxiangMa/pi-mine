import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync } from "node:fs";

function stripFrontmatter(content: string): string {
	if (!content.startsWith("---")) return content.trim();
	const end = content.indexOf("\n---", 3);
	if (end === -1) return content.trim();
	return content
		.slice(end + "\n---".length)
		.replace(/^\r?\n/, "")
		.trim();
}

export default function skillTool(pi: ExtensionAPI): void {
	let skills: Skill[] = [];

	pi.on("before_agent_start", (event) => {
		skills = event.systemPromptOptions?.skills ?? [];
		return undefined;
	});

	pi.registerTool({
		name: "skill",
		label: "Skill",
		description: "Load a skill's full instructions and workflow by exact name.",
		promptSnippet: "Load a skill's full instructions by name",
		promptGuidelines: [
			"skill: load a skill by exact name when its description matches the task; do not reload one already loaded in this conversation.",
		],
		parameters: Type.Object(
			{
				name: Type.String({ minLength: 1, description: "The exact name of the skill to load." }),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params) {
			const requested = params.name.trim().toLowerCase();
			const skill = skills.find((candidate) => candidate.name.toLowerCase() === requested);
			if (!skill) {
				const list =
					skills
						.filter((candidate) => !candidate.disableModelInvocation)
						.map((candidate) => candidate.name)
						.join(", ") || "none";
				return {
					isError: true,
					content: [{ type: "text", text: `Unknown skill "${params.name}". Available: ${list}` }],
					details: undefined,
				};
			}

			if (skill.disableModelInvocation) {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: `Skill "${skill.name}" is user-only; the user must invoke it with /skill:${skill.name}.`,
						},
					],
					details: undefined,
				};
			}

			let body: string;
			try {
				body = stripFrontmatter(readFileSync(skill.filePath, "utf8"));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					isError: true,
					content: [{ type: "text", text: `Failed to read skill "${skill.name}": ${message}` }],
					details: undefined,
				};
			}

			if (!body) {
				return {
					isError: true,
					content: [{ type: "text", text: `Skill "${skill.name}" has an empty body.` }],
					details: undefined,
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `Base directory for this skill: ${skill.baseDir}\n\n${body}`,
					},
				],
				details: { name: skill.name, filePath: skill.filePath, baseDir: skill.baseDir },
			};
		},
	});
}
