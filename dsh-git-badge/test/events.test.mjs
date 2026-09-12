/**
 * SSE change feed: connect behaviour, change frames from a real filesystem
 * mutation, debounce, cleanup on disconnect, and cleanup on plugin unload.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	apply,
	changeListeners,
	config,
	openStreams,
	unwatchWorkspace,
	watchers
} from "../lib/index.js";
import { changeEvents, fakeCtx, fakeReq, fakeStream, waitFor } from "../test-support/harness.mjs";
import { makeRepo } from "../test-support/repo.mjs";

/** Open one SSE connection against a real repo; everything is torn down by t.after. */
async function connect(t) {
	const repo = await makeRepo(t);
	await repo.commit("initial");
	const { ctx, routes, disposeAll } = fakeCtx({ workspaces: [repo.root] });
	apply(ctx);
	const req = fakeReq({ url: "/api/git-badge/events" });
	const res = fakeStream();
	await routes.get("/api/git-badge/events").handler(req, res);
	t.after(() => {
		disposeAll();
		for (const key of [...watchers.keys()]) unwatchWorkspace(key);
	});
	return { repo, req, res, disposeAll };
}

test("a connection answers with event-stream headers and flushes immediately", async (t) => {
	const { res } = await connect(t);
	assert.equal(res.status, 200);
	assert.equal(res.headers["content-type"], "text/event-stream");
	assert.equal(res.headers["cache-control"], "no-cache");
	assert.equal(res.headers["x-accel-buffering"], "no");
	assert.match(res.text(), /^: connected/);
	assert.equal(res.ended, false);
});

test("a filesystem change pushes a named change frame carrying the workspace path", async (t) => {
	const { repo, res } = await connect(t);
	writeFileSync(join(repo.root, "changed.txt"), "hello\n");
	const seen = await waitFor(() => {
		const frames = changeEvents(res);
		return frames.length > 0 ? frames : undefined;
	});
	assert.ok(seen, "expected a change frame after a worktree write");
	assert.equal(seen[0].path, repo.root);
	// the frame is NAMED — an unnamed message would not reach the client's
	// addEventListener("change") subscription
	assert.ok(res.text().includes("event: change"));
});

test("a burst of writes collapses into a single change frame", async (t) => {
	const { repo, res } = await connect(t);
	for (let index = 0; index < 5; index += 1) {
		writeFileSync(join(repo.root, `burst-${index}.txt`), "x\n");
	}
	// wait past the debounce window with slack for fs.watch delivery
	await new Promise((resolve) => setTimeout(resolve, config.debounceMs + 700));
	assert.equal(changeEvents(res).length, 1);
});

test("disconnect removes the listener, the heartbeat and the stream", async (t) => {
	const { req, res } = await connect(t);
	assert.equal(openStreams.size, 1);
	assert.equal(changeListeners.size, 1);
	req.emit("close");
	assert.equal(openStreams.size, 0);
	assert.equal(changeListeners.size, 0);
	assert.equal(res.ended, true);
});

test("closeStream is idempotent across a duplicate close event", async (t) => {
	const { req, res } = await connect(t);
	req.emit("close");
	req.emit("close");
	res.emit("close");
	assert.equal(openStreams.size, 0);
	assert.equal(changeListeners.size, 0);
});

test("plugin unload ends open streams and releases watchers", async (t) => {
	const { res, disposeAll } = await connect(t);
	assert.ok(watchers.size > 0);
	assert.equal(res.ended, false);
	disposeAll();
	assert.equal(res.ended, true);
	assert.equal(openStreams.size, 0);
	assert.equal(watchers.size, 0);
});
