/**
 * Real-git repository fixtures for the node-half suite.
 *
 * Adapted from @wongzexu/dsh-git-status (MIT), tests/fixtures/repo.mjs.
 * Every helper builds a throwaway repository under the OS temp dir and registers
 * its own cleanup with `t.after`, so a failing assertion cannot leak one.
 * Zero dependencies beyond node:test.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Run git, resolving stdout; rejects with trimmed stderr on failure. */
export function runGit(cwd, args, opts = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn("git", ["-C", cwd, "--no-pager", "-c", "color.ui=false", ...args], {
			stdio: ["ignore", "pipe", "pipe"],
			// LC_ALL=C keeps git's output in English, so nothing in the suite
			// depends on the developer's locale
			env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", LANG: "C", ...opts.env }
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve(stdout);
			else reject(new Error(stderr.trim() || `git exited with code ${code}`));
		});
	});
}

/** Run git, resolving { ok, stdout, stderr } instead of throwing. */
export async function runGitSafe(cwd, args, opts) {
	try {
		return { ok: true, stdout: await runGit(cwd, args, opts), stderr: "" };
	} catch (error) {
		return { ok: false, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
	}
}

let counter = 0;

/** Fresh temp directory, cleaned up by the test that owns it. */
export async function makeTempDir(t, prefix = "dsh-git-badge-") {
	const dir = await mkdtemp(join(tmpdir(), `${prefix}${++counter}-`));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

/**
 * Throwaway repository (branch `main`, committer configured) with a small api:
 *
 *   commit(message, files?)   write(rel, content)   unlink(rel)
 *   branch(name, start?)      checkout(name, args?)  stashPush(args?)
 *   headHash()                currentBranch()        gitDir()      git(args)
 *   untrackedTree(n)          makeSubdir(name?)      withUpstream()
 *   worktreeAdd({ name?, branch? })
 */
export async function makeRepo(t, { userName = "Test User", userEmail = "test@example.com" } = {}) {
	const root = await makeTempDir(t);
	await runGit(root, ["init", "-b", "main"]);
	await runGit(root, ["config", "user.name", userName]);
	await runGit(root, ["config", "user.email", userEmail]);
	await runGit(root, ["config", "commit.gpgsign", "false"]);

	const api = {
		root,
		git: (args, opts) => runGit(root, args, opts),
		gitSafe: (args, opts) => runGitSafe(root, args, opts),

		async write(rel, content) {
			const abs = join(root, rel);
			await mkdir(dirname(abs), { recursive: true });
			await writeFile(abs, content);
		},

		async unlink(rel) {
			await rm(join(root, rel), { force: true });
		},

		async commit(message, files) {
			const entries = files ?? { "a.txt": `${message}\n` };
			for (const [rel, content] of Object.entries(entries)) await this.write(rel, content);
			await runGit(root, ["add", "-A"]);
			await runGit(root, ["commit", "-m", message]);
			return this.headHash();
		},

		async branch(name, start) {
			await runGit(root, start === undefined ? ["branch", name] : ["branch", name, start]);
		},

		async checkout(name, args = []) {
			await runGit(root, ["checkout", ...args, name]);
		},

		async stashPush(args = []) {
			await runGit(root, ["stash", "push", ...args]);
		},

		async headHash() {
			return (await runGit(root, ["rev-parse", "--short", "HEAD"])).trim();
		},

		async currentBranch() {
			return (await runGit(root, ["branch", "--show-current"])).trim();
		},

		async gitDir() {
			return (await runGit(root, ["rev-parse", "--absolute-git-dir"])).trim();
		},

		/** Create `untracked/nested/f1..fN.txt`; returns the number of files. */
		async untrackedTree(count = 3) {
			for (let index = 1; index <= count; index += 1) {
				await this.write(`untracked/nested/f${index}.txt`, `file ${index}\n`);
			}
			return count;
		},

		/** A subdirectory inside the repository (subdirectory-workspace case). */
		async makeSubdir(name = "sub") {
			const abs = join(root, name);
			await mkdir(abs, { recursive: true });
			return abs;
		},

		/** Register a bare origin, push main, set its upstream; returns the bare path. */
		async withUpstream() {
			const bare = await makeTempDir(t, "dsh-git-badge-bare-");
			await runGit(bare, ["init", "--bare", "-b", "main"]);
			await runGit(root, ["remote", "add", "origin", bare]);
			await runGit(root, ["push", "-u", "origin", "main"]);
			return bare;
		},

		/**
		 * Add a LINKED worktree on a new branch, in a sibling temp directory, and
		 * return its root. It is a real one: its `.git` is a gitfile pointing at
		 * `<root>/.git/worktrees/<name>`, so its index/HEAD/reflogs live OUTSIDE
		 * the worktree root — the case the watcher must cover.
		 */
		async worktreeAdd({ name = "linked", branch = "linked-branch" } = {}) {
			const parent = await makeTempDir(t, "dsh-git-badge-worktree-");
			const worktreeRoot = join(parent, name);
			await runGit(root, ["worktree", "add", "-q", worktreeRoot, "-b", branch]);
			return worktreeRoot;
		}
	};
	return api;
}
