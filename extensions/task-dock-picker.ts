/**
 * The unified task picker behind the dock's ↓ key. Pure: it turns the dock's rows into the
 * ordered targets the picker shows and says what each target opens. The overlay in task-dock.ts
 * only renders these targets and forwards the choice, so the ordering and the routing can be
 * tested without a terminal.
 *
 * Both kinds open the manager that owns them, so one list covers both:
 *   bg        -> the background task manager (`/bg-tasks <taskId>`)
 *   subagent  -> the run view for that run, with a prompt box (Enter send, Esc close)
 */

export type PickerTargetKind = "bg" | "subagent";

export interface PickerRow {
	id: string;
	source: string;
	label: string;
	state: string;
	startedAt: number;
}

export interface PickerTarget {
	kind: PickerTargetKind;
	/** Row id in the dock registry, e.g. `bg:<taskId>` or `delegate:<runId>`. */
	rowId: string;
	/** The bare task or run id the owning manager understands. */
	taskId: string;
	label: string;
	state: string;
	startedAt: number;
}

/** Sources that belong to the subagent manager. Mirrors the dock's subagent section. */
const SUBAGENT_SOURCES = new Set(["delegate", "routed", "subagent"]);

/** Bare id a manager needs: the dock row id minus its `bg:` / `delegate:` prefix. */
export function bareTaskId(rowId: string): string {
	const colon = rowId.indexOf(":");
	return colon === -1 ? rowId : rowId.slice(colon + 1);
}

/**
 * Background tasks first, then subagent tasks, each in start order. Rows from other sources
 * (the waiting prompt, provider rows) are not manager tasks and are left out.
 */
export function pickerTargets(rows: readonly PickerRow[]): PickerTarget[] {
	const toTarget = (row: PickerRow, kind: PickerTargetKind): PickerTarget => ({
		kind,
		rowId: row.id,
		taskId: bareTaskId(row.id),
		label: row.label,
		state: row.state,
		startedAt: row.startedAt,
	});
	const byStart = (a: PickerRow, b: PickerRow) => a.startedAt - b.startedAt;
	const bg = rows
		.filter((row) => row.source === "bg")
		.sort(byStart)
		.map((row) => toTarget(row, "bg"));
	const subagent = rows
		.filter((row) => SUBAGENT_SOURCES.has(row.source))
		.sort(byStart)
		.map((row) => toTarget(row, "subagent"));
	return [...bg, ...subagent];
}

/**
 * The command that opens a target's own manager. Returns undefined for a subagent target: the
 * subagent monitor is opened in-process, not through a command.
 */
export function targetCommand(target: PickerTarget): string | undefined {
	if (target.kind === "bg") return `/bg-tasks ${target.taskId}`;
	return undefined;
}

/** Whether ↓ may open the picker. The key must reach the picker only from an empty, idle prompt. */
export function canOpenPicker(input: {
	hasRows: boolean;
	editorText: string;
	browsingHistory: boolean;
	overlayOpen: boolean;
}): boolean {
	if (!input.hasRows) return false;
	if (input.overlayOpen) return false;
	// ↓ with history browsing active belongs to the editor: it steps back through prompts.
	if (input.browsingHistory) return false;
	return input.editorText.length === 0;
}
