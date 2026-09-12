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
