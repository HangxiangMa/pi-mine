/**
 * The overlay for the dock's ↓ picker: one list of background and subagent tasks. It renders
 * the target details in the same component, so choosing a row never opens a second window.
 */
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { PickerTarget } from "./task-dock-picker.ts";

const SECTION_TITLE: Record<PickerTarget["kind"], string> = {
	bg: "bg tasks",
	subagent: "subagent tasks",
};
const PICKER_FOOTER_ROWS = 4;
const DETAIL_OUTPUT_LINES = 3;

export interface PickerActions {
	cancel?(target: PickerTarget): void;
	guide?(target: PickerTarget): void | Promise<void>;
}

/** Lines for the list, with a section header whenever the kind changes. Pure, so it is testable. */
export function pickerLines(targets: readonly PickerTarget[], selected: number): string[] {
	const lines: string[] = [];
	let section: PickerTarget["kind"] | undefined;
	targets.forEach((target, index) => {
		if (target.kind !== section) {
			section = target.kind;
			lines.push(` ${SECTION_TITLE[target.kind]}`);
		}
		const pointer = index === selected ? "›" : " ";
		lines.push(` ${pointer} ${target.label} · ${target.state} · ${target.taskId}`);
	});
	return lines;
}

/** Layout above pi's prompt/footer, following the monitor's bottom-margin technique. */
export function pickerOverlayOptions(
	termCols: number,
	termRows: number,
	footerRows = PICKER_FOOTER_ROWS,
) {
	const cols = Math.max(20, termCols);
	const rows = Math.max(6, termRows);
	return {
		anchor: "bottom-left" as const,
		width: Math.min(100, Math.max(20, cols - 4)),
		maxHeight: Math.max(4, rows - footerRows - 1),
		margin: { bottom: footerRows },
	};
}

/** Index after moving the cursor by `delta`, clamped to the list. */
export function moveSelection(count: number, selected: number, delta: number): number {
	if (count <= 0) return 0;
	return Math.max(0, Math.min(count - 1, selected + delta));
}

/** Whether an Up press at the first row should close the picker. */
export function upExits(selected: number): boolean {
	return selected === 0;
}

type DetailTarget = PickerTarget & {
	model?: unknown;
	output?: unknown;
	summary?: unknown;
	activity?: unknown;
};

function detailTarget(target: PickerTarget): DetailTarget {
	return target as DetailTarget;
}

function elapsedSince(startedAt: number): string {
	const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function canControl(target: PickerTarget): boolean {
	// The task dock's control bridge uses delegate row ids; ordinary subagent and bg rows have
	// no control callback here, so the hint must not promise actions that this picker cannot run.
	return target.kind === "subagent" && target.rowId.startsWith("delegate:");
}

function listHint(target: PickerTarget): string {
	const readOnly = target.kind === "bg" ? " · bg tasks take no input" : "";
	return ` ↑↓ move · Enter open · c cancel · p guide · Esc close${readOnly}`;
}

function detailsHint(target: PickerTarget): string {
	if (target.kind === "bg") return " Esc back · bg tasks take no input";
	return canControl(target) ? " Esc back · c cancel · p guide" : " Esc back · c/p unavailable";
}

function detailLines(target: PickerTarget): string[] {
	const extra = detailTarget(target);
	const output = [extra.output, extra.summary, extra.activity].find(
		(value) => typeof value === "string",
	) as string | undefined;
	const outputLines = output
		? output
				.split(/\r?\n/)
				.filter((line) => line.trim().length > 0)
				.slice(-DETAIL_OUTPUT_LINES)
		: [];
	return [
		` Agent/label: ${target.kind} / ${target.label}`,
		` Status: ${target.state}`,
		` Model: ${typeof extra.model === "string" ? extra.model : "unavailable"}`,
		` Elapsed: ${elapsedSince(target.startedAt)}`,
		" Output:",
		...(outputLines.length > 0 ? outputLines.map((line) => `   ${line}`) : ["   (not available)"]),
	];
}

/**
 * Show the picker and keep Enter in this component by switching to details. Esc closes the list;
 * Esc in details returns to the list. The overlay is focus-taking, so printable/unhandled input is
 * intentionally not routed to the prompt while it is open; this component only changes state for
 * keys it handles and does not install a global listener that swallows other prompt input.
 */
export async function pickTaskTarget(
	ctx: ExtensionContext,
	targets: readonly PickerTarget[],
	actions: PickerActions = {},
): Promise<PickerTarget | undefined> {
	if (!ctx.hasUI || targets.length === 0) return undefined;
	const options = pickerOverlayOptions(process.stdout.columns || 120, process.stdout.rows || 50);
	return ctx.ui.custom<PickerTarget | undefined>(
		(tui, theme: Theme, _keybindings, done) => {
			let selected = 0;
			let details = false;
			const selectedTarget = () => targets[selected];
			const invokeAction = (action: "cancel" | "guide") => {
				const target = selectedTarget();
				if (!target || !canControl(target)) return false;
				if (action === "cancel") {
					actions.cancel?.(target);
				} else {
					void Promise.resolve(actions.guide?.(target)).catch(() => {
						/* guidance is optional; the picker must remain usable if it is refused */
					});
				}
				tui.requestRender();
				return true;
			};
			return {
				render(width: number): string[] {
					if (details) {
						const target = selectedTarget();
						const body = detailLines(target).map((line) => truncateToWidth(line, width, ""));
						return [
							theme.bold(` ${target.label}`),
							...body,
							"",
							truncateToWidth(theme.fg("muted", detailsHint(target)), width, ""),
						];
					}
					const body = pickerLines(targets, selected).map((line) => {
						const selectedRow = line.startsWith(" › ");
						const styled = selectedRow ? theme.bold(theme.fg("accent", line)) : line;
						return truncateToWidth(styled, width, "");
					});
					return [
						theme.bold(" Tasks"),
						...body,
						"",
						truncateToWidth(theme.fg("muted", listHint(selectedTarget())), width, ""),
					];
				},
				handleInput(data: string): void {
					if (matchesKey(data, "escape")) {
						if (details) {
							details = false;
							tui.requestRender();
						} else {
							done(undefined);
						}
						return;
					}
					if (details) {
						if (matchesKey(data, "c")) invokeAction("cancel");
						else if (matchesKey(data, "p")) invokeAction("guide");
						return;
					}
					if (matchesKey(data, "enter")) {
						details = true;
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "up") && upExits(selected)) {
						done(undefined);
						return;
					}
					const delta = matchesKey(data, "up") ? -1 : matchesKey(data, "down") ? 1 : 0;
					if (delta !== 0) {
						selected = moveSelection(targets.length, selected, delta);
						tui.requestRender();
					} else if (matchesKey(data, "c")) {
						invokeAction("cancel");
					} else if (matchesKey(data, "p")) {
						invokeAction("guide");
					}
				},
				invalidate(): void {},
			};
		},
		{ overlay: true, overlayOptions: options },
	);
}
