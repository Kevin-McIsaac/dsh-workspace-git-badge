/**
 * PR / CI status: the `gh`-backed region.
 *
 * The contract under test is mostly about ABSENCE. A forge is an optional
 * luxury, so the interesting cases are the ones where nothing should appear and
 * nothing should break: no `gh`, a logged-out `gh`, no PR on the branch, a
 * non-GitHub remote, unparseable output, a hung call. Each of those must yield
 * the same response — no `pr` key at all — and must never cost the route
 * latency.
 *
 * No `gh`, no network and no forge: `config.prRunner` substitutes for the CLI
 * the way `config.gitRunner` already does for git.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { apply, config, gitStatus, prState, prStatusFor, readPrStatus, summarizeChecks, summarizePr } from "../lib/index.js";
import { fakeCtx, fakeReq, fakeStream, waitFor } from "../test-support/harness.mjs";
import { makeRepo } from "../test-support/repo.mjs";

const WORKSPACE_ID = "ws-pr";

/**
 * Substitute the `gh` CLI. `stdout` resolves as a successful call; otherwise the
 * requested failure shape is returned. `gate` overrides everything with a
 * promise the test controls, for the "must not block the route" case.
 */
function stubPr(t, { stdout = null, missing = false, timeout = false, gate } = {}) {
	const calls = [];
	config.prRunner = (cmd, args) => {
		calls.push({ cmd, args });
		if (gate !== void 0) return gate;
		if (missing) return Promise.resolve({ stdout: null, missing: true });
		if (timeout) return Promise.resolve({ stdout: null, timeout: true });
		if (stdout !== null) return Promise.resolve({ stdout });
		return Promise.resolve({ stdout: null, exitCode: 1 });
	};
	t.after(() => {
		config.prRunner = null;
	});
	return calls;
}

/** Every test starts from an empty cache: prState is module-level and per-process. */
function clearPr(t) {
	prState.clear();
	t.after(() => prState.clear());
}

/** A repo whose `origin` looks like GitHub, with no upstream (so no fetch). */
async function githubRepo(t) {
	const repo = await makeRepo(t);
	await repo.commit("initial");
	await repo.git(["remote", "add", "origin", "git@github.com:owner/repo.git"]);
	return repo;
}

const OPEN_PR = JSON.stringify({
	number: 142,
	state: "OPEN",
	isDraft: false,
	reviewDecision: "APPROVED",
	statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }]
});

//#region rollup reduction

test("a single failure outweighs any number of successes", () => {
	assert.equal(
		summarizeChecks([
			{ status: "COMPLETED", conclusion: "SUCCESS" },
			{ status: "COMPLETED", conclusion: "SUCCESS" },
			{ status: "COMPLETED", conclusion: "FAILURE" }
		]),
		"failing",
		"mostly passing is not expressible as one colour, so failure wins"
	);
});

test("an unfinished check makes the rollup pending, not passing", () => {
	assert.equal(
		summarizeChecks([
			{ status: "COMPLETED", conclusion: "SUCCESS" },
			{ status: "IN_PROGRESS", conclusion: "" }
		]),
		"pending"
	);
});

test("a StatusContext's own PENDING state counts as pending", () => {
	// Contexts carry `state`, not `status`/`conclusion` — both shapes share one array
	assert.equal(summarizeChecks([{ state: "SUCCESS" }, { state: "PENDING" }]), "pending");
});

test("all successful checks are passing, and an empty rollup is none", () => {
	assert.equal(summarizeChecks([{ status: "COMPLETED", conclusion: "SUCCESS" }]), "passing");
	assert.equal(summarizeChecks([]), "none");
	assert.equal(summarizeChecks([{ status: "COMPLETED", conclusion: "SKIPPED" }]), "passing", "a skip is not a failure");
});

test("failure beats a pending sibling regardless of order", () => {
	assert.equal(
		summarizeChecks([
			{ status: "IN_PROGRESS", conclusion: "" },
			{ status: "COMPLETED", conclusion: "TIMED_OUT" }
		]),
		"failing"
	);
});

//#endregion

//#region response summarization

test("a PR is summarized to number, CI state, draft and review", () => {
	assert.deepEqual(summarizePr(JSON.parse(OPEN_PR)), {
		number: 142,
		state: "passing",
		draft: false,
		review: "APPROVED",
		open: true
	});
});

test("a merged or closed PR is not open", () => {
	assert.equal(summarizePr({ number: 1, state: "MERGED" }).open, false);
	assert.equal(summarizePr({ number: 1, state: "CLOSED" }).open, false);
});

test("output with no usable number is nothing to say", () => {
	assert.equal(summarizePr(null), void 0);
	assert.equal(summarizePr("not an object"), void 0);
	assert.equal(summarizePr({ number: "142" }), void 0, "a stringified number is not a number");
	assert.equal(summarizePr({}), void 0);
});

test("an absent reviewDecision is omitted rather than reported as a value", () => {
	const pr = summarizePr({ number: 5, state: "OPEN", reviewDecision: "" });
	assert.equal("review" in pr, false);
});

//#endregion

//#region readPrStatus degradation

test("a non-GitHub remote never spawns gh at all", async (t) => {
	const repo = await makeRepo(t);
	await repo.commit("initial");
	await repo.git(["remote", "add", "origin", "git@gitlab.com:owner/repo.git"]);
	const calls = stubPr(t, { stdout: OPEN_PR });
	assert.equal(await readPrStatus(repo.root, "main"), void 0);
	assert.equal(calls.length, 0, "a local remote check must gate the forge process");
});

test("a detached HEAD is not asked about", async (t) => {
	const repo = await githubRepo(t);
	const calls = stubPr(t, { stdout: OPEN_PR });
	assert.equal(await readPrStatus(repo.root, "HEAD (detached)"), void 0);
	assert.equal(calls.length, 0);
});

test("every gh failure shape is an absent field, never an error", async (t) => {
	const repo = await githubRepo(t);
	for (const [label, shape] of [
		["gh not installed", { missing: true }],
		["timed out", { timeout: true }],
		["logged out / no PR", {}]
	]) {
		stubPr(t, shape);
		assert.equal(await readPrStatus(repo.root, "main"), void 0, `${label} must say nothing`);
	}
});

test("unparseable gh output is nothing to say, not a crash", async (t) => {
	const repo = await githubRepo(t);
	stubPr(t, { stdout: "not json at all" });
	assert.equal(await readPrStatus(repo.root, "main"), void 0);
});

test("a resolvable PR is read through the user's gh, with prompts disabled", async (t) => {
	const repo = await githubRepo(t);
	let seen = null;
	config.prRunner = (cmd, args, opts) => {
		seen = { cmd, args, opts };
		return Promise.resolve({ stdout: OPEN_PR });
	};
	t.after(() => {
		config.prRunner = null;
	});
	const pr = await readPrStatus(repo.root, "main");
	assert.equal(pr.number, 142);
	assert.equal(seen.cmd, "gh");
	assert.deepEqual(seen.args.slice(0, 2), ["pr", "view"]);
	assert.equal(seen.opts.cwd, repo.root);
	assert.equal(seen.opts.timeout, config.prTimeoutMs, "a forge call is bounded like any other");
	// an auth prompt or a pager wait would hang the refresh, and colour codes
	// would corrupt the JSON parse
	assert.equal(seen.opts.env.GH_PROMPT_DISABLED, "1");
	assert.equal(seen.opts.env.GH_PAGER, "cat");
});

//#endregion

//#region TTL cache and out-of-band refresh

test("prStatusFor serves the previous value and refreshes out of band", async (t) => {
	clearPr(t);
	const repo = await githubRepo(t);
	let calls = 0;
	config.prRunner = () => {
		calls += 1;
		return Promise.resolve({ stdout: OPEN_PR });
	};
	t.after(() => {
		config.prRunner = null;
	});
	const notifications = [];
	// first call: nothing cached, so nothing is served — the caller is not made to
	// wait for the forge even to SPAWN the refresh (the remote check is async)
	assert.equal(prStatusFor(repo.root, "main", (key) => notifications.push(key)), void 0);
	await waitFor(() => calls >= 1);
	assert.equal(calls, 1, "the refresh must be spawned out of band");
	// let the refresh land, then the SAME call serves it from cache
	const served = await waitFor(() => prStatusFor(repo.root, "main", () => {}));
	assert.equal(served?.number, 142);
	assert.equal(calls, 1, "a fresh cache entry must not spawn a second call");
	assert.deepEqual(notifications, [repo.root], "a first answer is a change from nothing");
});

test("an unchanged refresh notifies nobody", async (t) => {
	clearPr(t);
	const repo = await githubRepo(t);
	stubPr(t, { stdout: OPEN_PR });
	prStatusFor(repo.root, "main", () => {});
	await waitFor(() => prStatusFor(repo.root, "main", () => {}) !== void 0);
	const notifications = [];
	// force the TTL to lapse without waiting 90s
	prState.get(repo.root).lastAttemptAt = 0;
	prStatusFor(repo.root, "main", (key) => notifications.push(key));
	await waitFor(() => prState.get(repo.root).inFlight === null);
	assert.deepEqual(notifications, [], "an unchanged answer must not push SSE traffic");
});

test("a changed refresh notifies subscribers", async (t) => {
	clearPr(t);
	const repo = await githubRepo(t);
	let stdout = OPEN_PR;
	config.prRunner = () => Promise.resolve({ stdout });
	t.after(() => {
		config.prRunner = null;
	});
	prStatusFor(repo.root, "main", () => {});
	await waitFor(() => prState.get(repo.root).value !== void 0);
	stdout = JSON.stringify({ number: 142, state: "OPEN", statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }] });
	prState.get(repo.root).lastAttemptAt = 0;
	const notifications = [];
	prStatusFor(repo.root, "main", (key) => notifications.push(key));
	await waitFor(() => prState.get(repo.root).value?.state === "failing");
	assert.deepEqual(notifications, [repo.root], "a CI state change must reach the chip");
});

test("concurrent requests share one forge call", async (t) => {
	clearPr(t);
	const repo = await githubRepo(t);
	let calls = 0;
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	config.prRunner = () => {
		calls += 1;
		return gate;
	};
	t.after(() => {
		config.prRunner = null;
	});
	prStatusFor(repo.root, "main", () => {});
	prStatusFor(repo.root, "main", () => {});
	prStatusFor(repo.root, "main", () => {});
	await waitFor(() => calls >= 1);
	assert.equal(calls, 1, "a burst of badge refreshes must not stampede the forge");
	release({ stdout: OPEN_PR });
	await waitFor(() => prState.get(repo.root).value !== void 0);
	assert.equal(calls, 1);
});

test('prStatus "off" never invokes gh', async (t) => {
	clearPr(t);
	const repo = await githubRepo(t);
	const calls = stubPr(t, { stdout: OPEN_PR });
	config.prStatus = "off";
	t.after(() => {
		config.prStatus = "auto";
	});
	assert.equal(prStatusFor(repo.root, "main", () => {}), void 0);
	assert.equal(calls.length, 0);
});

//#endregion

//#region wiring: gitStatus, the route, and who pays for the forge

test("gitStatus attaches pr only when asked", async (t) => {
	clearPr(t);
	const repo = await githubRepo(t);
	const calls = stubPr(t, { stdout: OPEN_PR });
	const without = await gitStatus(repo.root);
	assert.equal("pr" in without, false, "a sidebar row refresh must not pay for a forge call");
	assert.equal(calls.length, 0);
	await gitStatus(repo.root, false, true);
	await waitFor(() => calls.length >= 1);
	assert.equal(calls.length, 1, "pr=1 is what asks for it");
});

test("the route refuses to wait for the forge", async (t) => {
	clearPr(t);
	const repo = await githubRepo(t);
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	stubPr(t, { gate });
	const { ctx, routes, disposeAll } = fakeCtx({ workspaces: [{ id: WORKSPACE_ID, path: repo.root }] });
	apply(ctx);
	t.after(() => disposeAll());
	const res = fakeStream();
	// the gh call never answers; the route must still answer
	await routes.get("/api/git-badge").handler(fakeReq({ url: `/api/git-badge?workspace=${WORKSPACE_ID}&pr=1` }), res);
	assert.equal(res.status, 200);
	const body = JSON.parse(res.text());
	assert.equal(body.git, true);
	assert.equal("pr" in body, false, "the first request has nothing cached and must not block to get it");
	release({ stdout: OPEN_PR });
	await waitFor(() => prState.get(repo.root)?.value !== void 0);
});

test("the route serves a cached PR, and a row request never spawns gh", async (t) => {
	clearPr(t);
	const repo = await githubRepo(t);
	const calls = stubPr(t, { stdout: OPEN_PR });
	const { ctx, routes, disposeAll } = fakeCtx({ workspaces: [{ id: WORKSPACE_ID, path: repo.root }] });
	apply(ctx);
	t.after(() => disposeAll());
	const get = (query) => {
		const res = fakeStream();
		return routes
			.get("/api/git-badge")
			.handler(fakeReq({ url: `/api/git-badge${query}` }), res)
			.then(() => res);
	};
	// a row request (no pr=1) must not touch the forge
	await get(`?workspace=${WORKSPACE_ID}`);
	assert.equal(calls.length, 0);
	// a chip request spawns the refresh; the NEXT one serves the cached value
	await get(`?workspace=${WORKSPACE_ID}&pr=1`);
	await waitFor(() => prState.get(repo.root)?.value !== void 0);
	const res = await get(`?workspace=${WORKSPACE_ID}&pr=1`);
	const body = JSON.parse(res.text());
	assert.equal(body.pr.number, 142);
	assert.equal(body.pr.state, "passing");
});

//#endregion
