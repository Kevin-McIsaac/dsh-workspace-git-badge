/**
 * Route-level tests: the workspace allowlist, the response contract, and the
 * registration wiring, driven through a fake cordis ctx instead of a live
 * server.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { apply } from "../lib/index.js";
import { fakeCtx, fakeReq, fakeStream } from "../test-support/harness.mjs";
import { makeRepo, makeSymlink } from "../test-support/repo.mjs";

/** Registered-workspace repo plus the captured routes. */
async function setup(t, { register = [] } = {}) {
	const repo = await makeRepo(t);
	await repo.commit("initial");
	const workspaces = register.length > 0 ? register : [await realpath(repo.root)];
	const { ctx, routes, disposeAll } = fakeCtx({ workspaces });
	apply(ctx);
	t.after(() => disposeAll());
	return { repo, routes };
}

async function get(routes, query) {
	const req = fakeReq({ url: `/api/git-badge${query}` });
	const res = fakeStream();
	await routes.get("/api/git-badge").handler(req, res);
	return res;
}

test("both routes are registered", async (t) => {
	const { routes } = await setup(t);
	assert.ok(routes.has("/api/git-badge"));
	assert.ok(routes.has("/api/git-badge/events"));
});

test("a missing path is a 400, not a crash", async (t) => {
	const { routes } = await setup(t);
	const res = await get(routes, "");
	assert.equal(res.status, 400);
	assert.equal(JSON.parse(res.text()).git, false);
});

test("a path outside the workspace registry is refused with 403", async (t) => {
	const { routes } = await setup(t);
	const res = await get(routes, "?path=%2Ftmp");
	assert.equal(res.status, 403);
	assert.deepEqual(JSON.parse(res.text()), {
		git: false,
		error: "path is not a registered workspace"
	});
});

test("a registered workspace returns 200 with the full status contract", async (t) => {
	const { repo, routes } = await setup(t);
	const res = await get(routes, `?path=${encodeURIComponent(repo.root)}`);
	assert.equal(res.status, 200);
	const body = JSON.parse(res.text());
	assert.equal(body.git, true);
	assert.equal(body.branch, "main");
	assert.equal(body.dirty, false);
	// fields the client's surfaces depend on
	assert.equal(body.operation, null);
	assert.equal(body.untrackedMode, "all");
	assert.equal(body.untrackedFiles, 0);
	// no upstream configured → upstream/ahead/behind are omitted entirely, and
	// that absence is load-bearing: the chip reads it as "no upstream, hide the
	// arrows" rather than as a zero
	assert.equal("upstream" in body, false);
	assert.equal("ahead" in body, false);
});

test("a symlink that resolves to a registered workspace is accepted", async (t) => {
	const { repo, routes } = await setup(t);
	const link = await makeSymlink(t, repo.root);
	const res = await get(routes, `?path=${encodeURIComponent(link)}`);
	assert.equal(res.status, 200);
	assert.equal(JSON.parse(res.text()).git, true);
});

test("detail=1 is honoured at the route level", async (t) => {
	const { repo, routes } = await setup(t);
	const res = await get(routes, `?path=${encodeURIComponent(repo.root)}&detail=1`);
	const body = JSON.parse(res.text());
	assert.ok(Array.isArray(body.lastCommits));
	assert.equal(body.lastCommits[0].subject, "initial");
});

test("a non-registered path that does not exist is still a 403", async (t) => {
	const { routes } = await setup(t);
	const res = await get(routes, "?path=%2Fdefinitely%2Fnot%2Fhere");
	assert.equal(res.status, 403);
});
