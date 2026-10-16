/**
 * Runs before pi-background-tasks' extension factory (pi-mine is listed first in settings.json)
 * and sets PI_BG_POSIX_SHELL=bash for this pi process when the user has not chosen a shell.
 * See policy.ts for the rule and why it does not touch the login shell.
 */
import { accessSync, constants, statSync } from "node:fs";
import { applyBgShellPolicy } from "./policy.ts";

/** True only for a regular file that this user can execute. Any error means not executable. */
function isExecutableFile(path: string): boolean {
	try {
		if (!statSync(path).isFile()) return false;
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** Apply the bash policy to this process's environment. Idempotent: a second call does nothing. */
export function applyBgShellFromPiMine(env: NodeJS.ProcessEnv = process.env): void {
	applyBgShellPolicy(env, isExecutableFile);
}
