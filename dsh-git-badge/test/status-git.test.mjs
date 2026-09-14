/**
 * gitStatus end-to-end against real repositories — the layer that used to be
 * verifiable only by restarting DSH.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { changeListeners, config, gitStatus, nextStep, outerGitDir, runGit as pluginRunGit } from "../lib/index.js";
import { makeRepo, makeTempDir, runGit } from "../test-support/repo.mjs";

/** Subscribe to change notifications; released with the test. */
function spyOn(t) {
	const seen = [];
	const spy = (payload) => seen.push(payload);
	changeListeners.add(spy);
	t.after(() => changeListeners.delete(spy));
	return seen;
}

/** Poll to a deadline — fs/git timing is not deterministic. */
async function waitFor(fn, { timeoutMs = 3000, intervalMs = 25 } = {}) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = fn();
		if (value) return value;
		if (Date.now() >= deadline) return value;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}

test("a non-repository directory is a definitive { git: false }", async (t) => {
	const dir = await makeTempDir(t, "dsh-git-badge-nonrepo-");
	assert.deepEqual(await gitStatus(dir), { git: false });
});

test("a clean repository is green-shaped, with no operation in progress", async (t) => {
	const repo = await makeRepo(t);
	await repo.commit("initial");
	const info = await gitStatus(repo.root);
	assert.equal(info.git, true);
	assert.equal(info.branch, "main");
	assert.equal(info.dirty, false);
	assert.equal(info.changedFiles, 0);
	assert.equal(info.stagedFiles, 0);
	assert.equal(info.unstagedFiles, 0);
	assert.equal(info.unmergedFiles, 0);
	assert.equal(info.untrackedFiles, 0);
	assert.equal(info.operation, null);
	assert.equal(info.untrackedMode, "all");
});

test("REGRESSION: a new directory of 3 files counts as 3, not one collapsed entry", async (t) => {
	const repo = await makeRepo(t);
	await repo.commit("initial");
	const created = await repo.untrackedTree(3);
	const info = await gitStatus(repo.root);
	assert.equal(info.untrackedFiles, created);
	assert.equal(info.untrackedMode, "all");
	assert.equal(info.dirty, true);
});

test("an untracked-walk timeout retries collapsed and reports untrackedMode", async (t) => {
	const repo = await makeRepo(t);
	await repo.commit("initial");
	await repo.untrackedTree(3);
	// Deterministic injection: a real sub-millisecond budget would only race
	// git's own startup (the timer callback can be delayed past the child's
	// exit), so the runner reports the -uall call as timed out instead. It must
	// keep the plugin's runGit contract — { stdout } rather than a bare string.
	const original = config.gitRunner;
	config.gitRunner = async (cwd, args, opts) => {
		if (args.includes("--untracked-files=all")) return { stdout: null, timeout: true };
		return pluginRunGit(cwd, args, opts);
	};
	t.after(() => {
		config.gitRunner = original;
	});
	const info = await gitStatus(repo.root);
	assert.equal(info.git, true);
	assert.equal(info.untrackedMode, "collapsed");
	assert.equal(info.untrackedFiles, 1);
});

test("staged and unstaged changes are counted separately", async (t) => {
	const repo = await makeRepo(t);
	await repo.commit("initial", { "a.txt": "one\n", "b.txt": "one\n" });
	await repo.write("a.txt", "two\n");
	await repo.write("b.txt", "two\n");
	await repo.git(["add", "b.txt"]);
	const info = await gitStatus(repo.root);
	assert.equal(info.stagedFiles, 1);
	assert.equal(info.unstagedFiles, 1);
	assert.equal(info.changedFiles, 2);
	assert.equal(info.dirty, true);
});

test("an unstaged deletion counts as a change", async (t) => {
	const repo = await makeRepo(t);
	await repo.commit("initial");
	await repo.unlink("a.txt");
	const info = await gitStatus(repo.root);
	assert.equal(info.unstagedFiles, 1);
	assert.equal(info.dirty, true);
});

test("MERGE_HEAD in the git dir surfaces operation 'merge'", async (t) => {
	const repo = await makeRepo(t);
	await repo.commit("initial");
	const gitDir = await repo.gitDir();
	await writeFile(join(gitDir, "MERGE_HEAD"), `${await repo.headHash()}\n`);
	const info = await gitStatus(repo.root);
	assert.equal(info.operation, "merge");
});

test("rebase-merge in the git dir surfaces operation 'rebase'", async (t) => {
	const repo = await makeRepo(t);
	await repo.commit("initial");
	const gitDir = await repo.gitDir();
	await mkdir(join(gitDir, "rebase-merge"), { recursive: true });
	const info = await gitStatus(repo.root);
	assert.equal(info.operation, "rebase");
});

test("a subdirectory workspace reports the whole repository", async (t) => {
	const repo = await makeRepo(t);
	await repo.commit("initial");
	const sub = await repo.makeSubdir("sub");
	await repo.write("sub/inside.txt", "x\n");
	const info = await gitStatus(sub);
	assert.equal(info.git, true);
	assert.equal(info.branch, "main");
	assert.equal(info.untrackedFiles, 1);
});

test("a detached HEAD is reported as (detached)", async (t) => {
	const repo = await makeRepo(t);
	await repo.commit("initial");
	await repo.checkout("HEAD", ["--detach"]);
	const info = await gitStatus(repo.root);
	assert.equal(info.branch, "(detached)");
});

test("with an upstream configured, ahead/behind come from the remote-tracking ref", async (t) => {
	const repo = await makeRepo(t);
	await repo.commit("initial");
	await repo.withUpstream();
	const synced = await gitStatus(repo.root);
	assert.equal(synced.upstream, "origin/main");
	assert.equal(synced.ahead, 0);
	assert.equal(synced.behind, 0);
	await repo.commit("second");
	const diverged = await gitStatus(repo.root);
	assert.equal(diverged.ahead, 1);
	assert.equal(diverged.behind, 0);
});

test("detail=1 adds the last commits and the stash count", async (t) => {
	const repo = await makeRepo(t);
	await repo.commit("initial");
	const withoutDetail = await gitStatus(repo.root);
	assert.equal(withoutDetail.lastCommits, undefined);
	assert.equal(withoutDetail.stashCount, undefined);
	await repo.write("a.txt", "changed\n");
	await repo.stashPush();
	const info = await gitStatus(repo.root, true);
	assert.equal(info.stashCount, 1);
	assert.ok(Array.isArray(info.lastCommits));
	assert.equal(info.lastCommits.length, 1);
	assert.match(info.lastCommits[0].hash, /^[0-9a-f]+$/);
	assert.equal(info.lastCommits[0].subject, "initial");
});

test("the TTL fetch is out of band: it never delays the answer", async (t) => {
	const repo = await makeRepo(t);
	await repo.commit("initial");
	const bare = await repo.withUpstream();

	// advance the remote WITHOUT touching this repo's refs, so origin/main here
	// is stale until a fetch runs
	const other = await makeTempDir(t, "dsh-git-badge-clone-");
	await runGit(other, ["clone", "--quiet", bare, "clone"]);
	const clone = join(other, "clone");
	await runGit(clone, ["config", "user.email", "t@e.com"]);
	await runGit(clone, ["config", "user.name", "T"]);
	await writeFile(join(clone, "b.txt"), "b\n");
	await runGit(clone, ["add", "-A"]);
	await runGit(clone, ["commit", "-m", "remote advance"]);
	await runGit(clone, ["push", "--quiet", "origin", "main"]);

	const seen = spyOn(t);

	// The first answer must come from the refs at hand. If the fetch were awaited
	// this would already report behind=1 — and in production that await cost ~3.3s.
	const first = await gitStatus(repo.root);
	assert.equal(first.upstream, "origin/main");
	assert.equal(first.behind, 0, "the response must not wait for the fetch");

	// ...and the out-of-band fetch must announce itself so clients reconverge
	const hit = await waitFor(() => seen.length > 0, { timeoutMs: 5000 });
	assert.ok(hit, "a successful background fetch must notify subscribers");

	// after which the corrected count is served without another fetch
	const second = await gitStatus(repo.root);
	assert.equal(second.behind, 1);
});

// ---- worktree identity (the chip can only name a worktree if this is right) ----

test("a main worktree is not flagged, and names its own directory", async (t) => {
	const repo = await makeRepo(t);
	await repo.commit("initial");
	const info = await gitStatus(repo.root);
	assert.equal(info.isWorktree, false);
	assert.equal(info.worktreeName, basename(repo.root));
});

test("a linked worktree is flagged and named, while the main checkout is not", async (t) => {
	const repo = await makeRepo(t);
	await repo.commit("initial");
	const linked = await repo.worktreeAdd({ name: "feature-tree", branch: "feature" });
	const info = await gitStatus(linked);
	assert.equal(info.git, true);
	assert.equal(info.branch, "feature");
	assert.equal(info.isWorktree, true);
	assert.equal(info.worktreeName, "feature-tree");
	// same repository, different answer — the control for the assertion above
	assert.equal((await gitStatus(repo.root)).isWorktree, false);
});

test("a subdirectory of a linked worktree reports the worktree, not itself", async (t) => {
	const repo = await makeRepo(t);
	await repo.commit("initial");
	const linked = await repo.worktreeAdd({ name: "nested-tree", branch: "nested" });
	const sub = join(linked, "inside");
	await mkdir(sub, { recursive: true });
	const info = await gitStatus(sub);
	assert.equal(info.isWorktree, true);
	assert.equal(info.worktreeName, "nested-tree");
});

test("a submodule is NOT a worktree, though its git dir is out-of-tree too", async (t) => {
	const repo = await makeRepo(t);
	await repo.commit("initial");
	const sub = await repo.submoduleAdd({ name: "sub" });
	const info = await gitStatus(sub);
	assert.equal(info.git, true);
	// A submodule's `.git` is a gitfile exactly like a worktree's, so the gitfile
	// alone must not be the test: worktree-ness is the `commondir` marker, and
	// reporting a submodule as a worktree would put a tree on the row.
	assert.equal(info.isWorktree, false);
	assert.equal(info.worktreeName, "sub");
	// ...while the watcher still has to look outside the directory, as for a worktree
	assert.match(outerGitDir(sub), /[\\/]\.git[\\/]modules[\\/]sub$/);
	assert.equal((await gitStatus(repo.root)).isWorktree, false, "the hosting checkout is unaffected");
});

// ---------------------------------------------------------------------------
// nextStep — the hover card's "next" row. Pure ranking over the status fields,
// so the table is asserted directly, plus two end-to-end cases against real
// repositories to prove the field actually rides the response.
// ---------------------------------------------------------------------------

test("nextStep: clean, synced, no PR → null (no suggestion is a suggestion)", () => {
	assert.equal(nextStep({ git: true, branch: "main", upstream: "origin/main", ahead: 0, behind: 0 }), null);
});

test("nextStep: not-a-repo or garbage input → null", () => {
	assert.equal(nextStep(void 0), null);
	assert.equal(nextStep({ git: false }), null);
});

test("nextStep: a paused operation wins and names its resume command", () => {
	for (const [operation, command] of [
		["merge", "git merge --continue"],
		["rebase", "git rebase --continue"],
		["cherry-pick", "git cherry-pick --continue"],
		["revert", "git revert --continue"],
		["squash", "git commit"],
	]) {
		assert.deepEqual(
			nextStep({ git: true, operation, unmergedFiles: 2 }),
			{ command, why: "2 unmerged files blocking the paused " + operation },
			operation,
		);
	}
});

test("nextStep: a paused bisect gets a why but no command (the call is the user's)", () => {
	const next = nextStep({ git: true, operation: "bisect" });
	assert.equal(next.command, void 0);
	assert.match(next.why, /bisect/);
});

test("nextStep: unmerged without a marker falls back to git status", () => {
	assert.deepEqual(nextStep({ git: true, unmergedFiles: 1 }), { command: "git status", why: "1 unmerged file to resolve" });
});

test("nextStep: behind ranks ahead of dirty work", () => {
	const next = nextStep({ git: true, upstream: "origin/main", behind: 3, stagedFiles: 1 });
	assert.equal(next.command, "git pull --ff-only");
	assert.match(next.why, /3 behind origin\/main/);
});

test("nextStep: ahead → push", () => {
	const next = nextStep({ git: true, upstream: "origin/main", ahead: 2 });
	assert.deepEqual(next, { command: "git push", why: "2 ahead of origin/main" });
});

test("nextStep: no upstream on a dirty branch → publish it", () => {
	const next = nextStep({ git: true, branch: "feat/x", stagedFiles: 1 });
	assert.deepEqual(next, { command: "git push -u origin feat/x", why: "no upstream configured" });
});

test("nextStep: dirty work — staged, unstaged, untracked choose the command", () => {
	// an upstream is set in every case: a dirty branch with NO upstream is the
	// publish-it-first rule's business, asserted separately below
	assert.equal(nextStep({ git: true, upstream: "o/m", stagedFiles: 2 }).command, "git commit");
	assert.equal(nextStep({ git: true, upstream: "o/m", unstagedFiles: 1 }).command, "git add -p && git commit");
	assert.equal(nextStep({ git: true, upstream: "o/m", untrackedFiles: 1 }).command, "git add -A && git commit");
	// staged work is committed as-is even with further unstaged edits — add -p
	// would mix the two, and committing exactly what was staged is the safe move
	assert.equal(nextStep({ git: true, upstream: "o/m", stagedFiles: 1, unstagedFiles: 1 }).command, "git commit");
	assert.match(nextStep({ git: true, upstream: "o/m", stagedFiles: 2 }).why, /work to commit/);
});

test("nextStep: failing PR checks → watch them", () => {
	assert.deepEqual(
		nextStep({ git: true, pr: { number: 142, state: "failing" } }),
		{ command: "gh pr checks 142 --watch", why: "checks failing on #142" },
	);
	// passing or absent checks suggest nothing
	assert.equal(nextStep({ git: true, pr: { number: 142, state: "passing" } }), null);
	assert.equal(nextStep({ git: true }), null);
});

test("a clean repository response carries no next field", async (t) => {
	const repo = await makeRepo(t);
	await repo.commit("initial");
	const info = await gitStatus(repo.root);
	assert.equal(info.git, true);
	assert.equal(info.next, void 0);
});

test("a dirty repository with no upstream suggests publishing it", async (t) => {
	// makeRepo has no remote: upstream is undefined, so the first-publish rule
	// outranks the commit suggestion — documented here end-to-end.
	const repo = await makeRepo(t);
	await repo.commit("initial");
	await repo.write("b.txt", "dirty\n");
	const info = await gitStatus(repo.root);
	assert.equal(info.git, true);
	assert.equal(info.next.command, "git push -u origin main");
	assert.equal(info.next.why, "no upstream configured");
});
