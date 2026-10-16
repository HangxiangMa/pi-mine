/**
 * Turns off the pi-background-tasks dock shortcut for this pi process. The unified ↓ picker is the
 * one entry point for background and subagent tasks, so no separate Ctrl+Alt+B binding is needed.
 * pi-background-tasks reads PI_BG_DOCK_SHORTCUT when its factory runs, and pi-mine loads first, so
 * setting it here takes effect. A value the user already set wins.
 */
export const BG_DOCK_SHORTCUT_ENV = "PI_BG_DOCK_SHORTCUT";

/** Set PI_BG_DOCK_SHORTCUT=off unless the user already chose a value. Idempotent. */
export function applyBgDockShortcutPolicy(env: NodeJS.ProcessEnv): void {
	if (env[BG_DOCK_SHORTCUT_ENV] !== undefined && env[BG_DOCK_SHORTCUT_ENV] !== "") return;
	env[BG_DOCK_SHORTCUT_ENV] = "off";
}

/**
 * Hides pi-background-tasks' own footer dock. The Tasks panel (task-dock.ts) already lists bg tasks,
 * so the upstream dock would show the same rows twice. Upstream reads PI_BG_DOCK_WIDGET at factory time,
 * the same ordering as the shortcut above. The /tasks manager and the bg shortcut still work.
 */
export const BG_DOCK_WIDGET_ENV = "PI_BG_DOCK_WIDGET";

/** Set PI_BG_DOCK_WIDGET=off unless the user already chose a value. Idempotent. */
export function applyBgDockWidgetPolicy(env: NodeJS.ProcessEnv): void {
	if (env[BG_DOCK_WIDGET_ENV] !== undefined && env[BG_DOCK_WIDGET_ENV] !== "") return;
	env[BG_DOCK_WIDGET_ENV] = "off";
}
