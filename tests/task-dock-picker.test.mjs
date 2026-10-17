// Contract tests for the unified task picker behind the dock's ↓ key. The ordering, the routing
// of each row to its manager, and the rule for when ↓ may open the picker are pure, so they are
// checked here without a terminal.
import assert from "node:assert/strict";
import {
	bareTaskId,
	canOpenPicker,
	pickerTargets,
	targetCommand,
} from "../extensions/task-dock-picker.ts";
import {
	moveSelection,
	pickTaskTarget,
	pickerLines,
	pickerOverlayOptions,
	upExits,
} from "../extensions/task-dock-picker-view.ts";

const row = (id, source, startedAt, extra = {}) => ({
	id,
	source,
	label: id,
	state: "running",
	startedAt,
	...extra,
});

// Background tasks come first, then subagent tasks, each in start order. Other rows are dropped.
const rows = [
	row("delegate:run-b", "delegate", 300),
	row("bg:task-2", "bg", 200),
	row("ui:prompt", "ui", 50),
	row("sub:call-1:0", "subagent", 100),
	row("bg:task-1", "bg", 150),
];
const targets = pickerTargets(rows);
assert.deepEqual(
	targets.map((t) => `${t.kind}:${t.taskId}`),
	["bg:task-1", "bg:task-2", "subagent:call-1:0", "subagent:run-b"],
	"bg first, subagent after, each by start time; the waiting prompt is not a manager task",
);

// A bg row's manager id is the bare task id; a delegate row keeps the run id after its prefix.
assert.equal(bareTaskId("bg:task-1"), "task-1");
assert.equal(bareTaskId("delegate:run-b"), "run-b");
// Only the first colon is the prefix: a task id may itself contain colons.
assert.equal(bareTaskId("bg:a:b"), "a:b");

// Routing: a bg target has a command for its manager; a subagent target opens in-process.
assert.equal(targetCommand(targets[0]), "/bg-tasks task-1");
assert.equal(targetCommand(targets[2]), undefined, "a subagent target is not opened by command");

// ↓ opens the picker only from an empty, non-history, no-overlay prompt with rows to show.
const open = { hasRows: true, editorText: "", browsingHistory: false, overlayOpen: false };
assert.equal(canOpenPicker(open), true, "empty prompt with rows opens the picker");
assert.equal(canOpenPicker({ ...open, hasRows: false }), false, "no rows, nothing to pick");
assert.equal(canOpenPicker({ ...open, editorText: "draft" }), false, "typed text keeps ↓ for the editor");
assert.equal(canOpenPicker({ ...open, browsingHistory: true }), false, "history recall keeps ↓");
assert.equal(canOpenPicker({ ...open, overlayOpen: true }), false, "never stack two pickers");

// The overlay list: a section header per kind, a pointer on the selected row only.
const lines = pickerLines(targets, 2);
assert.equal(lines[0], " bg tasks", "bg section header");
assert.ok(lines.some((l) => l === " subagent tasks"), "subagent section header");
const pointed = lines.filter((l) => l.includes("›"));
assert.equal(pointed.length, 1, "exactly one row carries the pointer");
assert.ok(pointed[0].includes("sub:call-1:0"), "the pointer sits on the selected target");

// Cursor movement is clamped to the list.
assert.equal(upExits(0), true, "up at the top exits");
assert.equal(upExits(1), false, "up away from the top moves within the picker");
assert.equal(moveSelection(4, 3, 1), 3, "down at the bottom stays put");
assert.equal(moveSelection(4, 1, 1), 2);
assert.equal(moveSelection(0, 0, 1), 0, "an empty list has no cursor");

// The focused overlay owns one custom component: Enter changes its render to details in place,
// Esc returns to the list, and a second Esc closes it.
{
	const target = {
		kind: "subagent",
		rowId: "delegate:run-details",
		taskId: "run-details",
		label: "deep-reviewer",
		state: "running",
		startedAt: Date.now(),
	};
	let customCalls = 0;
	let component;
	let options;
	let resolvePicker;
	const tui = { requestRender() {} };
	const theme = {
		fg: (role, text) => `<${role}>${text}`,
		bold: (text) => `**${text}**`,
	};
	const pending = pickTaskTarget(
		{
			hasUI: true,
			ui: {
				custom: (factory, nextOptions) => {
					customCalls += 1;
					options = nextOptions;
					return new Promise((resolve) => {
						resolvePicker = resolve;
						component = factory(tui, theme, {}, resolve);
					});
				},
			},
		},
		[target],
	);
	assert.equal(customCalls, 1, "the picker uses one custom component");
	assert.equal(options.overlay, true, "the picker is an overlay");
	assert.match(component.render(100).join("\n"), /Enter open/);
	assert.match(component.render(100).join("\n"), /c cancel.*p guide.*Esc close/);
	component.handleInput("\r");
	assert.equal(customCalls, 1, "Enter must not open a second custom component");
	assert.match(component.render(100).join("\n"), /Agent\/label: subagent \/ deep-reviewer/);
	component.handleInput("\x1b");
	assert.match(component.render(100).join("\n"), /Enter open/, "Esc in details returns to list");
	component.handleInput("\x1b");
	await pending;
	void resolvePicker;
}

// The pure geometry helper keeps the prompt/footer clear and caps the picker width.
assert.deepEqual(pickerOverlayOptions(160, 50, 4), {
	anchor: "bottom-left",
	width: 100,
	maxHeight: 45,
	margin: { bottom: 4 },
});

console.log("task dock picker: ok");
