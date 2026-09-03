/**
 * dsh-git-badge — node half.
 *
 * Hardened git-status service behind two routes:
 *
 *   GET /api/git-badge?path=<workspace path>[&detail=1]
 *     - path allowlist: only directories registered as DSH workspaces
 *       (WorkspaceRegistry records) are ever queried — no filesystem probing
 *       of arbitrary paths.
 *     - one git invocation per sample: `git --no-optional-locks status
 *       --porcelain=v2 --branch` yields branch, ahead/behind, and the
 *       changed / untracked counts in a single call (`--no-optional-locks`
 *       guarantees the read never contends with the user's own git
 *       operations on the index).
 *     - ahead/behind compare against the LOCAL remote-tracking ref, which
 *       only moves on fetch — so a TTL-bounded background fetch (60s per
 *       toplevel) runs before status when the ref can be stale. `GIT_TERMINAL_PROMPT=0`
 *       and the shared timeout keep an offline/slow remote from stalling the
 *       route; on fetch failure the stale-ref answer is served as-is.
 *     - `detail=1` adds one `log -1` for the hover card; row refresh never
 *       pays for it.
 *
 *   GET /api/git-badge/events   (text/event-stream)
 *     - pushes `{ path }` dirty notifications the moment a workspace's git
 *       state can have changed. Freshness is EVENT-DRIVEN: each registered
 *       workspace root is watched recursively (.git included), so a commit /
 *       checkout / stage / worktree edit pushes one SSE message and every
 *       mounted row refetches immediately. There is no fixed polling
 *       interval anywhere in the pipeline.
 *
 * When upstream lands a workspace-metadata service, this half is deleted and
 * the client half re-points at it — the seam contract does not change.
 */
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { watch, existsSync } from "node:fs";
import { join } from "node:path";

const inject = ["webServer", "workspaceRegistry"];
const name = "dsh-git-badge";

/**
 * Run git in dir. Resolves { stdout } on success; on failure { stdout: null }
 * plus exactly one of: timeout (execFile timeout kill), missing (no git
 * binary), or exitCode (git ran and rejected — e.g. "not a repository").
 * The exitCode/timeout distinction separates a definitive answer (non-repo)
 * from a transient one (degraded).
 */
function runGit(dir, args, opts) {
	const { env, timeout = 3000 } = opts ?? {};
	// env is a full replacement for execFile; overlay onto process.env so
	// PATH/HOME (credential helpers, global config) survive
	const fullEnv = env === void 0 ? void 0 : { ...process.env, ...env };
	return new Promise((resolve) => {
		execFile("git", args, { cwd: dir, timeout, env: fullEnv }, (error, stdout) => {
			if (error === void 0 || error === null) resolve({ stdout: String(stdout) });
			else if (error.killed) resolve({ stdout: null, timeout: true });
			else if (error.code === "ENOENT") resolve({ stdout: null, missing: true });
			else resolve({ stdout: null, exitCode: error.code });
		});
	});
}

/** Marker response for a git invocation that failed or timed out (transient). */
const GIT_DEGRADED = { git: false, error: "git unavailable (timeout or failure)" };

//#region TTL-bounded background fetch
/**
 * ahead/behind come from the local remote-tracking ref, which only moves on
 * `git fetch` — without one, a remote update (push from elsewhere, GitHub
 * edit) is invisible to the badge until the user happens to fetch. A
 * TTL-bounded fetch closes that gap: at most one network round trip per
 * FETCH_TTL_MS per repository, regardless of how often the route is hit
 * (watcher bursts included). Mirrors what IDEs do (VS Code's throttled
 * auto-fetch), with a TTL rather than a timer: fetch only happens when
 * someone is actually looking at the badge.
 */
const FETCH_TTL_MS = 60000;
/** lastFetchAt per toplevel; in-flight promise per toplevel collapses races. */
const fetchState = new Map();

/**
 * Refresh the remote-tracking refs for toplevel, bounded by TTL. Resolves
 * true only when a fetch actually ran and succeeded; every failure mode
 * (TTL fresh, no upstream configured, git failure, timeout) resolves false
 * and the caller just serves the status it already has. The in-flight map
 * means concurrent requests share one fetch instead of stampeding.
 */
async function maybeFetch(toplevel) {
	const now = Date.now();
	const state = fetchState.get(toplevel);
	if (state !== void 0) {
		if (state.inFlight !== null) return state.inFlight;
		if (now - state.lastAttemptAt < FETCH_TTL_MS) return false;
	}
	const inFlight = (async () => {
		// --no-tags --prune: refs-only refresh, cheapest correct form.
		// No remote name: `git fetch` uses the branch's configured upstream,
		// and a bare `fetch --all` would probe every remote for every badge.
		// GIT_TERMINAL_PROMPT=0: a credential prompt must never hang the route.
		const out = await runGit(toplevel, ["fetch", "--quiet", "--no-tags", "--prune"], {
			env: { GIT_TERMINAL_PROMPT: "0" },
			// measured real-world fetch is ~3s on SSH; the status-call 3s budget
			// would kill healthy fetches on a slow link. 8s is the worst-case
			// route latency, paid at most once per FETCH_TTL_MS per workspace.
			timeout: 8000
		});
		const ok = out.stdout !== null;
		fetchState.set(toplevel, { lastAttemptAt: Date.now(), inFlight: null });
		return ok;
	})();
	if (state === void 0) fetchState.set(toplevel, { lastAttemptAt: now, inFlight });
	else state.inFlight = inFlight;
	return inFlight;
}
//#endregion

/**
 * Parse `git status --porcelain=v2 --branch` output.
 * Headers: `# branch.head <name>` (or `(detached)`), `# branch.upstream
 * <name>`, `# branch.ab +ahead -behind`. Records per path: `1`/`2` carry the
 * two-column XY status (X = index/staged, Y = worktree), `u` unmerged,
 * `?` untracked.
 */
function parseStatusV2(out) {
	let branch = "HEAD (detached)";
	let upstream;
	let ahead;
	let behind;
	let staged = 0;
	let unstaged = 0;
	let unmerged = 0;
	let untracked = 0;
	for (const line of out.split("\n")) {
		if (line.startsWith("# branch.head ")) branch = line.slice(14).trim();
		else if (line.startsWith("# branch.upstream ")) upstream = line.slice(18).trim();
		else if (line.startsWith("# branch.ab ")) {
			// no elision comma: element 0 IS "+ahead", element 1 is "-behind"
			const [plus, minus] = line.slice(12).trim().split(" ");
			const a = Number.parseInt((plus ?? "").slice(1), 10);
			const b = Number.parseInt((minus ?? "").slice(1), 10);
			if (Number.isFinite(a)) ahead = a;
			if (Number.isFinite(b)) behind = b;
		} else if (line.startsWith("1 ") || line.startsWith("2 ")) {
			// XY columns: X = index (staged), Y = worktree (unstaged)
			if (line[2] !== ".") staged += 1;
			if (line[3] !== ".") unstaged += 1;
		} else if (line.startsWith("u ")) unmerged += 1;
		else if (line.startsWith("? ")) untracked += 1;
	}
	return { branch, upstream, ahead, behind, staged, unstaged, unmerged, untracked };
}

/**
 * Git status for dir; { git: false } when dir is not a repository,
 * GIT_DEGRADED on transient git failure.
 *
 * Subdirectory workspaces: status is computed from `--show-toplevel`, so a
 * workspace pointing INSIDE a larger repository reports that repository's
 * branch, dirty state, and ahead/behind counts (what git itself considers
 * dirty), not the subdirectory in isolation. Intentional.
 */
async function gitStatus(dir, wantDetail) {
	const top = await runGit(dir, ["rev-parse", "--show-toplevel"]);
	if (top.stdout === null) {
		// git ran and rejected ("not a repository") is a definitive answer;
		// timeout / missing binary is transient
		return top.exitCode !== void 0 ? { git: false } : GIT_DEGRADED;
	}
	const toplevel = top.stdout.trim();
	if (toplevel === "") return { git: false };
	const sample = () => runGit(toplevel, ["--no-optional-locks", "status", "--porcelain=v2", "--branch"]);
	let statusOut = await sample();
	if (statusOut.stdout === null) return GIT_DEGRADED;
	let parsed = parseStatusV2(statusOut.stdout);
	// The upstream header is the cheap gate: no upstream configured → the
	// fetch would be a no-op probe, skip it entirely. When it fires and the
	// fetch succeeds, re-sample so this very response already carries the
	// fresh ahead/behind instead of lagging one cycle behind.
	if (parsed.upstream !== void 0) {
		const fetched = await maybeFetch(toplevel);
		if (fetched) {
			statusOut = await sample();
			if (statusOut.stdout === null) return GIT_DEGRADED;
			parsed = parseStatusV2(statusOut.stdout);
		}
	}
	const dirtyFiles = parsed.staged + parsed.unstaged + parsed.unmerged + parsed.untracked;
	const info = {
		git: true,
		branch: parsed.branch,
		upstream: parsed.upstream,
		dirty: dirtyFiles > 0,
		changedFiles: parsed.staged + parsed.unstaged,
		stagedFiles: parsed.staged,
		unstagedFiles: parsed.unstaged,
		unmergedFiles: parsed.unmerged,
		untrackedFiles: parsed.untracked,
		ahead: parsed.ahead,
		behind: parsed.behind
	};
	if (wantDetail) {
		// last 3 commits (subject + relative age) for the hover card
		const logOut = await runGit(toplevel, ["log", "-3", "--format=%h%x09%s%x09%cr"]);
		if (logOut.stdout !== null && logOut.stdout.trim() !== "") {
			info.lastCommits = logOut.stdout.trim().split("\n").map((line) => {
				const [hash, subject, when] = line.split("\t");
				return { hash, subject: subject ?? "", when: when ?? "" };
			}).filter((c) => c.hash !== void 0);
		}
		// stash count, only surfaced when nonzero
		const stashOut = await runGit(toplevel, ["stash", "list"]);
		if (stashOut.stdout !== null) {
			const count = stashOut.stdout.split("\n").filter((l) => l.trim() !== "").length;
			if (count > 0) info.stashCount = count;
		}
	}
	return info;
}

//#region git-state watcher
/**
 * One recursive watcher per workspace `.git` directory. Any event under it
 * (HEAD swap, index write, ref update) marks the workspace dirty; a 200ms
 * debounce collapses burst events (a single `git commit` touches index,
 * refs, COMMIT_EDITMSG, objects…) into one notification.
 */
const watchers = new Map();
const changeListeners = new Set();
const WATCH_RETRY_MS = 60000;
const DEBOUNCE_MS = 200;

function notifyChange(key) {
	for (const fn of changeListeners) {
		try {
			fn(key);
		} catch {
			/* a dead SSE subscriber must never break the others */
		}
	}
}

function unwatchWorkspace(key) {
	const record = watchers.get(key);
	if (record === void 0) return;
	watchers.delete(key);
	if (record.watcher !== null) record.watcher.close();
	if (record.timer !== void 0) clearTimeout(record.timer);
}

function watchWorkspace(root, key) {
	const existing = watchers.get(key);
	if (existing !== void 0) {
		// live watcher, or a failed attempt still inside its retry backoff
		if (existing.watcher !== null || Date.now() - existing.failedAt < WATCH_RETRY_MS) return;
		watchers.delete(key);
	}
	// only git workspaces need a badge; a missing .git skips the watcher but
	// retries on the normal backoff (cheap existsSync) so a later `git init`
	// in the workspace is picked up
	if (!existsSync(join(root, ".git"))) {
		watchers.set(key, { watcher: null, failedAt: Date.now(), timer: void 0 });
		return;
	}
	try {
		// Watch the whole worktree, .git included: worktree edits (the most
		// common dirty signal) and metadata ops (commit / checkout / stage)
		// all surface here. The 200ms debounce collapses save bursts; if the
		// tree is too large for the inotify budget the error handler drops
		// back to the 60s client poll.
		const watcher = watch(root, { recursive: true }, () => {
			const record = watchers.get(key);
			if (record === void 0) return;
			clearTimeout(record.timer);
			record.timer = setTimeout(() => notifyChange(key), DEBOUNCE_MS);
		});
		watcher.on("error", () => unwatchWorkspace(key));
		watchers.set(key, { watcher, timer: void 0 });
	} catch {
		// watch refused (permissions, watch budget) — remember and back off
		watchers.set(key, { watcher: null, failedAt: Date.now(), timer: void 0 });
	}
}

/** Reconcile the watcher set with the current workspace registry. */
function syncWatchers(ctx) {
	const wanted = new Set();
	for (const entity of ctx.workspaceRegistry.list()) {
		const p = entity?.record?.path ?? entity?.path;
		if (typeof p !== "string") continue;
		wanted.add(p);
		watchWorkspace(p, p);
	}
	for (const key of [...watchers.keys()]) if (!wanted.has(key)) unwatchWorkspace(key);
}
//#endregion

/** Host plugin body — register the status route and the SSE change feed. */
function apply(ctx) {
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/api/git-badge",
		handler: async (req, res) => {
			try {
				const url = new URL(req.url, "http://localhost");
				const raw = url.searchParams.get("path") ?? "";
				if (raw === "") throw new Error("missing path");
				// Allowlist: the requested path must be (or resolve to) a registered
				// workspace directory. Anything else is refused without inspection.
				const registered = new Set();
				for (const entity of ctx.workspaceRegistry.list()) {
					const p = entity?.record?.path ?? entity?.path;
					if (typeof p === "string") registered.add(p);
				}
				const resolved = await realpath(raw).catch(() => null);
				if (resolved === null || !registered.has(raw) && !registered.has(resolved)) {
					res.writeHead(403, { "content-type": "application/json" });
					res.end(JSON.stringify({ git: false, error: "path is not a registered workspace" }));
					return;
				}
				const detail = url.searchParams.get("detail") === "1";
				const body = JSON.stringify(await gitStatus(resolved, detail));
				res.writeHead(200, { "content-type": "application/json" });
				res.end(body);
			} catch (error) {
				res.writeHead(400, { "content-type": "application/json" });
				res.end(JSON.stringify({ git: false, error: String(error?.message ?? error) }));
			}
		}
	}));
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/api/git-badge/events",
		handler: async (req, res) => {
			// keep the watcher set aligned with the live registry on every connect
			syncWatchers(ctx);
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive"
			});
			// flush immediately: staged headers only hit the wire on first write,
			// and the first real event may be minutes away
			res.write(": connected\n\n");
			const send = (key) => {
				try {
					res.write(`data: ${JSON.stringify({ path: key })}\n\n`);
				} catch {
					/* socket gone; the close handler cleans up */
				}
			};
			changeListeners.add(send);
			// comment-only heartbeat keeps proxies from idling the stream out
			const heartbeat = setInterval(() => {
				try {
					res.write(": hb\n\n");
				} catch {
					/* ignore */
				}
			}, 25000);
			req.on("close", () => {
				changeListeners.delete(send);
				clearInterval(heartbeat);
			});
		}
	}));
}

export { apply, inject, name };
