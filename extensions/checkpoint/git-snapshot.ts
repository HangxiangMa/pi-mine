/**
 * Worktree snapshots for the code-rewind checkpoint feature.
 *
 * A snapshot is a git tree object capturing the whole worktree (tracked and
 * untracked, minus .gitignore). It is built with a temporary index file, so the
 * real index, the worktree, and the stash list are never touched. Only the git
 * object store gains an object.
 *
 * Why not `git stash create`: it ignores untracked files and returns nothing
 * when there are no tracked changes, so it cannot represent a clean baseline.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface Git {
	/** Absolute worktree root. All paths in results are relative to it. */
	readonly root: string;
	run(args: readonly string[], env?: NodeJS.ProcessEnv): Promise<string>;
}

/** Run git without a shell. Returns trimmed stdout. Throws with stderr on failure. */
export function makeGit(root: string): Git {
	const absRoot = resolve(root);
	return {
		root: absRoot,
		async run(args, env) {
			const { stdout } = await execFileAsync("git", [...args], {
				cwd: absRoot,
				env: env ?? process.env,
				maxBuffer: 64 * 1024 * 1024,
			});
			return stdout.trim();
		},
	};
}

/** Worktree root of the repo containing `cwd`, or undefined when not in a repo. */
export async function findRepoRoot(cwd: string): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd });
		return stdout.trim() || undefined;
	} catch {
		return undefined;
	}
}

/**
 * Capture the current worktree as a tree object id, without touching the real
 * index. `git add -A` honours .gitignore, so ignored files are excluded.
 */
export async function snapshotWorktree(git: Git): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-checkpoint-"));
	const env = { ...process.env, GIT_INDEX_FILE: join(dir, "index") };
	try {
		// An unborn HEAD (no commits yet) has nothing to read; start from an empty index.
		const hasHead = await git.run(["rev-parse", "--verify", "--quiet", "HEAD"]).then(
			() => true,
			() => false,
		);
		if (hasHead) await git.run(["read-tree", "HEAD"], env);
		await git.run(["add", "-A"], env);
		return await git.run(["write-tree"], env);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** Repo-relative paths whose blob differs between two trees (added, deleted, or modified). */
export async function changedPaths(git: Git, fromTree: string, toTree: string): Promise<string[]> {
	const out = await git.run(["diff-tree", "-r", "--name-only", "--no-renames", fromTree, toTree]);
	return out ? out.split("\n").filter(Boolean) : [];
}

/**
 * Write the snapshot back into the worktree. Files in the snapshot are checked
 * out over whatever is there now. Files that exist now but not in the snapshot
 * are deleted. Ignored files are never touched.
 */
export async function restoreWorktree(git: Git, tree: string): Promise<void> {
	const current = await snapshotWorktree(git);
	const dir = await mkdtemp(join(tmpdir(), "pi-checkpoint-restore-"));
	const env = { ...process.env, GIT_INDEX_FILE: join(dir, "index") };
	try {
		// Load the snapshot into a scratch index and write its files out. The real
		// index is never read or written.
		await git.run(["read-tree", tree], env);
		await git.run(["checkout-index", "-a", "-f"], env);
		// Files that exist now but were not in the snapshot were created after it.
		const created = await git.run([
			"diff-tree",
			"-r",
			"--name-only",
			"--no-renames",
			"--diff-filter=A",
			tree,
			current,
		]);
		for (const path of created ? created.split("\n").filter(Boolean) : []) {
			const absolute = resolve(git.root, path);
			// Guard against paths that would escape the repo root.
			if (!absolute.startsWith(git.root + sep)) continue;
			await rm(absolute, { force: true });
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
