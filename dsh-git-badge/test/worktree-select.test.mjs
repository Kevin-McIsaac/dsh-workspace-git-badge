/**
 * Worktree-aware status: the selection rule, the repository-wide open-PR read,
 * the watcher a follow needs, and the route contract that exposes it.
 *
 * The contract has one hard edge. The plugin CANNOT know which worktree a session
 * uses — DSH records no session→worktree link, session cwd is immutable creation
 * metadata, and `attachSession` requires it to equal the workspace path — so the
 * only selection it may make is the one that cannot be ambiguous: a repository
 * with exactly one linked worktree whose branch has an OPEN pull request.
 * Everything else must leave the badge on the directory the session actually
 * names. Most of these tests are therefore about the cases that must NOT swap.
 *
 * No `gh`, no network: `config.prRunner` substitutes for the CLI, exactly as in
 * pr.test.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	apply,
	changeListeners,
	config,
	effectiveTarget,
	gitStatus,
	openPrsFor,
	parseWorktreeList,
	prListState,
	prState,
	prStatusFor,
	readOpenPrs,
	readWorktrees,
	runGit,
	selectSessionWorktree,
	selectedWorktrees,
	statusInFlight,
	syncWatchers,
	unwatchWorkspace,
	watchers
} from "../lib/index.js";
import { fakeCtx, fakeReq, fakeStream, waitFor } from "../test-support/harness.mjs";
import { makeRepo } from "../test-support/repo.mjs";

const WORKSPACE_ID = "ws-tree";
const SESSION_ID = "sess-tree";

/** A repository whose `origin` looks like GitHub, with no upstream (so no fetch). */
async function githubRepo(t) {
	const repo = await makeRepo(t);
	await repo.commit("initial");
	await repo.git(["remote", "add", "origin", "git@github.com:owner/repo.git"]);
	return repo;
}

/** The body `gh pr list --json …` prints for one open PR. */
function openPrBody(branch, { number = 391, conclusion = "SUCCESS" } = {}) {
	return [
		{
			number,
			headRefName: branch,
			state: "OPEN",
			isDraft: false,
			reviewDecision: "",
			statusCheckRollup: [{ status: "COMPLETED", conclusion }]
		}
	];
}

/**
 * Substitute the `gh` CLI. `pr list` answers with `state.list` (mutable between
 * refreshes) and `pr view` looks the named branch up in it — the same answer the
 * real CLI gives for a branch with an open PR. Every other invocation fails the
 * way a `gh` with nothing to say does, which is the shape the PR region must
 * degrade on.
 */
function stubForge(t, { list = [] } = {}) {
	const calls = [];
	const state = { list };
	config.prRunner = (cmd, args, opts) => {
		calls.push({ cmd, args, opts });
		if (args[0] === "pr" && args[1] === "list") return Promise.resolve({ stdout: JSON.stringify(state.list) });
		if (args[0] === "pr" && args[1] === "view") {
			const row = state.list.find((entry) => entry.headRefName === args[2]);
			return Promise.resolve(row === void 0 ? { stdout: null, exitCode: 1 } : { stdout: JSON.stringify(row) });
		}
		return Promise.resolve({ stdout: null, exitCode: 1 });
	};
	t.after(() => {
		config.prRunner = null;
	});
	return { calls, state };
}

/** Subscribe a spy to change notifications; released with the test. */
function spyOn(t) {
	const seen = [];
	const spy = (payload) => seen.push(payload);
	changeListeners.add(spy);
	t.after(() => changeListeners.delete(spy));
	return seen;
}

/**
 * Every cache and watcher here is module-level and per-process, so each test
 * starts from and restores an empty world. The restore matters twice over:
 * an open fs watcher keeps the node:test process alive.
 */
function clearState(t) {
	const reset = () => {
		prState.clear();
		prListState.clear();
		selectedWorktrees.clear();
		statusInFlight.clear();
		for (const key of [...watchers.keys()]) unwatchWorkspace(key);
	};
	reset();
	t.after(reset);
}

/** Registered-workspace repo plus the captured routes, as routes.test.mjs builds it. */
async function setup(t) {
	const repo = await githubRepo(t);
	const { ctx, routes, entities, disposeAll } = fakeCtx({
		workspaces: [{ id: WORKSPACE_ID, path: repo.root, sessionIds: [SESSION_ID] }]
	});
	apply(ctx);
	t.after(() => disposeAll());
	return { repo, routes, entities };
}

async function get(routes, query) {
	const req = fakeReq({ url: `/api/git-badge${query}` });
	const res = fakeStream();
	await routes.get("/api/git-badge").handler(req, res);
	return res;
}

//#region parsing

test("parseWorktreeList reads every porcelain block, flags included", () => {
	const parsed = parseWorktreeList(
		[
			"worktree /repo",
			"HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			"branch refs/heads/main",
			"",
			"worktree /repo/.wt/two",
			"HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			"branch refs/heads/feat/two",
			"",
			"worktree /repo/.wt/detached",
			"HEAD cccccccccccccccccccccccccccccccccccccccc",
			"detached",
			"",
			"worktree /repo/.wt/locked",
			"HEAD dddddddddddddddddddddddddddddddddddddddd",
			"branch refs/heads/feat/locked",
			"locked",
			"",
			"worktree /repo/.wt/gone",
			"HEAD eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
			"branch refs/heads/feat/gone",
			"prunable gitdir file points to non-existent location",
			""
		].join("\n")
	);
	assert.deepEqual(
		parsed.map((entry) => [entry.name, entry.branch, entry.detached, entry.locked, entry.prunable]),
		[
			["repo", "main", false, false, false],
			["two", "feat/two", false, false, false],
			["detached", void 0, true, false, false],
			["locked", "feat/locked", false, true, false],
			["gone", "feat/gone", false, false, true]
		]
	);
	// the NAME is what may be reported; the path never is
	assert.equal(parsed[1].path, "/repo/.wt/two");
});

test("parseWorktreeList tolerates empty and truncated output", () => {
	assert.deepEqual(parseWorktreeList(""), []);
	assert.deepEqual(parseWorktreeList("\n\n"), []);
	// a trailing block without its closing blank line is still a worktree
	assert.deepEqual(parseWorktreeList("worktree /only\nHEAD abc\nbranch refs/heads/x").map((e) => e.name), ["only"]);
});

//#endregion
//#region reading

test("readWorktrees identifies the checkout it was asked about", async (t) => {
	const repo = await githubRepo(t);
	const tree = await repo.worktreeAdd({ name: "linked-tree", branch: "feat/tree" });
	const fromMain = await readWorktrees(repo.root);
	const fromTree = await readWorktrees(tree);
	assert.equal(fromMain.worktrees.length, 2);
	assert.equal(fromMain.toplevel, fromMain.worktrees[0].path, "the main worktree is listed first");
	assert.equal(fromMain.worktrees[1].path, await realpath(tree));
	assert.equal(fromMain.worktrees[1].branch, "feat/tree");
	// from inside the linked worktree, git's toplevel is the WORKTREE, while the
	// list still starts at the main checkout — that difference is the whole test
	// effectiveTarget uses to refuse a sideways swap
	assert.equal(fromTree.toplevel, await realpath(tree));
	assert.notEqual(fromTree.toplevel, fromTree.worktrees[0].path);
});

test("readWorktrees degrades to no worktrees when git cannot answer", async (t) => {
	const repo = await githubRepo(t);
	await repo.git(["worktree", "list"]); // sanity: a real repository
	const nested = join(repo.root, "not-a-repo", "deeper");
	const { toplevel, worktrees } = await readWorktrees(nested);
	assert.equal(toplevel, "");
	assert.deepEqual(worktrees, []);
});

//#endregion
//#region selection rule

const MAIN = { path: "/repo", name: "repo", branch: "main", detached: false, bare: false, prunable: false };
const linked = (name, branch, overrides = {}) => ({
	path: `/repo/.wt/${name}`,
	name,
	branch,
	detached: false,
	bare: false,
	prunable: false,
	...overrides
});

test("selectSessionWorktree takes the single worktree whose branch has an open PR", () => {
	const two = linked("two", "feat/two");
	assert.equal(selectSessionWorktree([MAIN, two], new Map([["feat/two", { number: 1 }]]), "/repo"), two);
});

test("selectSessionWorktree refuses an ambiguous repository", () => {
	const map = new Map([
		["feat/two", { number: 1 }],
		["feat/three", { number: 2 }]
	]);
	const picked = selectSessionWorktree([MAIN, linked("two", "feat/two"), linked("three", "feat/three")], map, "/repo");
	assert.equal(picked, void 0, "two candidates is a reason to say nothing, not to guess");
});

test("selectSessionWorktree never picks the checkout itself, a detached head or an unusable entry", () => {
	const map = new Map([
		["main", { number: 1 }],
		["feat/detached", { number: 2 }],
		["feat/bare", { number: 3 }],
		["feat/gone", { number: 4 }],
		["feat/ok", { number: 5 }]
	]);
	// each of these would be the single candidate if its flag were ignored: the
	// branch IS in the map, so only the exclusion can produce silence
	assert.equal(selectSessionWorktree([MAIN], map, "/repo"), void 0);
	assert.equal(selectSessionWorktree([MAIN, linked("detached", "feat/detached", { detached: true })], map, "/repo"), void 0);
	assert.equal(selectSessionWorktree([MAIN, linked("bare", "feat/bare", { bare: true })], map, "/repo"), void 0);
	assert.equal(selectSessionWorktree([MAIN, linked("gone", "feat/gone", { prunable: true })], map, "/repo"), void 0);
	// a branch with no PR is not a candidate either, and an empty map is silence
	assert.equal(selectSessionWorktree([MAIN, linked("two", "feat/other")], map, "/repo"), void 0);
	assert.equal(selectSessionWorktree([MAIN, linked("ok", "feat/ok")], new Map(), "/repo"), void 0);
	assert.equal(selectSessionWorktree([MAIN, linked("ok", "feat/ok")], void 0, "/repo"), void 0);
});

//#endregion
//#region open-PR list

test("readOpenPrs keys the repository's open PRs by head branch", async (t) => {
	const repo = await githubRepo(t);
	stubForge(t, {
		list: [
			...openPrBody("feat/two", { number: 2 }),
			...openPrBody("feat/three", { number: 3, conclusion: "FAILURE" }),
			// rows gh can return but the chip cannot use
			{ number: 4, state: "OPEN" },
			{ headRefName: "feat/no-number", state: "OPEN" }
		]
	});
	const byBranch = await readOpenPrs(repo.root);
	assert.deepEqual([...byBranch.keys()].sort(), ["feat/three", "feat/two"]);
	assert.equal(byBranch.get("feat/three").state, "failing");
	assert.equal(byBranch.get("feat/three").number, 3);
});

test("readOpenPrs is an empty map for every failure shape, never an error", async (t) => {
	const repo = await githubRepo(t);
	// gh ran and refused
	config.prRunner = () => Promise.resolve({ stdout: null, exitCode: 1 });
	t.after(() => {
		config.prRunner = null;
	});
	assert.equal((await readOpenPrs(repo.root)).size, 0);
	// unparseable output
	config.prRunner = () => Promise.resolve({ stdout: "not json" });
	assert.equal((await readOpenPrs(repo.root)).size, 0);
	// a JSON body of the wrong shape
	config.prRunner = () => Promise.resolve({ stdout: JSON.stringify({ nope: true }) });
	assert.equal((await readOpenPrs(repo.root)).size, 0);
	// a missing binary
	config.prRunner = () => Promise.resolve({ stdout: null, missing: true });
	assert.equal((await readOpenPrs(repo.root)).size, 0);
});

test("a non-GitHub origin never spawns gh", async (t) => {
	const repo = await makeRepo(t);
	await repo.commit("initial");
	const { calls } = stubForge(t, { list: openPrBody("feat/two") });
	assert.equal((await readOpenPrs(repo.root)).size, 0);
	assert.equal(calls.length, 0);
});

test("openPrsFor serves the cached set and refreshes it out of band", async (t) => {
	clearState(t);
	const repo = await githubRepo(t);
	const { calls, state } = stubForge(t, { list: openPrBody("feat/two") });
	// first call: nothing cached, so it answers nothing and spawns the refresh
	assert.equal(openPrsFor(repo.root, () => {}), void 0);
	await waitFor(() => prListState.get(repo.root)?.value !== void 0);
	assert.equal(calls.length, 1);
	// fresh window: the same answer without a second forge call
	assert.equal(openPrsFor(repo.root, () => {}).get("feat/two").number, 391);
	assert.equal(calls.length, 1);
	// lapse the window with a CHANGED set: the refresh lands and notifies, because a
	// changed set can change which worktree a session badge follows
	const notifications = [];
	state.list = openPrBody("feat/two", { number: 392 });
	prListState.get(repo.root).lastAttemptAt = 0;
	openPrsFor(repo.root, (key) => notifications.push(key));
	await waitFor(() => prListState.get(repo.root)?.value?.get("feat/two")?.number === 392);
	assert.equal(calls.length, 2);
	assert.deepEqual(notifications, [repo.root]);
});

//#endregion
//#region effectiveTarget

test("a session badge follows the one linked worktree whose branch has an open PR", async (t) => {
	clearState(t);
	const repo = await githubRepo(t);
	const tree = await repo.worktreeAdd({ name: "linked-tree", branch: "feat/tree" });
	stubForge(t, { list: openPrBody("feat/tree") });
	const target = { id: WORKSPACE_ID, path: repo.root };
	// the first request has no cached PR list yet: it answers with the session's own
	// directory and spawns the refresh, exactly as the PR region serves stale-then-
	// corrected — the chip picks the tree up on the notify that follows
	assert.equal((await effectiveTarget(target, true, true, () => {})).path, repo.root);
	await waitFor(() => prListState.get(repo.root)?.value !== void 0);
	const effective = await effectiveTarget(target, true, true, () => {});
	assert.equal(effective.id, WORKSPACE_ID, "the workspace id is untouched: clients match SSE events on it");
	assert.equal(effective.path, await realpath(tree));
	assert.deepEqual(effective.worktree, { name: "linked-tree", branch: "feat/tree" });
});

test("the swapped status describes the worktree, not the session's own checkout", async (t) => {
	clearState(t);
	const repo = await githubRepo(t);
	const tree = await repo.worktreeAdd({ name: "linked-tree", branch: "feat/tree" });
	writeFileSync(join(tree, "work.txt"), "work\n");
	stubForge(t, { list: openPrBody("feat/tree") });
	const target = { id: WORKSPACE_ID, path: repo.root };
	await effectiveTarget(target, true, true, () => {});
	await waitFor(() => prListState.get(repo.root)?.value !== void 0);
	const effective = await effectiveTarget(target, true, true, () => {});
	const info = await gitStatus(effective.path, false, true);
	// the PR read answers from cache and refreshes out of band, so the first call
	// after a swap carries no `pr` — warm it the way the chip does, by asking again
	await waitFor(() => prStatusFor(effective.path, "feat/tree", () => {}) !== void 0);
	const settled = await gitStatus(effective.path, false, true);
	assert.equal(info.branch, "feat/tree");
	assert.equal(info.isWorktree, true);
	assert.equal(info.worktreeName, "linked-tree");
	assert.equal(info.untrackedFiles, 1);
	assert.equal(settled.pr.number, 391);
	// and the checkout the session names is untouched by any of it
	const own = await gitStatus(target.path, false, false);
	assert.equal(own.branch, "main");
	assert.equal(own.isWorktree, false);
	assert.equal(own.untrackedFiles, 0);
});

test("a workspace-targeted row never follows a worktree", async (t) => {
	clearState(t);
	const repo = await githubRepo(t);
	await repo.worktreeAdd({ name: "linked-tree", branch: "feat/tree" });
	const { calls } = stubForge(t, { list: openPrBody("feat/tree") });
	const target = { id: WORKSPACE_ID, path: repo.root };
	const effective = await effectiveTarget(target, false, true, () => {});
	assert.equal(effective.path, repo.root);
	assert.equal(effective.worktree, void 0);
	assert.equal(calls.length, 0, "a row must not even consult the forge about a worktree");
});

test("a repository with no linked worktree costs no forge call", async (t) => {
	clearState(t);
	const repo = await githubRepo(t);
	const { calls } = stubForge(t, { list: openPrBody("feat/tree") });
	const target = { id: WORKSPACE_ID, path: repo.root };
	const effective = await effectiveTarget(target, true, true, () => {});
	assert.equal(effective.path, repo.root);
	assert.equal(calls.length, 0, "no worktrees means the selection can never fire, so gh is never asked");
});

test("a caller not asking about PR state is left alone", async (t) => {
	clearState(t);
	const repo = await githubRepo(t);
	await repo.worktreeAdd({ name: "linked-tree", branch: "feat/tree" });
	const { calls } = stubForge(t, { list: openPrBody("feat/tree") });
	const target = { id: WORKSPACE_ID, path: repo.root };
	assert.equal((await effectiveTarget(target, true, false, () => {})).path, repo.root);
	assert.equal(calls.length, 0);
});

test('worktreeStatus "off" restores the plain checkout', async (t) => {
	clearState(t);
	const repo = await githubRepo(t);
	const tree = await repo.worktreeAdd({ name: "linked-tree", branch: "feat/tree" });
	stubForge(t, { list: openPrBody("feat/tree") });
	const target = { id: WORKSPACE_ID, path: repo.root };
	await effectiveTarget(target, true, true, () => {});
	await waitFor(() => prListState.get(repo.root)?.value !== void 0);
	config.worktreeStatus = "off";
	t.after(() => {
		config.worktreeStatus = "auto";
	});
	assert.equal((await effectiveTarget(target, true, true, () => {})).path, repo.root);
	assert.equal(selectedWorktrees.size, 0, "and the follow is retired");
});

test("a session already inside a linked worktree is never swapped sideways", async (t) => {
	clearState(t);
	const repo = await githubRepo(t);
	const tree = await repo.worktreeAdd({ name: "linked-tree", branch: "feat/tree" });
	const other = await repo.worktreeAdd({ name: "other-tree", branch: "feat/other" });
	stubForge(t, { list: openPrBody("feat/other") });
	// the session's own directory IS a worktree: its own answer, even though a
	// SIBLING worktree is the one with the open PR
	const target = { id: WORKSPACE_ID, path: tree };
	await effectiveTarget(target, true, true, () => {});
	await waitFor(() => prListState.get(repo.root)?.value !== void 0);
	const effective = await effectiveTarget(target, true, true, () => {});
	assert.equal(effective.path, tree);
	assert.equal(effective.worktree, void 0);
	assert.ok(other);
});

//#endregion
//#region watchers for a followed worktree

test("the followed worktree is watched, and its events name the owning workspace", async (t) => {
	clearState(t);
	const { repo, entities } = await setup(t);
	const tree = await repo.worktreeAdd({ name: "linked-tree", branch: "feat/tree" });
	stubForge(t, { list: openPrBody("feat/tree") });
	await effectiveTarget(entities[0], true, true, () => {});
	await waitFor(() => prListState.get(repo.root)?.value !== void 0);
	await effectiveTarget(entities[0], true, true, () => {});
	const record = watchers.get(await realpath(tree));
	assert.ok(record, "a followed worktree needs its own watcher: it is usually not a registered workspace");
	assert.equal(
		record.workspaceId,
		WORKSPACE_ID,
		"its events must carry the workspace id the chip matched, or the client cannot attribute them"
	);
	// a real edit there reaches subscribers with that attribution
	const seen = spyOn(t);
	writeFileSync(join(tree, "edit.txt"), "edit\n");
	const hit = await waitFor(() => seen.length > 0);
	assert.ok(hit, "expected the worktree watch to fire");
	assert.equal(seen[0].workspace, WORKSPACE_ID);
});

test("syncWatchers keeps a followed worktree and retires an unregistered owner", async (t) => {
	clearState(t);
	const { repo, entities, routes } = await setup(t);
	const tree = await repo.worktreeAdd({ name: "linked-tree", branch: "feat/tree" });
	stubForge(t, { list: openPrBody("feat/tree") });
	await effectiveTarget(entities[0], true, true, () => {});
	await waitFor(() => prListState.get(repo.root)?.value !== void 0);
	await effectiveTarget(entities[0], true, true, () => {});
	assert.ok(watchers.has(await realpath(tree)));
	// a reconcile is what an SSE connect runs: it must not tear the follow down
	syncWatchers({ workspaceRegistry: { list: () => entities } });
	assert.ok(watchers.has(await realpath(tree)), "syncWatchers must keep a live selection");
	// with the workspace gone, the reconcile retires both the owner and its follow
	syncWatchers({ workspaceRegistry: { list: () => [] } });
	assert.equal(watchers.has(await realpath(tree)), false);
	assert.equal(selectedWorktrees.size, 0);
	assert.ok(routes.has("/api/git-badge"));
});

test("a follow is retired when the PR list no longer offers the worktree", async (t) => {
	clearState(t);
	const { repo, entities } = await setup(t);
	const tree = await repo.worktreeAdd({ name: "linked-tree", branch: "feat/tree" });
	const { state } = stubForge(t, { list: openPrBody("feat/tree") });
	await effectiveTarget(entities[0], true, true, () => {});
	await waitFor(() => prListState.get(repo.root)?.value !== void 0);
	assert.equal((await effectiveTarget(entities[0], true, true, () => {})).path, await realpath(tree));
	assert.ok(watchers.has(await realpath(tree)));
	// the PR merges/closes: no candidate is left, so the badge returns to the
	// session's own directory and the extra watcher must go with it
	state.list = [];
	prListState.get(repo.root).lastAttemptAt = 0;
	await effectiveTarget(entities[0], true, true, () => {});
	await waitFor(() => prListState.get(repo.root)?.value?.size === 0);
	const effective = await effectiveTarget(entities[0], true, true, () => {});
	assert.equal(effective.path, repo.root);
	assert.equal(watchers.has(await realpath(tree)), false);
	assert.equal(selectedWorktrees.size, 0);
});

//#endregion
//#region route + caches

test("the route swaps a session target onto the worktree and says so", async (t) => {
	clearState(t);
	const { repo, routes } = await setup(t);
	const tree = await repo.worktreeAdd({ name: "linked-tree", branch: "feat/tree" });
	stubForge(t, { list: openPrBody("feat/tree") });
	// warm the two TTL caches the way the chip does, then take the answer it sees
	const treeReal = await realpath(tree);
	await get(routes, `?session=${SESSION_ID}&pr=1`);
	await waitFor(() => prListState.get(repo.root)?.value !== void 0);
	await waitFor(() => prStatusFor(treeReal, "feat/tree", () => {}) !== void 0);
	const body = JSON.parse((await get(routes, `?session=${SESSION_ID}&pr=1`)).text());
	assert.equal(body.branch, "feat/tree");
	assert.equal(body.isWorktree, true);
	assert.equal(body.worktreeName, "linked-tree");
	assert.equal(body.worktreeInferred, true);
	assert.equal(body.pr.number, 391);
	// the workspace id is still echoed for SSE attribution
	assert.equal(body.workspace, WORKSPACE_ID);
});

test("the route leaves a workspace target on its own checkout", async (t) => {
	clearState(t);
	const { repo, routes } = await setup(t);
	await repo.worktreeAdd({ name: "linked-tree", branch: "feat/tree" });
	stubForge(t, { list: openPrBody("feat/tree") });
	await get(routes, `?session=${SESSION_ID}&pr=1`);
	await waitFor(() => prListState.get(repo.root)?.value !== void 0);
	const body = JSON.parse((await get(routes, `?workspace=${WORKSPACE_ID}&pr=1`)).text());
	assert.equal(body.branch, "main");
	assert.equal(body.worktreeInferred, void 0);
	assert.equal("pr" in body, false, "a row never gets the worktree's PR either");
});

test("the hover card's checkout row is served only with detail=1", async (t) => {
	clearState(t);
	const { repo, routes } = await setup(t);
	await repo.worktreeAdd({ name: "linked-tree", branch: "feat/tree" });
	writeFileSync(join(repo.root, "dirty.txt"), "dirty\n");
	stubForge(t, { list: openPrBody("feat/tree") });
	await get(routes, `?session=${SESSION_ID}&pr=1`);
	await waitFor(() => prListState.get(repo.root)?.value !== void 0);
	// the chip's own request (pr only) carries no checkout: the card's extras are
	// lazy, and this is one of them
	const plain = JSON.parse((await get(routes, `?session=${SESSION_ID}&pr=1`)).text());
	assert.equal("checkout" in plain, false);
	const detailed = JSON.parse((await get(routes, `?session=${SESSION_ID}&pr=1&detail=1`)).text());
	assert.equal(detailed.worktreeInferred, true);
	assert.equal(detailed.checkout.branch, "main");
	assert.equal(detailed.checkout.untrackedFiles, 1);
	assert.equal(detailed.branch, "feat/tree", "the badge still describes the worktree");
});

test("identical concurrent status reads collapse into one git invocation", async (t) => {
	clearState(t);
	const repo = await githubRepo(t);
	const runs = [];
	const passthrough = config.gitRunner;
	config.gitRunner = (cwd, args, opts) => {
		runs.push(args.join(" "));
		return runGit(cwd, args, opts);
	};
	t.after(() => {
		config.gitRunner = passthrough;
	});
	const [a, b] = await Promise.all([gitStatus(repo.root, false, false), gitStatus(repo.root, false, false)]);
	assert.equal(a.branch, "main");
	assert.equal(b.branch, "main");
	const statusRuns = () => runs.filter((args) => args.includes("status")).length;
	assert.equal(statusRuns(), 1, "two rows mounting together must share one walk");
	assert.equal(statusInFlight.size, 0, "the in-flight entry is released");
	// and a LATER read is fresh: the default window is 0, so a mutated repo is
	// never reported stale
	await gitStatus(repo.root, false, false);
	assert.equal(statusRuns(), 2);
});

test("the PR cache is keyed by branch as well as toplevel", async (t) => {
	clearState(t);
	const repo = await githubRepo(t);
	// a forge that answers differently per branch, which is the only way to tell a
	// shared cache entry from a correct one
	config.prRunner = (cmd, args) =>
		Promise.resolve({
			stdout: JSON.stringify({ number: args[2] === "other" ? 999 : 142, state: "OPEN", statusCheckRollup: [] })
		});
	t.after(() => {
		config.prRunner = null;
	});
	const mainKey = repo.root + "\u0000main";
	const otherKey = repo.root + "\u0000other";
	prStatusFor(repo.root, "main", () => {});
	await waitFor(() => prState.get(mainKey)?.value !== void 0);
	prStatusFor(repo.root, "other", () => {});
	await waitFor(() => prState.get(otherKey)?.value !== void 0);
	assert.equal(prState.get(mainKey).value.number, 142);
	assert.equal(prState.get(otherKey).value.number, 999, "each branch reads its OWN PR");
	// reaching for the bare root must find nothing: a checkout that lapses the TTL
	// on a different branch must not be served the previous branch's PR
	assert.equal(prState.has(repo.root), false);
});

//#endregion
