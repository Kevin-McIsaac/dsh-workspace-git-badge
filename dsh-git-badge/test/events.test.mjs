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
import { changeEvents, fakeCtx, openSse, waitFor } from "../test-support/harness.mjs";
import { makeRepo } from "../test-support/repo.mjs";

/** Open one SSE connection against a real repo; everything is torn down by t.after. */
async function connect(t) {
	const repo = await makeRepo(t);
	await repo.commit("initial");
	const { ctx, routes, disposeAll } = fakeCtx({ workspaces: [repo.root] });
	apply(ctx);
	const stream = await openSse(routes);
	t.after(async () => {
		stream.abort();
		await stream.read;
		disposeAll();
		for (const key of [...watchers.keys()]) unwatchWorkspace(key);
	});
	await waitFor(() => stream.text().includes(": connected"));
	return { repo, stream, disposeAll };
}

test("a connection answers with event-stream headers and flushes immediately", async (t) => {
	const { stream } = await connect(t);
	assert.equal(stream.response.status, 200);
	assert.equal(stream.response.headers.get("content-type"), "text/event-stream");
	assert.equal(stream.response.headers.get("cache-control"), "no-cache");
	assert.equal(stream.response.headers.get("x-accel-buffering"), "no");
	assert.match(stream.text(), /^: connected/);
	assert.equal(stream.ended, false);
});

test("a filesystem change pushes a named change frame carrying the workspace path", async (t) => {
	const { repo, stream } = await connect(t);
	writeFileSync(join(repo.root, "changed.txt"), "hello\n");
	const seen = await waitFor(() => {
		const frames = changeEvents(stream);
		return frames.length > 0 ? frames : undefined;
	});
	assert.ok(seen, "expected a change frame after a worktree write");
	assert.equal(seen[0].path, repo.root);
	// the frame is NAMED — an unnamed message would not reach the client's
	// addEventListener("change") subscription
	assert.ok(stream.text().includes("event: change"));
});

test("a burst of writes collapses into a single change frame", async (t) => {
	const { repo, stream } = await connect(t);
	for (let index = 0; index < 5; index += 1) {
		writeFileSync(join(repo.root, `burst-${index}.txt`), "x\n");
	}
	// wait past the debounce window with slack for fs.watch delivery
	await new Promise((resolve) => setTimeout(resolve, config.debounceMs + 700));
	assert.equal(changeEvents(stream).length, 1);
});

test("disconnect removes the listener, the heartbeat and the stream", async (t) => {
	const { stream } = await connect(t);
	assert.equal(openStreams.size, 1);
	assert.equal(changeListeners.size, 1);
	stream.abort();
	await waitFor(() => openStreams.size === 0 && changeListeners.size === 0);
	assert.equal(openStreams.size, 0);
	assert.equal(changeListeners.size, 0);
	await stream.read;
	assert.equal(stream.ended, true);
});

test("closeStream is idempotent across a duplicate close", async (t) => {
	const { stream } = await connect(t);
	const record = [...openStreams][0];
	record.close();
	record.close();
	assert.equal(openStreams.size, 0);
	assert.equal(changeListeners.size, 0);
	await stream.read;
});

test("plugin unload ends open streams and releases watchers", async (t) => {
	const { stream, disposeAll } = await connect(t);
	assert.ok(watchers.size > 0);
	assert.equal(stream.ended, false);
	disposeAll();
	await stream.read;
	assert.equal(stream.ended, true);
	assert.equal(openStreams.size, 0);
	assert.equal(watchers.size, 0);
});
