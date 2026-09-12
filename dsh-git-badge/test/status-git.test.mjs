/**
 * gitStatus end-to-end against real repositories — the layer that used to be
 * verifiable only by restarting DSH.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { changeListeners, config, gitStatus, runGit as pluginRunGit } from "../lib/index.js";
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
