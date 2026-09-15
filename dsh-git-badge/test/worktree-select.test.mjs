/**
 * Worktree-aware status, registration-only.
 *
 * The contract has one hard edge. The plugin CANNOT know which worktree a session
 * uses — DSH records no session→worktree link and session cwd is immutable
 * creation metadata — so the ONLY way a session badge follows a linked worktree
 * is an explicit registration (`dsh-git-badge-checkout <path>`, written by the
 * agent). There is no inference from pull requests: the badge never guesses.
 *
 * The registration is advisory, so most of these tests are about the cases that
 * must NOT swap: stale entries, paths that are not worktrees, workspace-targeted
 * rows, and sessions already inside a worktree of their own.
 *
 * No `gh`, no network: `config.prRunner` substitutes for the CLI, exactly as in
 * pr.test.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	apply,
	changeListeners,
	config,
	effectiveTarget,
	gitStatus,
	parseWorktreeList,
	prState,
	prStatusFor,
	readWorktrees,
	runGit,
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
		selectedWorktrees.clear();
		statusInFlight.clear();
		for (const key of [...watchers.keys()]) unwatchWorkspace(key);
	};
	reset();
	t.after(reset);
}

/**
 * Register a checkout for a session the way the agent does — through the
 * store's file, pointed at a per-test temp path by the config seam (no env
 * mutation, so the suite stays order-independent).
 */
function register(t, sessionId, path, { at = new Date().toISOString(), sessions } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "dsh-git-badge-checkout-"));
	const file = join(dir, "session-checkouts.json");
	const body = sessions ?? { [sessionId]: { path, at } };
	writeFileSync(file, JSON.stringify({ schema: "dsh-git-badge/session-checkout/v1", sessions: body }));
	const previous = config.sessionCheckoutsFile;
	config.sessionCheckoutsFile = file;
	t.after(() => {
		config.sessionCheckoutsFile = previous;
	});
	return file;
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

//#region effectiveTarget (registration only)

test("a session badge follows its registered worktree", async (t) => {
	clearState(t);
	const repo = await githubRepo(t);
	const tree = await repo.worktreeAdd({ name: "linked-tree", branch: "feat/tree" });
	register(t, SESSION_ID, tree);
	const effective = await effectiveTarget({ id: WORKSPACE_ID, path: repo.root }, SESSION_ID);
	assert.equal(effective.path, await realpath(tree));
	assert.deepEqual(effective.worktree, { name: "linked-tree", branch: "feat/tree" });
	// the follow needs its own watcher: a worktree is usually not a registered workspace
	assert.ok(watchers.has(await realpath(tree)), "a followed worktree must be watched");
});

test("without a registration the badge stays on the session's own checkout", async (t) => {
	clearState(t);
	const repo = await githubRepo(t);
	const tree = await repo.worktreeAdd({ name: "linked-tree", branch: "feat/tree" });
	const effective = await effectiveTarget({ id: WORKSPACE_ID, path: repo.root }, SESSION_ID);
	assert.equal(effective.path, repo.root, "no registration, no follow");
	assert.equal(watchers.has(await realpath(tree)), false);
});

test("a workspace-targeted request never follows a worktree", async (t) => {
	clearState(t);
	const repo = await githubRepo(t);
	const tree = await repo.worktreeAdd({ name: "linked-tree", branch: "feat/tree" });
	register(t, SESSION_ID, tree);
	const effective = await effectiveTarget({ id: WORKSPACE_ID, path: repo.root }, void 0);
	assert.equal(effective.path, repo.root, "a row surveys the checkout the registry owns");
	assert.equal(effective.worktree, void 0);
});

test("a stale registration is ignored", async (t) => {
	clearState(t);
	const repo = await githubRepo(t);
	const tree = await repo.worktreeAdd({ name: "linked-tree", branch: "feat/tree" });
	register(t, SESSION_ID, tree, { at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() });
	const effective = await effectiveTarget({ id: WORKSPACE_ID, path: repo.root }, SESSION_ID);
	assert.equal(effective.path, repo.root, "older than the 24h TTL");
});

test("a registration that names a non-worktree is ignored", async (t) => {
	clearState(t);
	const repo = await githubRepo(t);
	await repo.worktreeAdd({ name: "linked-tree", branch: "feat/tree" });
	register(t, SESSION_ID, join(repo.root, "not-a-worktree"));
	const effective = await effectiveTarget({ id: WORKSPACE_ID, path: repo.root }, SESSION_ID);
	assert.equal(effective.path, repo.root, "git's worktree list is the authority, not the file");
});

test('worktreeStatus "off" restores the plain checkout', async (t) => {
	clearState(t);
	const repo = await githubRepo(t);
	const tree = await repo.worktreeAdd({ name: "linked-tree", branch: "feat/tree" });
	register(t, SESSION_ID, tree);
	const previous = config.worktreeStatus;
	config.worktreeStatus = "off";
	t.after(() => {
		config.worktreeStatus = previous;
	});
	const effective = await effectiveTarget({ id: WORKSPACE_ID, path: repo.root }, SESSION_ID);
	assert.equal(effective.path, repo.root);
	assert.equal(watchers.has(await realpath(tree)), false);
});

test("a session already inside a linked worktree is never swapped sideways", async (t) => {
	clearState(t);
	const repo = await githubRepo(t);
	const mine = await repo.worktreeAdd({ name: "mine", branch: "feat/mine" });
	const other = await repo.worktreeAdd({ name: "other", branch: "feat/other" });
	register(t, SESSION_ID, other);
	const effective = await effectiveTarget({ id: WORKSPACE_ID, path: mine }, SESSION_ID);
	assert.equal(effective.path, mine, "the session's own directory IS the answer");
});

test("the swapped status describes the worktree, not the session's own checkout", async (t) => {
	clearState(t);
	const repo = await githubRepo(t);
	const tree = await repo.worktreeAdd({ name: "linked-tree", branch: "feat/tree" });
	register(t, SESSION_ID, tree);
	const effective = await effectiveTarget({ id: WORKSPACE_ID, path: repo.root }, SESSION_ID);
	const info = await gitStatus(effective.path);
	assert.equal(info.git, true);
	assert.equal(info.branch, "feat/tree");
	assert.equal(info.isWorktree, true);
	assert.equal(info.worktreeName, "linked-tree");
});

//#endregion
//#region watchers for a followed worktree

test("the registered worktree is watched, and its events name the owning workspace", async (t) => {
	clearState(t);
	const { repo, entities } = await setup(t);
	const tree = await repo.worktreeAdd({ name: "linked-tree", branch: "feat/tree" });
	register(t, SESSION_ID, tree);
	await effectiveTarget(entities[0], SESSION_ID);
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

test("syncWatchers keeps a registered follow and retires an unregistered owner", async (t) => {
	clearState(t);
	const { repo, entities, routes } = await setup(t);
	const tree = await repo.worktreeAdd({ name: "linked-tree", branch: "feat/tree" });
	register(t, SESSION_ID, tree);
	await effectiveTarget(entities[0], SESSION_ID);
	assert.ok(watchers.has(await realpath(tree)));
	// a reconcile is what an SSE connect runs: it must not tear the follow down
	syncWatchers({ workspaceRegistry: { list: () => entities } });
	assert.ok(watchers.has(await realpath(tree)), "syncWatchers must keep a live follow");
	// with the workspace gone, the reconcile retires both the owner and its follow
	syncWatchers({ workspaceRegistry: { list: () => [] } });
	assert.equal(watchers.has(await realpath(tree)), false);
	assert.equal(selectedWorktrees.size, 0);
	assert.ok(routes.has("/api/git-badge"));
});

test("a follow is retired when the registration is cleared", async (t) => {
	clearState(t);
	const { repo, entities } = await setup(t);
	const tree = await repo.worktreeAdd({ name: "linked-tree", branch: "feat/tree" });
	const file = register(t, SESSION_ID, tree);
	assert.equal((await effectiveTarget(entities[0], SESSION_ID)).path, await realpath(tree));
	assert.ok(watchers.has(await realpath(tree)));
	// the agent clears it (worktree removed, session moved back): the extra
	// watcher must go with the follow
	writeFileSync(file, JSON.stringify({ schema: "dsh-git-badge/session-checkout/v1", sessions: {} }));
	const effective = await effectiveTarget(entities[0], SESSION_ID);
	assert.equal(effective.path, repo.root);
	assert.equal(watchers.has(await realpath(tree)), false);
	assert.equal(selectedWorktrees.size, 0);
});

//#endregion
//#region route + caches

test("the route swaps a session target onto the registered worktree and says so", async (t) => {
	clearState(t);
	const { repo, routes } = await setup(t);
	const tree = await repo.worktreeAdd({ name: "linked-tree", branch: "feat/tree" });
	register(t, SESSION_ID, tree);
	stubForge(t, { list: openPrBody("feat/tree") });
	// the PR read is TTL-bounded and out of band: the first request spawns it and
	// answers without, the second carries it — exactly what the chip sees
	await get(routes, `?session=${SESSION_ID}&pr=1`);
	await waitFor(async () => (await prStatusFor(await realpath(tree), "feat/tree", () => {})) !== void 0);
	const body = JSON.parse((await get(routes, `?session=${SESSION_ID}&pr=1`)).text());
	assert.equal(body.branch, "feat/tree");
	assert.equal(body.isWorktree, true);
	assert.equal(body.worktreeName, "linked-tree");
	assert.equal(body.worktreeFollowed, true);
	assert.equal(body.pr.number, 391);
	// the workspace id is still echoed for SSE attribution
	assert.equal(body.workspace, WORKSPACE_ID);
});

test("the route leaves a workspace target on its own checkout", async (t) => {
	clearState(t);
	const { repo, routes } = await setup(t);
	const tree = await repo.worktreeAdd({ name: "linked-tree", branch: "feat/tree" });
	register(t, SESSION_ID, tree);
	stubForge(t, { list: openPrBody("feat/tree") });
	const body = JSON.parse((await get(routes, `?workspace=${WORKSPACE_ID}&pr=1`)).text());
	assert.equal(body.branch, "main");
	assert.equal(body.worktreeFollowed, void 0);
	assert.equal("pr" in body, false, "a row never gets the worktree's PR either");
});

test("the hover card's checkout row is served only with detail=1", async (t) => {
	clearState(t);
	const { repo, routes } = await setup(t);
	const tree = await repo.worktreeAdd({ name: "linked-tree", branch: "feat/tree" });
	register(t, SESSION_ID, tree);
	writeFileSync(join(repo.root, "dirty.txt"), "dirty\n");
	// the chip's own request (pr only) carries no checkout: the card's extras are
	// lazy, and this is one of them
	const plain = JSON.parse((await get(routes, `?session=${SESSION_ID}&pr=1`)).text());
	assert.equal("checkout" in plain, false);
	const detailed = JSON.parse((await get(routes, `?session=${SESSION_ID}&pr=1&detail=1`)).text());
	assert.equal(detailed.worktreeFollowed, true);
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
