/**
 * Shared test scaffolding for the dsh-git-badge node half.
 *
 * No DSH involvement: `apply()` is driven with a fake cordis ctx and the SSE
 * route with a fake req/res pair, so the whole suite runs under plain
 * `node --test` — which is what lets a node-half change be verified without
 * restarting the user's web process.
 *
 * The fake ctx / fake stream shapes are adapted from
 * @wongzexu/dsh-git-status (MIT), tests/git-events.test.mjs.
 */

/**
 * Poll `fn` until it returns something truthy or the deadline passes. fs.watch
 * delivery plus the debounce window are not deterministic, so the suite polls
 * to a deadline instead of sleeping a fixed amount.
 */
export async function waitFor(fn, { timeoutMs = 3000, intervalMs = 25 } = {}) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = fn();
		if (value) return value;
		if (Date.now() >= deadline) return value;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}

/** Minimal event emitter shared by the fake req/res. */
function emitter() {
	const handlers = new Map();
	return {
		on(event, fn) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(fn);
		},
		emit(event) {
			for (const fn of handlers.get(event) ?? []) fn();
		}
	};
}

/**
 * Fake cordis ctx: captures every webServer.register() route by path and every
 * disposer returned by effect(), so a test can drive routes directly and
 * simulate a plugin unload with disposeAll().
 *
 * `workspaces` entries may be a bare path or `{ id, path, sessionIds }`. The
 * entities mirror the REAL registry surface — `WorkspaceEntity` exposes public
 * `id`, `path` and `sessionIds`, and its `record` is private — so a test cannot
 * accidentally pass by reading a field the plugin must not touch. Ids default to
 * `ws-<index>`. `sessions` maps a session id to a live-session stand-in
 * (`{ header: { cwd } }`) for the pre-attach fallback.
 */
export function fakeCtx({ workspaces = [], sessions = {}, resolveByPath = true } = {}) {
	const routes = new Map();
	const disposers = [];
	const entities = workspaces.map((entry, index) => {
		if (typeof entry === "string") return { id: `ws-${index}`, path: entry, sessionIds: [] };
		return {
			id: entry.id ?? `ws-${index}`,
			path: entry.path,
			sessionIds: entry.sessionIds ?? []
		};
	});
	const ctx = {
		workspaceRegistry: {
			list: () => entities,
			// the real signature is async, rejects for a missing path, and resolves
			// undefined for a directory no workspace owns
			...(resolveByPath
				? { resolveByPath: async (candidate) => entities.find((entity) => entity.path === candidate) }
				: {})
		},
		sessions: { get: (id) => sessions[id] },
		// the optional service is read through ctx.get(), never injected
		get: (name) => (name === "sessions" ? ctx.sessions : void 0),
		webServer: {
			register(route) {
				routes.set(route.path, route);
				return () => routes.delete(route.path);
			}
		},
		effect(fn) {
			const dispose = fn();
			if (typeof dispose === "function") disposers.push(dispose);
			return dispose;
		}
	};
	return {
		ctx,
		routes,
		entities,
		disposeAll() {
			for (const dispose of disposers.splice(0)) dispose();
		}
	};
}

/** Fake incoming request: only `url`, `method` and the close event are used. */
export function fakeReq({ url = "/", method = "GET" } = {}) {
	return Object.assign(emitter(), { url, method });
}

/**
 * Fake ServerResponse. `end()` fires `close` exactly once, like a real socket,
 * so the double-cleanup paths are exercised without recursing.
 */
export function fakeStream() {
	const e = emitter();
	return Object.assign(e, {
		chunks: [],
		status: 0,
		headers: null,
		ended: false,
		writeHead(status, headers) {
			this.status = status;
			this.headers = headers;
		},
		write(chunk) {
			this.chunks.push(String(chunk));
			return true;
		},
		end(chunk) {
			if (chunk !== undefined) this.chunks.push(String(chunk));
			if (this.ended) return;
			this.ended = true;
			e.emit("close");
		},
		text() {
			return this.chunks.join("");
		}
	});
}

/** SSE text → [{ event, data }]; comment-only frames surface as message/''. */
export function parseFrames(text) {
	return text.split("\n\n").filter((frame) => frame !== "").map((frame) => ({
		event: /^event: (.+)$/m.exec(frame)?.[1] ?? "message",
		data: /^data: (.+)$/m.exec(frame)?.[1] ?? ""
	}));
}

/** Parsed `event: change` payloads seen on one stream. */
export function changeEvents(stream) {
	return parseFrames(stream.text())
		.filter((frame) => frame.event === "change")
		.map((frame) => JSON.parse(frame.data));
}
