/**
 * Session working-directory status.
 *
 * DSH records each Session's current directory: the `working_directory` tool and
 * the experimental worktree tool commit `working-directory/change`, and the
 * `workingDirectory` projection carries the result. That projection is the ONLY
 * source for "which checkout is this session in", so there is no registration
 * file, no TTL, and no worktree guess. These tests pin the cases that must NOT
 * swap: no projection, the same checkout, a subdirectory, a non-repository, and
 * workspace-targeted rows.
 *
 * No `gh`, no network: `config.prRunner` substitutes for the CLI, exactly as in
 * pr.test.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	apply,
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
import { changeEvents, fakeCtx, get, openSse, spyOn, waitFor } from "../test-support/harness.mjs";
import { githubRepo } from "../test-support/repo.mjs";

const WORKSPACE_ID = "ws-tree";
const SESSION_ID = "sess-tree";

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

/** Registered-workspace repo plus a mutable working-directory projection. */
async function setup(t, { cwd, repo: existing, sessionProjections } = {}) {
	const repo = existing ?? (await githubRepo(t));
	const state = { cwd: typeof cwd === "function" ? cwd(repo) : cwd };
	const { ctx, routes, entities, emitProjection, disposeAll } = fakeCtx({
		workspaces: [{ id: WORKSPACE_ID, path: repo.root, sessionIds: [SESSION_ID] }],
		sessionCwd: () => state.cwd,
		...(sessionProjections === void 0 ? {} : { sessionProjections })
	});
	apply(ctx);
	t.after(() => disposeAll());
	return { repo, routes, entities, ctx, state, emitProjection };
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
	// effectiveTarget uses to decide a session entered another checkout
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

//#region effectiveTarget (session working directory)

test("a session badge follows its working directory", async (t) => {
	clearState(t);
	const repo = await githubRepo(t);
	const tree = await repo.worktreeAdd({ name: "linked-tree", branch: "feat/tree" });
	const { ctx, entities } = await setup(t, { cwd: tree, repo });
	const effective = await effectiveTarget(ctx, entities[0], SESSION_ID);
	assert.equal(effective.path, tree);
	assert.equal(effective.followed, true);
	// the follow needs its own watcher: a worktree is usually not a registered workspace
	assert.ok(watchers.has(await realpath(tree)), "a followed checkout must be watched");
});

test("a workingDirectory change wakes the owning workspace's clients", async (t) => {
	// A `create_worktree` or `working_directory` call commits a session event,
	// not a file edit. The git watcher cannot see it, so the node half forwards it
	// as the same SSE frame a file edit sends. Without this the chip keeps the old
	// checkout until the 60-second fallback poll.
	clearState(t);
	const repo = await githubRepo(t);
	const tree = await repo.worktreeAdd({ name: "linked-tree", branch: "feat/tree" });
	const { routes, emitProjection } = await setup(t, { cwd: tree, repo });
	const stream = await openSse(routes);
	t.after(() => stream.abort());
	await waitFor(() => stream.text().includes(": connected"));
	emitProjection({ id: SESSION_ID }, "workingDirectory", tree);
	const events = await waitFor(() => (changeEvents(stream).length > 0 ? changeEvents(stream) : void 0));
	assert.ok(events !== void 0, "the workingDirectory change must wake the client");
	assert.ok(
		events.some((event) => event.workspace === WORKSPACE_ID),
		`the frame must carry the owning workspace id: ${JSON.stringify(events)}`
	);
});

test("an unrelated projection change stays silent", async (t) => {
	clearState(t);
	const repo = await githubRepo(t);
	const { routes, emitProjection } = await setup(t, { cwd: repo.root, repo });
	const stream = await openSse(routes);
	t.after(() => stream.abort());
	await waitFor(() => stream.text().includes(": connected"));
	emitProjection({ id: SESSION_ID }, "todos", []);
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.deepEqual(changeEvents(stream), []);
});

test("a host without the projection feed still serves the badge", async (t) => {
	// The projection service is optional. A host that composes none keeps the
	// status route and the fallback poll, and apply() must not throw.
	clearState(t);
	const repo = await githubRepo(t);
	const { routes } = await setup(t, { cwd: repo.root, repo, sessionProjections: false });
	const response = await get(routes, `?session=${SESSION_ID}`);
	assert.equal(response.status, 200);
	assert.equal(JSON.parse(response.text()).git, true);
});

test("without a working-directory projection the badge stays on the workspace", async (t) => {
	clearState(t);
	const repo = await githubRepo(t);
	const tree = await repo.worktreeAdd({ name: "linked-tree", branch: "feat/tree" });
	const { ctx, entities } = await setup(t, { cwd: void 0, repo });
	const effective = await effectiveTarget(ctx, entities[0], SESSION_ID);
	assert.equal(effective.path, repo.root, "no projection, no follow");
	assert.equal(effective.followed, false);
	assert.equal(watchers.has(await realpath(tree)), false);
});

test("a workspace-targeted request never follows a session", async (t) => {
	clearState(t);
	const repo = await githubRepo(t);
	const tree = await repo.worktreeAdd({ name: "linked-tree", branch: "feat/tree" });
	const { ctx, entities } = await setup(t, { cwd: tree, repo });
	const effective = await effectiveTarget(ctx, entities[0], void 0);
	assert.equal(effective.path, repo.root, "a row surveys the checkout the registry owns");
	assert.equal(effective.followed, false);
});

test("a projection that names the workspace checkout is not a follow", async (t) => {
	clearState(t);
	const repo = await githubRepo(t);
	await repo.worktreeAdd({ name: "linked-tree", branch: "feat/tree" });
	const { ctx, entities } = await setup(t, { cwd: repo.root, repo });
	const effective = await effectiveTarget(ctx, entities[0], SESSION_ID);
	assert.equal(effective.path, repo.root);
	assert.equal(effective.followed, false);
});

test("a subdirectory of the same checkout is not a follow", async (t) => {
	clearState(t);
	const repo = await githubRepo(t);
	await repo.worktreeAdd({ name: "linked-tree", branch: "feat/tree" });
	const nested = join(repo.root, "packages", "app");
	mkdirSync(nested, { recursive: true });
	const { ctx, entities } = await setup(t, { cwd: nested, repo });
	const effective = await effectiveTarget(ctx, entities[0], SESSION_ID);
	assert.equal(effective.path, repo.root, "the checkout is the repository, not the subdirectory");
	assert.equal(effective.followed, false);
});

test("a working directory outside a repository is ignored", async (t) => {
	clearState(t);
	const repo = await githubRepo(t);
	const outside = mkdtempSync(join(tmpdir(), "dsh-git-badge-outside-"));
	const { ctx, entities } = await setup(t, { cwd: outside, repo });
	const effective = await effectiveTarget(ctx, entities[0], SESSION_ID);
	assert.equal(effective.path, repo.root, "no git toplevel means no substitute checkout");
	assert.equal(effective.followed, false);
});

test('worktreeStatus "off" restores the plain checkout', async (t) => {
	clearState(t);
	const repo = await githubRepo(t);
	const tree = await repo.worktreeAdd({ name: "linked-tree", branch: "feat/tree" });
	const { ctx, entities } = await setup(t, { cwd: tree, repo });
	const previous = config.worktreeStatus;
	config.worktreeStatus = "off";
	t.after(() => {
		config.worktreeStatus = previous;
	});
	const effective = await effectiveTarget(ctx, entities[0], SESSION_ID);
	assert.equal(effective.path, repo.root);
	assert.equal(effective.followed, false);
	assert.equal(watchers.has(await realpath(tree)), false);
});

test("the followed status describes the working directory", async (t) => {
	clearState(t);
	const repo = await githubRepo(t);
	const tree = await repo.worktreeAdd({ name: "linked-tree", branch: "feat/tree" });
	const { ctx, entities } = await setup(t, { cwd: tree, repo });
	const effective = await effectiveTarget(ctx, entities[0], SESSION_ID);
	const info = await gitStatus(effective.path);
	assert.equal(info.git, true);
	assert.equal(info.branch, "feat/tree");
	assert.equal(info.isWorktree, true);
	assert.equal(info.worktreeName, "linked-tree");
});

test("moving back to the workspace retires the follow", async (t) => {
	clearState(t);
	const repo = await githubRepo(t);
	const tree = await repo.worktreeAdd({ name: "linked-tree", branch: "feat/tree" });
	const { ctx, entities, state } = await setup(t, { cwd: tree, repo });
	assert.equal((await effectiveTarget(ctx, entities[0], SESSION_ID)).followed, true);
	assert.ok(watchers.has(await realpath(tree)));
	state.cwd = repo.root;
	const effective = await effectiveTarget(ctx, entities[0], SESSION_ID);
	assert.equal(effective.path, repo.root);
	assert.equal(effective.followed, false);
	assert.equal(watchers.has(await realpath(tree)), false);
	assert.equal(selectedWorktrees.size, 0);
});

//#endregion
//#region watchers for a followed checkout

test("the followed checkout is watched, and its events name the owning workspace", async (t) => {
	clearState(t);
	const repo = await githubRepo(t);
	const tree = await repo.worktreeAdd({ name: "linked-tree", branch: "feat/tree" });
	const { ctx, entities } = await setup(t, { cwd: tree, repo });
	await effectiveTarget(ctx, entities[0], SESSION_ID);
	const record = watchers.get(await realpath(tree));
	assert.ok(record, "a followed checkout needs its own watcher: it is usually not a registered workspace");
	assert.equal(
		record.workspaceId,
		WORKSPACE_ID,
		"its events must carry the workspace id the chip matched, or the client cannot attribute them"
	);
	// a real edit there reaches subscribers with that attribution
	const seen = spyOn(t);
	writeFileSync(join(tree, "edit.txt"), "edit\n");
	const hit = await waitFor(() => seen.length > 0);
	assert.ok(hit, "expected the checkout watch to fire");
	assert.equal(seen[0].workspace, WORKSPACE_ID);
});

test("two sessions in one checkout share its watcher", async (t) => {
	clearState(t);
	const repo = await githubRepo(t);
	const tree = await repo.worktreeAdd({ name: "linked-tree", branch: "feat/tree" });
	const second = "sess-tree-2";
	const cwd = { [SESSION_ID]: tree, [second]: tree };
	const { ctx, entities, disposeAll } = fakeCtx({
		workspaces: [{ id: WORKSPACE_ID, path: repo.root, sessionIds: [SESSION_ID, second] }],
		sessionCwd: (sessionId) => cwd[sessionId]
	});
	apply(ctx);
	t.after(() => disposeAll());
	await effectiveTarget(ctx, entities[0], SESSION_ID);
	await effectiveTarget(ctx, entities[0], second);
	assert.ok(watchers.has(await realpath(tree)));
	// the first session moves back: the second still needs the watcher
	cwd[SESSION_ID] = repo.root;
	await effectiveTarget(ctx, entities[0], SESSION_ID);
	assert.ok(watchers.has(await realpath(tree)), "a shared checkout must survive one follower leaving");
	// and the last follower leaving retires it
	cwd[second] = repo.root;
	await effectiveTarget(ctx, entities[0], second);
	assert.equal(watchers.has(await realpath(tree)), false);
});

test("syncWatchers keeps a live follow and retires an unregistered owner", async (t) => {
	clearState(t);
	const repo = await githubRepo(t);
	const tree = await repo.worktreeAdd({ name: "linked-tree", branch: "feat/tree" });
	const { ctx, entities } = await setup(t, { cwd: tree, repo });
	await effectiveTarget(ctx, entities[0], SESSION_ID);
	assert.ok(watchers.has(await realpath(tree)));
	// a reconcile is what an SSE connect runs: it must not tear the follow down
	syncWatchers(ctx);
	assert.ok(watchers.has(await realpath(tree)), "syncWatchers must keep a live follow");
	// with the workspace gone, the reconcile retires both the owner and its follow
	const empty = { workspaceRegistry: { list: () => [] } };
	syncWatchers(empty);
	assert.equal(watchers.has(await realpath(tree)), false);
	assert.equal(selectedWorktrees.size, 0);
});

//#endregion
//#region route + caches

test("the route follows a session's working directory and says so", async (t) => {
	clearState(t);
	const treeRepo = await githubRepo(t);
	const tree = await treeRepo.worktreeAdd({ name: "linked-tree", branch: "feat/tree" });
	const { routes, state } = await setup(t, { cwd: tree, repo: treeRepo });
	state.cwd = tree;
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
	const treeRepo = await githubRepo(t);
	const tree = await treeRepo.worktreeAdd({ name: "linked-tree", branch: "feat/tree" });
	const { routes } = await setup(t, { cwd: tree, repo: treeRepo });
	const body = JSON.parse((await get(routes, `?workspace=${WORKSPACE_ID}&pr=1`)).text());
	assert.equal(body.branch, "main");
	assert.equal(body.worktreeFollowed, void 0);
});

test("the hover card's own-checkout row is served only with detail=1", async (t) => {
	clearState(t);
	const treeRepo = await githubRepo(t);
	const tree = await treeRepo.worktreeAdd({ name: "linked-tree", branch: "feat/tree" });
	const { routes } = await setup(t, { cwd: tree, repo: treeRepo });
	writeFileSync(join(treeRepo.root, "dirty.txt"), "dirty\n");
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

test("a session not following a worktree is told how many it is NOT following", async (t) => {
	// The card can name the gap: the repository has linked worktrees and the
	// session is still in the main checkout. detail=1 pays for the extra list.
	clearState(t);
	const repo = await githubRepo(t);
	await repo.worktreeAdd({ name: "linked-tree", branch: "feat/tree" });
	const { routes } = await setup(t, { cwd: repo.root, repo });
	const detailed = JSON.parse((await get(routes, `?session=${SESSION_ID}&detail=1`)).text());
	assert.equal(detailed.worktreeFollowed, void 0, "nothing is followed");
	assert.equal(detailed.linkedWorktrees, 1, "the card can name what is not being followed");

	// detail-gated: a plain sample must not pay the extra `git worktree list`
	const plain = JSON.parse((await get(routes, `?session=${SESSION_ID}`)).text());
	assert.equal("linkedWorktrees" in plain, false, "nothing at rest pays for it");

	// and a WORKSPACE-targeted request is about the registry's checkout, not a
	// session — it has no working directory to be missing
	const workspace = JSON.parse((await get(routes, `?workspace=${WORKSPACE_ID}&detail=1`)).text());
	assert.equal("linkedWorktrees" in workspace, false);
});

test("a FOLLOWED checkout reports no unregistered count", async (t) => {
	clearState(t);
	const treeRepo = await githubRepo(t);
	const tree = await treeRepo.worktreeAdd({ name: "linked-tree", branch: "feat/tree" });
	const { routes } = await setup(t, { cwd: tree, repo: treeRepo });
	const detailed = JSON.parse((await get(routes, `?session=${SESSION_ID}&detail=1`)).text());
	assert.equal(detailed.worktreeFollowed, true);
	assert.equal("linkedWorktrees" in detailed, false, "a followed tree is not 'not following'");
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
