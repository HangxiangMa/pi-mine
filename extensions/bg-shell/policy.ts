/**
 * Choose pi's background-shell policy for this pi process only.
 *
 * Mirrors Claude Code's CLAUDE_CODE_SHELL: a pi-scoped override that is validated, with a
 * fallback to the existing detection. It sets PI_BG_POSIX_SHELL in process.env, never a shell
 * profile, so the login shell and the user's dotfiles are unchanged.
 *
 * pi-background-tasks reads PI_BG_POSIX_SHELL once, when its extension factory runs
 * (initializeShellPolicy), and freezes the result. This must therefore run before that
 * factory, which holds when pi-mine is listed before pi-background-tasks in settings.json.
 */

export const BG_SHELL_ENV = "PI_BG_POSIX_SHELL";
export const BG_SHELL_BASH = "bash";
export const BG_SHELL_BASH_PATH = "/bin/bash";

export interface BgShellPolicyChoice {
	/** The value to write, or undefined to leave the environment untouched. */
	readonly value: string | undefined;
	/** Why, for logs and tests. */
	readonly reason: "user-set" | "bash-selected" | "bash-missing";
}

/**
 * Decide what PI_BG_POSIX_SHELL should be. A value the user already set always wins. Otherwise
 * bash is selected only when /bin/bash is an executable file, so a missing bash falls back to
 * pi's own default (inherit) instead of making every bg_run fail.
 */
export function chooseBgShellPolicy(
	env: NodeJS.ProcessEnv,
	isExecutableFile: (path: string) => boolean,
): BgShellPolicyChoice {
	if (env[BG_SHELL_ENV] !== undefined && env[BG_SHELL_ENV] !== "") {
		return { value: undefined, reason: "user-set" };
	}
	if (!isExecutableFile(BG_SHELL_BASH_PATH)) {
		return { value: undefined, reason: "bash-missing" };
	}
	return { value: BG_SHELL_BASH, reason: "bash-selected" };
}

/** Apply the choice to env. Returns the reason so the caller can log it once. */
export function applyBgShellPolicy(
	env: NodeJS.ProcessEnv,
	isExecutableFile: (path: string) => boolean,
): BgShellPolicyChoice["reason"] {
	const choice = chooseBgShellPolicy(env, isExecutableFile);
	if (choice.value !== undefined) env[BG_SHELL_ENV] = choice.value;
	return choice.reason;
}
