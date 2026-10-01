import { truncateToWidth } from "@earendil-works/pi-tui";

const MAX_TASK_TITLE_LENGTH = 48;
const TITLE_PREFIX = /^(?:title|task|objective|goal|purpose|summary)\s*[:：]\s*/i;

/** Reduce delegated prompt text to one short, display-safe task title. */
export function taskTitle(task: string | undefined, fallback = "task"): string {
	const text = (task ?? "").split("\n\n--- Return contract (injected")[0];
	const lines = text
		.split(/\r?\n/)
		.map((line) => line.replace(/\s+/g, " ").trim())
		.filter(Boolean);
	const marked = lines.find((line) => TITLE_PREFIX.test(line));
	const title = (marked ?? lines[0] ?? fallback).replace(TITLE_PREFIX, "").trim();
	if (!title) return fallback;
	return truncateToWidth(title, MAX_TASK_TITLE_LENGTH, "…");
}
