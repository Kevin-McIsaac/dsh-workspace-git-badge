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
import { changeListeners } from "../lib/index.js";

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

/** Subscribe a spy to change notifications; released with the test. */
export function spyOn(t) {
	const seen = [];
	// notifications carry a payload: { path, workspace }
	const spy = (payload) => seen.push(payload);
	changeListeners.add(spy);
	t.after(() => changeListeners.delete(spy));
	return seen;
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
 * Fake cordis ctx: captures every `connection.fetch.register()` route by path
 * and every disposer returned by effect(), so a test can drive routes directly
 * and simulate a plugin unload with disposeAll().
 *
 * `workspaces` entries may be a bare path or `{ id, path, sessionIds }`. The
 * entities mirror the REAL registry surface — `WorkspaceEntity` exposes public
 * `id`, `path` and `sessionIds`, and its `record` is private — so a test cannot
 * accidentally pass by reading a field the plugin must not touch. Ids default to
 * `ws-<index>`. `sessions` maps a session id to a live-session stand-in
 * (`{ header: { cwd } }`) for the pre-attach fallback. `sessionCwd` supplies the
 * working-directory projection: a string, or a function of the session id.
 * `sessionProjections` (default true) supplies the change feed; pass false to
 * model a host that composes no projection registry.
 */
export function fakeCtx({ workspaces = [], sessions = {}, resolveByPath = true, sessionCwd, skills, sessionProjections = true } = {}) {
	const routes = new Map();
	const disposers = [];
	const registeredSkills = [];
	const projectionListeners = new Set();
	const entities = workspaces.map((entry, index) => {
		if (typeof entry === "string") return { id: `ws-${index}`, path: entry, sessionIds: [] };
		return {
			id: entry.id ?? `ws-${index}`,
			path: entry.path,
			sessionIds: entry.sessionIds ?? []
		};
	});
	const ctx = {
		connection: {
			fetch: {
				register(route) {
					routes.set(route.path, route);
					return async () => {
						routes.delete(route.path);
					};
				}
			}
		},
		workspaceRegistry: {
			list: () => entities,
			// the real signature is async, rejects for a missing path, and resolves
			// undefined for a directory no workspace owns
			...(resolveByPath
				? { resolveByPath: async (candidate) => entities.find((entity) => entity.path === candidate) }
				: {})
		},
		sessions: { get: (id) => sessions[id] },
		...(sessionCwd === void 0
			? {}
			: {
					sessionController: {
						async projections({ sessionId }) {
							const cwd = typeof sessionCwd === "function" ? sessionCwd(sessionId) : sessionCwd;
							return cwd === void 0 ? null : { kind: "sequenced", asOfSeq: 0, values: { workingDirectory: cwd } };
						}
					}
				}),
		workingDirectory: {
			get(session) {
				return session?.header?.cwd;
			}
		},
		...(sessionProjections
			? {
					sessionProjections: {
						onChanged(listener) {
							projectionListeners.add(listener);
							return () => projectionListeners.delete(listener);
						}
					}
				}
			: {}),
		...(skills === void 0
			? {}
			: {
					skills: {
						register(skill) {
							registeredSkills.push(skill);
							return () => {
								const index = registeredSkills.indexOf(skill);
								if (index >= 0) registeredSkills.splice(index, 1);
							};
						}
					}
				}),
		// the optional services are read through ctx.get(), never injected
		get(name) {
			if (name === "sessions") return ctx.sessions;
			if (name === "sessionController") return ctx.sessionController;
			if (name === "workingDirectory") return ctx.workingDirectory;
			if (name === "sessionProjections") return ctx.sessionProjections;
			return void 0;
		},
		inject(names, callback) {
			if (names.every((name) => ctx[name] !== void 0)) return callback(ctx);
			return void 0;
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
		registeredSkills,
		/** Fire one projection change the way the real registry does. */
		emitProjection(session, key, value) {
			for (const listener of [...projectionListeners]) listener(session, key, value, 0);
		},
		disposeAll() {
			for (const dispose of disposers.splice(0)) dispose();
		}
	};
}

/** Drive GET /api/git-badge through a captured route set. */
export async function get(routes, query) {
	const route = routes.get("/api/git-badge");
	if (route === void 0) throw new Error("status route is not registered");
	const response = await route.fetch(new Request(`http://dsh.internal/api/git-badge${query}`));
	const text = await response.text();
	return {
		status: response.status,
		headers: Object.fromEntries(response.headers.entries()),
		text: () => text
	};
}

/**
 * Open the SSE route and read it in the background. `abort()` disconnects like a
 * browser tab close; `ended` flips when the stream completes.
 */
export async function openSse(routes, path = "/api/git-badge/events") {
	const route = routes.get(path);
	if (route === void 0) throw new Error("event route is not registered");
	const controller = new AbortController();
	const response = await route.fetch(new Request(`http://dsh.internal${path}`, { signal: controller.signal }));
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	const stream = {
		response,
		ended: false,
		controller,
		text: () => text,
		abort: () => controller.abort()
	};
	stream.read = (async () => {
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				text += decoder.decode(value, { stream: true });
			}
		} catch {
			/* aborted or closed */
		} finally {
			stream.ended = true;
		}
	})();
	return stream;
}

/** SSE text → [{ event, data }]; comment-only frames surface as message/''. */
function parseFrames(text) {
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
