/**
 * The overlay for the dock's ↓ picker: one list of background and subagent tasks. It only draws
 * the targets from task-dock-picker.ts and reports the choice. Opening the chosen manager is the
 * caller's job, so this file has no knowledge of either manager.
 */
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { PickerTarget } from "./task-dock-picker.ts";

const SECTION_TITLE: Record<PickerTarget["kind"], string> = {
	bg: "bg tasks",
	subagent: "subagent tasks",
};

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

/** Index after moving the cursor by `delta`, clamped to the list. */
export function moveSelection(count: number, selected: number, delta: number): number {
	if (count <= 0) return 0;
	return Math.max(0, Math.min(count - 1, selected + delta));
}

/**
 * Show the picker and resolve with the chosen target, or undefined on Esc. Enter chooses, ↑/↓
 * move, Esc closes. The callers resolve the result into a manager open.
 */
export async function pickTaskTarget(
	ctx: ExtensionContext,
	targets: readonly PickerTarget[],
): Promise<PickerTarget | undefined> {
	if (!ctx.hasUI || targets.length === 0) return undefined;
	return ctx.ui.custom<PickerTarget | undefined>(
		(tui, theme: Theme, _keybindings, done) => {
			let selected = 0;
			return {
				render(width: number): string[] {
					const body = pickerLines(targets, selected).map((line) =>
						truncateToWidth(line, width, ""),
					);
					const hint = truncateToWidth(
						theme.fg("muted", " ↑↓ move · Enter open · Esc close"),
						width,
						"",
					);
					return [theme.bold(" Tasks"), ...body, "", hint];
				},
				handleInput(data: string): void {
					if (matchesKey(data, "escape")) {
						done(undefined);
						return;
					}
					if (matchesKey(data, "enter")) {
						done(targets[selected]);
						return;
					}
					const delta = matchesKey(data, "up") ? -1 : matchesKey(data, "down") ? 1 : 0;
					if (delta !== 0) {
						selected = moveSelection(targets.length, selected, delta);
						tui.requestRender();
					}
				},
				invalidate(): void {},
			};
		},
		{
			overlay: true,
			// Full width and no left inset: pi keeps base text in every uncovered column, so any gap would
			// leak dock fragments around the picker. Bottom margin keeps it clear of the editor line.
			overlayOptions: { anchor: "bottom-left", width: "100%", margin: { bottom: 4 } },
		},
	);
}
