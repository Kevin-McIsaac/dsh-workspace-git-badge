/**
 * Watcher lifecycle: creation, debounce, unwatch, the missing-.git backoff, and
 * registry reconciliation. These run real recursive fs.watch on temp repos, so
 * every test releases its watchers in t.after — an open watcher keeps the
 * node:test process alive.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	changeListeners,
	config,
	outerGitDir,
	syncWatchers,
	unwatchWorkspace,
	watchWorkspace,
	watchers
} from "../lib/index.js";
import { fakeCtx, waitFor } from "../test-support/harness.mjs";
import { makeRepo, makeTempDir, runGit } from "../test-support/repo.mjs";

/** Subscribe a spy to change notifications; released with the test. */
function spyOn(t) {
	const seen = [];
	// notifications carry a payload: { path, workspace }
	const spy = (payload) => seen.push(payload);
	changeListeners.add(spy);
	t.after(() => changeListeners.delete(spy));
	return seen;
}

/** Release every watcher this test may have created. */
function releaseWatchers(t) {
	t.after(() => {
		for (const key of [...watchers.keys()]) unwatchWorkspace(key);
	});
}

test("watchWorkspace attaches a watcher for a repository", async (t) => {
	const repo = await makeRepo(t);
	releaseWatchers(t);
	watchWorkspace(repo.root, repo.root);
	const record = watchers.get(repo.root);
	assert.ok(record, "expected a watcher record");
	assert.notEqual(record.watcher, null);
});

test("a change under the repository notifies the subscriber once", async (t) => {
	const repo = await makeRepo(t);
	releaseWatchers(t);
	const seen = spyOn(t);
	watchWorkspace(repo.root, repo.root, "ws-test");
	writeFileSync(join(repo.root, "x.txt"), "x\n");
	const hit = await waitFor(() => seen.length > 0);
	assert.ok(hit, "expected a change notification");
	// both fields matter: `path` for debugging, `workspace` so a client that
	// asked by id can match the event without knowing a path
	assert.equal(seen[0].path, repo.root);
	assert.equal(seen[0].workspace, "ws-test");
});

test("a burst of writes collapses to a single notification (debounce)", async (t) => {
	const repo = await makeRepo(t);
	releaseWatchers(t);
	const seen = spyOn(t);
	watchWorkspace(repo.root, repo.root);
	for (let index = 0; index < 5; index += 1) {
		writeFileSync(join(repo.root, `burst-${index}.txt`), "x\n");
	}
	await new Promise((resolve) => setTimeout(resolve, config.debounceMs + 700));
	assert.equal(seen.length, 1);
});

test("unwatchWorkspace closes the watcher and stops notifications", async (t) => {
	const repo = await makeRepo(t);
	releaseWatchers(t);
	const seen = spyOn(t);
	watchWorkspace(repo.root, repo.root);
	unwatchWorkspace(repo.root);
	assert.equal(watchers.has(repo.root), false);
	writeFileSync(join(repo.root, "after.txt"), "x\n");
	await new Promise((resolve) => setTimeout(resolve, config.debounceMs + 400));
	assert.equal(seen.length, 0);
});

test("a directory without .git is remembered as failed, then picked up after the backoff", async (t) => {
	const dir = await makeTempDir(t, "dsh-git-badge-nogit-");
	releaseWatchers(t);
	const originalRetry = config.watchRetryMs;
	t.after(() => {
		config.watchRetryMs = originalRetry;
	});
	watchWorkspace(dir, dir);
	const failed = watchers.get(dir);
	assert.ok(failed, "expected the failed attempt to be remembered");
	assert.equal(failed.watcher, null);
	// still inside the backoff: no re-attempt even though .git now exists
	await runGit(dir, ["init", "-b", "main"]);
	watchWorkspace(dir, dir);
	assert.equal(watchers.get(dir).watcher, null);
	// backoff expired: the new repository is picked up
	config.watchRetryMs = 0;
	watchWorkspace(dir, dir);
	assert.notEqual(watchers.get(dir).watcher, null);
});

test("syncWatchers adds registered workspaces and drops unregistered ones", async (t) => {
	const first = await makeRepo(t);
	const second = await makeRepo(t);
	releaseWatchers(t);
	syncWatchers(fakeCtx({ workspaces: [first.root, second.root] }).ctx);
	assert.equal(watchers.has(first.root), true);
	assert.equal(watchers.has(second.root), true);
	syncWatchers(fakeCtx({ workspaces: [first.root] }).ctx);
	assert.equal(watchers.has(first.root), true);
	assert.equal(watchers.has(second.root), false);
});

// ---- degraded mode: the poll fallback for a workspace whose watcher failed ----

/** Run a test with a short poll interval; restores the knob afterwards. */
function withFastPoll(t) {
	const original = config.pollFallbackMs;
	config.pollFallbackMs = 120;
	t.after(() => {
		config.pollFallbackMs = original;
	});
}

test("a healthy watcher starts no fallback poll", async (t) => {
	const repo = await makeRepo(t);
	releaseWatchers(t);
	watchWorkspace(repo.root, repo.root, "ws-ok");
	const record = watchers.get(repo.root);
	assert.notEqual(record.watcher, null);
	assert.equal(record.poll, undefined, "an event-driven workspace must not poll");
});

test("a directory without .git is never polled", async (t) => {
	const dir = await makeTempDir(t, "dsh-git-badge-nogit-");
	releaseWatchers(t);
	watchWorkspace(dir, dir, "ws-nogit");
	const record = watchers.get(dir);
	assert.ok(record);
	assert.equal(record.watcher, null);
	// a non-repository has nothing to report; the retry backoff covers it
	assert.equal(record.poll, undefined);
});

test("a watcher that errors falls back to polling and still notifies", async (t) => {
	const repo = await makeRepo(t);
	releaseWatchers(t);
	withFastPoll(t);
	const seen = spyOn(t);
	watchWorkspace(repo.root, repo.root, "ws-poll");
	// simulate the real failure mode: the watcher is established, then dies
	// (inotify budget exhausted, tree replaced, permissions changed)
	watchers.get(repo.root).watcher.emit("error", new Error("simulated watcher failure"));
	const record = watchers.get(repo.root);
	assert.equal(record.watcher, null, "the dead watcher is dropped");
	assert.ok(record.poll !== undefined, "the degraded poll takes over");
	// wait for the baseline tick before changing anything — otherwise the change
	// is simply part of the baseline and there is nothing to announce
	await waitFor(() => record.pollKey !== void 0, { timeoutMs: 2000 });
	writeFileSync(join(repo.root, "polled.txt"), "x\n");
	const hit = await waitFor(() => seen.length > 0, { timeoutMs: 4000 });
	assert.ok(hit, "expected the fallback poll to notice the change");
	assert.equal(seen[0].workspace, "ws-poll");
	assert.equal(seen[0].path, repo.root);
});

test("the fallback poll reports a ref change it cannot see in the worktree", async (t) => {
	const repo = await makeRepo(t);
	await repo.commit("initial");
	releaseWatchers(t);
	withFastPoll(t);
	const seen = spyOn(t);
	watchWorkspace(repo.root, repo.root, "ws-refs");
	watchers.get(repo.root).watcher.emit("error", new Error("simulated"));
	// let the baseline tick settle before changing anything
	await waitFor(() => watchers.get(repo.root)?.pollKey !== void 0, { timeoutMs: 2000 });
	await repo.branch("feature-branch");
	const hit = await waitFor(() => seen.length > 0, { timeoutMs: 4000 });
	assert.ok(hit, "a new branch must move the refs fingerprint");
});

test("unwatchWorkspace stops the fallback poll too", async (t) => {
	const repo = await makeRepo(t);
	releaseWatchers(t);
	withFastPoll(t);
	const seen = spyOn(t);
	watchWorkspace(repo.root, repo.root, "ws-poll");
	watchers.get(repo.root).watcher.emit("error", new Error("simulated"));
	assert.ok(watchers.get(repo.root).poll !== undefined);
	unwatchWorkspace(repo.root);
	assert.equal(watchers.has(repo.root), false);
	writeFileSync(join(repo.root, "after-unwatch.txt"), "x\n");
	await new Promise((resolve) => setTimeout(resolve, 500));
	assert.equal(seen.length, 0, "a released workspace must stop notifying");
});

// ---- linked worktrees: the git dir lives OUTSIDE the worktree root ----

/** Sleep past the debounce window, for assertions that must stay silent. */
const settle = () => new Promise((resolve) => setTimeout(resolve, config.debounceMs + 500));

test("outerGitDir resolves a linked worktree's gitfile, and is null for a main worktree", async (t) => {
	const repo = await makeRepo(t);
	await repo.commit("initial");
	const linked = await repo.worktreeAdd({ name: "linked", branch: "feature" });
	assert.equal(outerGitDir(repo.root), null, "a main worktree's git dir sits inside its root");
	const dir = outerGitDir(linked);
	assert.ok(dir !== null, "a linked worktree has an out-of-tree git dir");
	assert.match(dir, /[\\/]worktrees[\\/]linked$/);
});

test("only a linked worktree needs the second watcher", async (t) => {
	const repo = await makeRepo(t);
	await repo.commit("initial");
	const linked = await repo.worktreeAdd({ name: "linked", branch: "feature" });
	releaseWatchers(t);
	watchWorkspace(repo.root, repo.root, "ws-main");
	watchWorkspace(linked, linked, "ws-linked");
	assert.equal(watchers.get(repo.root).extra, null, "a main worktree is fully covered by its root watch");
	assert.notEqual(watchers.get(linked).extra, null, "a linked worktree's git dir must be watched too");
});

test("REGRESSION: staging in a linked worktree notifies although nothing under it changes", async (t) => {
	const repo = await makeRepo(t);
	await repo.commit("initial");
	const linked = await repo.worktreeAdd({ name: "linked", branch: "feature" });
	// Dirty the tracked file BEFORE the watch exists, so no root-watch event can
	// arrive afterwards. `git add` then writes only
	// <main>/.git/worktrees/linked/index — nothing at all under `linked` — so the
	// git-dir watcher is the only thing that can possibly notify.
	writeFileSync(join(linked, "a.txt"), "changed\n");
	releaseWatchers(t);
	const seen = spyOn(t);
	watchWorkspace(linked, linked, "ws-linked");
	await runGit(linked, ["add", "a.txt"]);
	const hit = await waitFor(() => seen.length > 0, { timeoutMs: 3000 });
	assert.ok(hit, "a stage in a linked worktree must notify via the git-dir watcher");
	assert.equal(seen[0].workspace, "ws-linked");
	assert.equal(seen[0].path, linked);
});

test("unwatchWorkspace releases the linked worktree's git-dir watcher too", async (t) => {
	const repo = await makeRepo(t);
	await repo.commit("initial");
	const linked = await repo.worktreeAdd({ name: "linked", branch: "feature" });
	writeFileSync(join(linked, "a.txt"), "changed\n");
	releaseWatchers(t);
	const seen = spyOn(t);
	watchWorkspace(linked, linked, "ws-linked");
	unwatchWorkspace(linked);
	assert.equal(watchers.has(linked), false);
	// the exact operation the extra watcher exists to catch — it must stay silent
	await runGit(linked, ["add", "a.txt"]);
	await settle();
	assert.equal(seen.length, 0, "a released worktree must stop notifying");
});
