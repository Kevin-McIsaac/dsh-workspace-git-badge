/**
 * Route-level tests: request → workspace resolution, the response contract, and
 * the registration wiring, driven through a fake cordis ctx instead of a live
 * server.
 *
 * The trust model under test: the caller names a workspace id or a session id,
 * and the server resolves the directory. No client-supplied path is accepted —
 * `?path=` is gone, and one test exists purely to keep it gone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { apply } from "../lib/index.js";
import { fakeCtx, fakeReq, fakeStream } from "../test-support/harness.mjs";
import { makeRepo } from "../test-support/repo.mjs";

const WORKSPACE_ID = "ws-alpha";
const ATTACHED_SESSION = "sess-attached";

/** Registered-workspace repo plus the captured routes. */
async function setup(t, { register, sessions = {}, resolveByPath = true } = {}) {
	const repo = await makeRepo(t);
	await repo.commit("initial");
	const workspaces = register ?? [
		{ id: WORKSPACE_ID, path: repo.root, sessionIds: [ATTACHED_SESSION] }
	];
	// `sessions` may be a factory so a test can key a live session off the repo
	// path it only receives after the repo exists
	const liveSessions = typeof sessions === "function" ? sessions(repo) : sessions;
	const { ctx, routes, entities, disposeAll } = fakeCtx({ workspaces, sessions: liveSessions, resolveByPath });
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

test("both routes are registered", async (t) => {
	const { routes } = await setup(t);
	assert.ok(routes.has("/api/git-badge"));
	assert.ok(routes.has("/api/git-badge/events"));
});

test("no target at all is a 400 with a stable code", async (t) => {
	const { routes } = await setup(t);
	const res = await get(routes, "");
	assert.equal(res.status, 400);
	const body = JSON.parse(res.text());
	assert.equal(body.git, false);
	assert.equal(body.error.code, "target-required");
});

test("REGRESSION: a path, even a registered one, is no longer accepted", async (t) => {
	const { repo, routes } = await setup(t);
	const res = await get(routes, `?path=${encodeURIComponent(repo.root)}`);
	// the registered path must NOT resolve — the whole point of the change
	assert.equal(res.status, 400);
	assert.equal(JSON.parse(res.text()).error.code, "target-required");
});

test("an unknown workspace id is a 404", async (t) => {
	const { routes } = await setup(t);
	const res = await get(routes, "?workspace=nope");
	assert.equal(res.status, 404);
	assert.equal(JSON.parse(res.text()).error.code, "workspace-not-found");
});

test("a known workspace id returns 200 with the full status contract", async (t) => {
	const { routes } = await setup(t);
	const res = await get(routes, `?workspace=${WORKSPACE_ID}`);
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

test("a session listed in the registry resolves, including a non-live one", async (t) => {
	// no `sessions` entry at all: membership alone must carry it, which is what
	// makes an old conversation still render a badge
	const { routes } = await setup(t);
	const res = await get(routes, `?session=${ATTACHED_SESSION}`);
	assert.equal(res.status, 200);
	assert.equal(JSON.parse(res.text()).git, true);
});

test("an unknown session id is a 404", async (t) => {
	const { routes } = await setup(t);
	const res = await get(routes, "?session=sess-unknown");
	assert.equal(res.status, 404);
	assert.equal(JSON.parse(res.text()).error.code, "session-not-found");
});

test("a brand-new session resolves through its live cwd, validated by the registry", async (t) => {
	const { routes } = await setup(t, {
		sessions: (repo) => ({ "sess-new": { header: { cwd: repo.root } } })
	});
	const res = await get(routes, "?session=sess-new");
	assert.equal(res.status, 200);
	assert.equal(JSON.parse(res.text()).git, true);
});

test("a live session whose cwd is not a registered workspace is refused", async (t) => {
	const { routes } = await setup(t, {
		sessions: { "sess-stray": { header: { cwd: "/tmp" } } }
	});
	const res = await get(routes, "?session=sess-stray");
	assert.equal(res.status, 404);
	assert.equal(JSON.parse(res.text()).error.code, "session-not-found");
});

test("without the optional resolveByPath, a non-member session degrades to 404", async (t) => {
	const { routes } = await setup(t, {
		sessions: (repo) => ({ "sess-new": { header: { cwd: repo.root } } }),
		resolveByPath: false
	});
	const res = await get(routes, "?session=sess-new");
	assert.equal(res.status, 404);
});

test("detail=1 is honoured at the route level", async (t) => {
	const { routes } = await setup(t);
	const res = await get(routes, `?workspace=${WORKSPACE_ID}&detail=1`);
	const body = JSON.parse(res.text());
	assert.ok(Array.isArray(body.lastCommits));
	assert.equal(body.lastCommits[0].subject, "initial");
});

test("a workspace id wins over a session id when both are supplied", async (t) => {
	const { routes } = await setup(t);
	const res = await get(routes, `?workspace=${WORKSPACE_ID}&session=sess-unknown`);
	assert.equal(res.status, 200);
});
