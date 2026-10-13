import type { ChildProcess } from "node:child_process";

/**
 * Signal the whole process group led by a detached child. Descendants that inherited
 * stdio (MCP stdio servers, tool shells) receive the signal with it, so their exit can
 * close the parent's pipes. Falls back to the direct child when the group is already gone.
 */
export function signalChildTree(child: ChildProcess, signal: NodeJS.Signals): void {
	if (child.pid && process.platform !== "win32") {
		try {
			process.kill(-child.pid, signal);
			return;
		} catch {
			// Group already gone; fall through to the direct child.
		}
	}
	try {
		child.kill(signal);
	} catch {
		// Already exited.
	}
}

const liveTreePids = new Set<number>();
let exitHookInstalled = false;

/** Track a detached child group so it is SIGKILLed if pi exits before the run settles. */
export function trackChildTree(pid: number): void {
	liveTreePids.add(pid);
	if (exitHookInstalled || process.platform === "win32") return;
	exitHookInstalled = true;
	process.once("exit", () => {
		for (const livePid of liveTreePids) {
			try {
				process.kill(-livePid, "SIGKILL");
			} catch {
				// Group already gone.
			}
		}
	});
}

export function untrackChildTree(pid: number): void {
	liveTreePids.delete(pid);
}
