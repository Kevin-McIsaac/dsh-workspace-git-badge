/**
 * gitStatus end-to-end against real repositories — the layer that used to be
 * verifiable only by restarting DSH.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { changeListeners, config, gitStatus, nextActions, nextStep, outerGitDir, runGit as pluginRunGit } from "../lib/index.js";
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

test("detail=1 adds the stash count (commit listings moved to their hovers)", async (t) => {
	const repo = await makeRepo(t);
	await repo.commit("initial");
	const withoutDetail = await gitStatus(repo.root);
	assert.equal(withoutDetail.stashCount, undefined);
	assert.equal(withoutDetail.lastCommits, undefined, "the last-commits field is gone: branch hover owns commits");
	await repo.write("a.txt", "changed\n");
	await repo.stashPush();
	const info = await gitStatus(repo.root, true);
	assert.equal(info.stashCount, 1);
	assert.equal(info.lastCommits, undefined);
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
// nextStep — the hover card's action row and the (+) picker. Rules carry a
// category and are ranked by the configured order (nextOrder), so the tests
// assert the default ranking, the new diverged/merge-ready rules, and the
// override file — plus two end-to-end cases against real repositories.
// ---------------------------------------------------------------------------

const rule = (info) => nextStep(info);

test("nextStep: clean, synced, no PR → null (no suggestion is a suggestion)", () => {
	assert.equal(rule({ git: true, branch: "main", upstream: "origin/main", ahead: 0, behind: 0 }), null);
});

test("nextStep: not-a-repo or garbage input → null", () => {
	assert.equal(rule(void 0), null);
	assert.equal(rule({ git: false }), null);
});

test("nextStep: a paused operation wins and names its resume command", () => {
	for (const [operation, command] of [
		["merge", "git merge --continue"],
		["rebase", "git rebase --continue"],
		["cherry-pick", "git cherry-pick --continue"],
		["revert", "git revert --continue"],
		["squash", "git commit"],
	]) {
		const next = rule({ git: true, operation, unmergedFiles: 2 });
		assert.equal(next.args, "next", operation);
		assert.equal(next.command, command, operation);
		assert.match(next.why, /2 unmerged files blocking the paused/, operation);
		assert.match(next.what, /resume the paused/, operation);
	}
});

test("nextStep: a paused bisect gets a why but no command (the call is the user's)", () => {
	const next = rule({ git: true, operation: "bisect" });
	assert.equal(next.command, void 0);
	assert.match(next.why, /bisect/);
});

test("nextStep: unmerged without a marker falls back to git status", () => {
	const next = rule({ git: true, unmergedFiles: 1 });
	assert.equal(next.args, "next");
	assert.equal(next.why, "1 unmerged file to resolve");
});

test("nextStep: diverged (ahead AND behind) → sync, not a plain pull", () => {
	const next = rule({ git: true, upstream: "o/m", ahead: 2, behind: 3 });
	assert.equal(next.args, "sync");
	assert.equal(next.command, void 0, "rebase+force-push is the agent's confirmed work, not a copied command");
	assert.match(next.why, /2 ahead, 3 behind/);
	assert.match(next.what, /asks before any force/);
});

test("nextStep: behind alone → pull", () => {
	const next = rule({ git: true, upstream: "o/m", behind: 3, stagedFiles: 1 });
	assert.equal(next.args, "pull");
	assert.equal(next.command, "git pull --ff-only");
	assert.match(next.why, /3 behind o\/m/);
	assert.match(next.what, /update this branch/);
});

test("nextStep: ahead → push", () => {
	const next = rule({ git: true, upstream: "o/m", ahead: 2 });
	assert.deepEqual(
		{ args: next.args, command: next.command, why: next.why },
		{ args: "push", command: "git push", why: "2 ahead of o/m" },
	);
});

test("nextStep: no upstream on a dirty branch → publish it", () => {
	const next = rule({ git: true, branch: "feat/x", stagedFiles: 1 });
	assert.equal(next.args, "push");
	assert.equal(next.command, "git push -u origin feat/x");
	assert.equal(next.why, "no upstream configured");
});

test("nextStep: dirty work — staged, unstaged, untracked choose the command", () => {
	// an upstream is set in every case: a dirty branch with NO upstream is the
	// publish-it-first rule's business, asserted separately above
	assert.equal(rule({ git: true, upstream: "o/m", stagedFiles: 2 }).command, "git commit");
	assert.equal(rule({ git: true, upstream: "o/m", unstagedFiles: 1 }).command, "git add -p && git commit");
	assert.equal(rule({ git: true, upstream: "o/m", untrackedFiles: 1 }).command, "git add -A && git commit");
	// staged work is committed as-is even with further unstaged edits — add -p
	// would mix the two, and committing exactly what was staged is the safe move
	assert.equal(rule({ git: true, upstream: "o/m", stagedFiles: 1, unstagedFiles: 1 }).command, "git commit");
	assert.match(rule({ git: true, upstream: "o/m", stagedFiles: 2 }).why, /work to commit/);
	assert.match(rule({ git: true, upstream: "o/m", stagedFiles: 2 }).what, /commit the staged/);
});

test("nextStep: merge-ready PR (GitHub's own CLEAN verdict) → merge <n>", () => {
	const next = rule({ git: true, upstream: "o/m", pr: { number: 31, state: "passing", mergeState: "CLEAN" } });
	assert.equal(next.args, "merge 31");
	assert.equal(next.command, void 0, "merging is the agent's confirmed work");
	assert.match(next.why, /31 is ready to merge/);
	assert.match(next.what, /squash/);
	// review-approved + passing is the fallback verdict when mergeState is absent
	const alt = rule({ git: true, upstream: "o/m", pr: { number: 9, state: "passing", review: "APPROVED" } });
	assert.equal(alt.args, "merge 9");
	// BLOCKED is GitHub saying no — no merge suggestion
	assert.equal(rule({ git: true, upstream: "o/m", pr: { number: 31, state: "passing", mergeState: "BLOCKED" } }), null);
});

test("nextStep: failing PR checks → watch them", () => {
	const next = rule({ git: true, pr: { number: 142, state: "failing" } });
	assert.equal(next.args, "checks 142");
	assert.equal(next.command, "gh pr checks 142 --watch");
	// passing or absent checks suggest nothing
	assert.equal(rule({ git: true, pr: { number: 142, state: "passing" } }), null);
	assert.equal(rule({ git: true }), null);
});

test("nextStep: the ranking order can be overridden by the config file", async (t) => {
	const home = await makeTempDir(t, "dsh-git-badge-next-");
	process.env.DSH_HOME = home;
	t.after(() => { delete process.env.DSH_HOME; });
	await writeFile(join(home, "git-badge-next.json"), JSON.stringify({ order: ["commit", "sync"] }));
	// dirty + behind: default ranks sync first; the override puts commit first
	const next = rule({ git: true, upstream: "o/m", behind: 2, stagedFiles: 1 });
	assert.equal(next.args, "commit");
	// unknown categories and omitted ones behave: unlisted rank after, in default order
	await writeFile(join(home, "git-badge-next.json"), JSON.stringify({ order: ["bogus", "merge"] }));
	assert.equal(
		rule({ git: true, upstream: "o/m", pr: { number: 5, state: "passing", mergeState: "CLEAN" } }).args,
		"merge 5",
	);
});

test("a clean repository response carries no next field", async (t) => {
	const repo = await makeRepo(t);
	await repo.commit("initial");
	const info = await gitStatus(repo.root);
	assert.equal(info.git, true);
	assert.equal(info.next, void 0);
});

test("the detail payload vouches a https compare URL", async (t) => {
	const repo = await makeRepo(t);
	await repo.commit("base");
	await repo.git(["remote", "add", "origin", "https://github.com/me/repo.git"]);
	// no network: create the remote-tracking ref directly (base probe reads it)
	await runGit(repo.root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
	await repo.commit("on branch work");
	const detail = await gitStatus(repo.root, true);
	assert.equal(detail.repoUrl, "https://github.com/me/repo");
	assert.equal(detail.compareUrl, "https://github.com/me/repo/compare/main...main");
	// ssh syntax converts; a .git suffix is stripped
	await repo.git(["remote", "set-url", "origin", "git@github.com:me/repo2.git"]);
	const ssh = await gitStatus(repo.root, true);
	assert.equal(ssh.repoUrl, "https://github.com/me/repo2");
	// no origin → absent
	await runGit(repo.root, ["remote", "remove", "origin"]);
	const none = await gitStatus(repo.root, true);
	assert.equal(none.repoUrl, void 0);
	assert.equal(none.compareUrl, void 0);
});

test("the detail payload carries ahead/behind vs main", async (t) => {
	const repo = await makeRepo(t);
	await repo.commit("base");
	const bare = join(repo.root, "origin-bare.git");
	await runGit(repo.root, ["clone", "--bare", repo.root, bare]);
	await runGit(repo.root, ["remote", "add", "origin", bare]);
	await runGit(repo.root, ["push", "-u", "origin", "main"]);
	// in sync with origin/main → no row at all
	const synced = await gitStatus(repo.root, true);
	assert.equal(synced.mainAhead, void 0);
	assert.equal(synced.mainBehind, void 0);
	// branch work: two commits main does not have
	await runGit(repo.root, ["checkout", "-b", "feat/x"]);
	await repo.commit("branch work");
	await repo.commit("more branch work");
	await runGit(repo.root, ["fetch", "origin"]);
	const detail = await gitStatus(repo.root, true);
	assert.equal(detail.mainAhead, 2, "two commits main does not have");
	assert.equal(detail.mainBehind, 0);
	// main moves on without the branch → behind appears as well
	const other = await makeTempDir(t, "dsh-git-badge-mainmove-");
	await runGit(other, ["clone", "--quiet", bare, "clone"]);
	await runGit(join(other, "clone"), ["config", "user.email", "t@e.com"]);
	await runGit(join(other, "clone"), ["config", "user.name", "T"]);
	await writeFile(join(other, "clone", "main-move.txt"), "main moves\n");
	await runGit(join(other, "clone"), ["add", "main-move.txt"]);
	await runGit(join(other, "clone"), ["commit", "-m", "main moves on"]);
	await runGit(join(other, "clone"), ["push", "origin", "main"]);
	await runGit(repo.root, ["fetch", "origin"]);
	const diverged = await gitStatus(repo.root, true);
	assert.equal(diverged.mainAhead, 2);
	assert.equal(diverged.mainBehind, 1);
});

test("the detail payload carries the signed ahead/behind commit list", async (t) => {
	const repo = await makeRepo(t);
	await repo.commit("base");
	const bare = join(repo.root, "origin-bare.git");
	await runGit(repo.root, ["clone", "--bare", repo.root, bare]);
	await runGit(repo.root, ["remote", "add", "origin", bare]);
	await runGit(repo.root, ["push", "-u", "origin", "main"]);
	await runGit(repo.root, ["checkout", "-b", "feat/x"]);
	await repo.commit("branch work");
	// main moves on without the branch: one behind commit
	const other = await makeTempDir(t, "dsh-git-badge-mainmove-");
	await runGit(other, ["clone", "--quiet", bare, "clone"]);
	await runGit(join(other, "clone"), ["config", "user.email", "t@e.com"]);
	await runGit(join(other, "clone"), ["config", "user.name", "T"]);
	await writeFile(join(other, "clone", "main-move.txt"), "main moves\n");
	await runGit(join(other, "clone"), ["add", "main-move.txt"]);
	await runGit(join(other, "clone"), ["commit", "-m", "main moves on"]);
	await runGit(join(other, "clone"), ["push", "origin", "main"]);
	await runGit(repo.root, ["fetch", "origin"]);
	const detail = await gitStatus(repo.root, true);
	assert.equal(detail.git, true);
	assert.equal(detail.branchCommitsTotal, 2, "1 ahead + 1 behind");
	const branchCommit = detail.branchCommits.find((c) => c.subject === "branch work");
	assert.equal(branchCommit.sign, "+", "ahead commits are +");
	const mainCommit = detail.branchCommits.find((c) => c.subject === "main moves on");
	assert.equal(mainCommit.sign, "\u2212", "behind commits are \u2212");
	// without a default branch: plain last 10, unsigned
	const noBase = await makeRepo(t);
	await noBase.commit("solo");
	const plain = await gitStatus(noBase.root, true);
	assert.equal(plain.branchCommits.length, 1);
	assert.equal(plain.branchCommits[0].sign, void 0);
	const base = await gitStatus(repo.root);
	assert.equal(base.branchCommits, void 0, "hover-gated");
});

test("the detail payload carries capped, shortened untracked names", async (t) => {
	const repo = await makeRepo(t);
	await repo.commit("initial");
	// 25 untracked files across nested dirs: cap at 20, last-two-segments, total kept
	for (let i = 0; i < 25; i += 1) {
		await repo.write(`deep/nested/dir/file-${i}.txt`, i + "\n");
	}
	const base = await gitStatus(repo.root);
	assert.equal(base.git, true);
	assert.equal(base.untrackedFiles, 25);
	assert.equal(base.untrackedNames, void 0, "names are hover-gated: the base request never carries them");
	const detail = await gitStatus(repo.root, true);
	assert.equal(detail.untrackedNames.length, 20, "capped at 20");
	assert.equal(detail.untrackedNamesTotal, 25, "the total rides separately for honest 'and k more'");
	assert.ok(detail.untrackedNames.every((n) => !n.includes("/") || n.split("/").length === 2), "last two segments only");
	assert.ok(detail.untrackedNames[0].includes("file-0"), "the file name survives the shortening");
	// collapsed mode: directories, not files — no names at all
	// (forced via the collapsed retry path; here just assert absence when absent)
});

test("a dirty repository response carries the commit suggestion", async (t) => {
	// makeRepo has no remote: upstream is undefined, so the first-publish rule
	// outranks the commit suggestion — documented here end-to-end.
	const repo = await makeRepo(t);
	await repo.commit("initial");
	await repo.write("b.txt", "dirty\n");
	const info = await gitStatus(repo.root);
	assert.equal(info.git, true);
	assert.equal(info.next.args, "push");
	assert.equal(info.next.why, "no upstream configured");
});

test("the base response flags the repository's default branch", async (t) => {
	const repo = await makeRepo(t);
	await repo.commit("base");
	const bare = join(repo.root, "origin-bare.git");
	await runGit(repo.root, ["clone", "--bare", repo.root, bare]);
	await runGit(repo.root, ["remote", "add", "origin", bare]);
	await runGit(repo.root, ["push", "-u", "origin", "main"]);
	// origin/HEAD is what the node half reads; a clone sets it, a bare push does not
	await runGit(repo.root, ["remote", "set-head", "origin", "-a"]);
	// the lookup is out of band, so the first read may answer without the flag —
	// poll explicitly (this file's waitFor does not await its callback)
	let seen;
	for (let attempt = 0; attempt < 40 && seen === void 0; attempt += 1) {
		const info = await gitStatus(repo.root);
		if (info.defaultBranch === true) seen = info;
		else await new Promise((resolve) => setTimeout(resolve, 25));
	}
	assert.equal(seen?.defaultBranch, true, "main is the default branch");
	// a feature branch is not
	await runGit(repo.root, ["checkout", "-b", "feat/x"]);
	const feature = await gitStatus(repo.root);
	assert.equal(feature.defaultBranch, void 0);
});

// ---------------------------------------------------------------------------
// nextActions — the ONE action list both surfaces render. The client used to
// re-derive these rules and the two copies drifted (a client-only extra once
// became the card's action row; /gh pr was offered on the default branch), so
// the shape asserted here IS the contract: one primary at most, standing
// options never primary, merge available whenever the PR is mergeable.
// ---------------------------------------------------------------------------

const ACTION_BASE = { git: true, branch: "feat/x", upstream: "origin/feat/x", ahead: 0, behind: 0, dirty: false, stagedFiles: 0, unstagedFiles: 0, untrackedFiles: 0 };
const MERGEABLE = { number: 46, state: "passing", mergeState: "CLEAN", review: "APPROVED", open: true };

test("nextActions: merge is a standalone entry when the PR is mergeable but outranked", () => {
	// pushing comes first (publish precedes merge in the default order), yet merge
	// is still offered — the reason this list exists rather than a single verdict
	const ahead = nextActions({ ...ACTION_BASE, ahead: 1, pr: MERGEABLE });
	assert.equal(ahead.next.args, "push", "publish is the primary action");
	assert.deepEqual(ahead.actions.map((a) => a.args), ["push", "merge 46", "pr view 46"]);
	assert.equal(ahead.actions.filter((a) => a.primary === true).length, 1, "exactly one primary");
	// behind: same story, pull first
	const behind = nextActions({ ...ACTION_BASE, behind: 2, pr: MERGEABLE });
	assert.deepEqual(behind.actions.map((a) => a.args), ["pull", "merge 46", "pr view 46"]);
	// in sync, merge leads
	const synced = nextActions({ ...ACTION_BASE, pr: MERGEABLE });
	assert.equal(synced.next.args, "merge 46");
	assert.equal(synced.actions[0].primary, true);
});

test("nextActions: standing options are never the primary suggestion", () => {
	// a clean, synced feature branch has plenty to offer and nothing to suggest
	const clean = nextActions({ ...ACTION_BASE });
	assert.equal(clean.next, null, "no suggestion is also a suggestion");
	assert.deepEqual(clean.actions.map((a) => a.args), ["pr"], "but opening a PR is available");
	assert.equal(clean.actions[0].primary, void 0);
	// untracked files add the flagged clean entry, last
	const dirty = nextActions({ ...ACTION_BASE, dirty: true, untrackedFiles: 2 });
	assert.deepEqual(dirty.actions.map((a) => a.args), ["commit", "clean"]);
	const cleanEntry = dirty.actions[dirty.actions.length - 1];
	assert.equal(cleanEntry.args, "clean");
	assert.equal(cleanEntry.danger, true);
	assert.equal(cleanEntry.primary, void 0);
});

test("nextActions: a default branch is offered nothing", () => {
	const main = nextActions({ ...ACTION_BASE, branch: "main", upstream: "origin/main", defaultBranch: true });
	assert.deepEqual(main.actions, []);
	assert.equal(main.next, null);
});

test("the detail payload lists the PR's own commits (base..HEAD)", async (t) => {
	const repo = await makeRepo(t);
	await repo.commit("base");
	const bare = join(repo.root, "origin-bare.git");
	await runGit(repo.root, ["clone", "--bare", repo.root, bare]);
	await runGit(repo.root, ["remote", "add", "origin", bare]);
	await runGit(repo.root, ["push", "-u", "origin", "main"]);
	await runGit(repo.root, ["checkout", "-b", "feat/x"]);
	await repo.commit("first in the PR");
	await repo.commit("second in the PR");
	// the forge read only spawns for a GitHub-shaped origin, so the tracking refs
	// are made against the bare path first and the URL is swapped afterwards
	await runGit(repo.root, ["remote", "set-url", "origin", "git@github.com:owner/repo.git"]);
	const previous = config.prRunner;
	config.prRunner = () => Promise.resolve({ stdout: JSON.stringify({ number: 47, state: "OPEN", statusCheckRollup: [] }) });
	t.after(() => {
		config.prRunner = previous;
	});
	// the forge read is TTL-cached and out of band: poll until it lands
	let detail;
	for (let attempt = 0; attempt < 40 && detail?.prCommits === void 0; attempt += 1) {
		const info = await gitStatus(repo.root, true, true);
		if (info.pr !== void 0) detail = info;
		else await new Promise((resolve) => setTimeout(resolve, 25));
	}
	assert.ok(detail !== void 0, "the PR read lands");
	assert.deepEqual(detail.prCommits.map((c) => c.subject), ["second in the PR", "first in the PR"], "base..HEAD, newest first");
	assert.equal(detail.prCommitsTotal, 2, "the ahead count already computed, not a second rev-list");
	// in sync with the base there is nothing in the PR, so the token has no hover
	await runGit(repo.root, ["push", bare, "feat/x:main"]);
	await runGit(repo.root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
	const synced = await gitStatus(repo.root, true, true);
	assert.equal(synced.prCommits, void 0, "no commits beyond the base — no tooltip");
});
