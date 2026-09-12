/**
 * dsh-git-badge — node half.
 *
 * Hardened git-status service behind two routes:
 *
 *   GET /api/git-badge?workspace=<workspaceId>   (sidebar rows)
 *   GET /api/git-badge?session=<sessionId>       (the input chip)
 *     - NO client-supplied path is accepted. The caller names a workspace id or
 *       a session id; the server resolves the directory itself. `?path=` was
 *       removed precisely so a caller cannot aim the route at a directory of
 *       its choosing, even one inside the registry.
 *     - the route is intentionally unauthenticated (it is a local, read-only
 *       status feed), so resolution must never assume the caller is honest.
 *       Workspace ids are generated uuids and session ids are opaque, so the
 *       surface no longer offers anything to enumerate.
 *     - one git invocation per sample: `git --no-optional-locks status
 *       --porcelain=v2 --branch --untracked-files=all` yields branch,
 *       ahead/behind, and the changed / untracked counts in a single call
 *       (`--no-optional-locks` guarantees the read never contends with the
 *       user's own git operations on the index). `--untracked-files=all`
 *       counts untracked FILES; git's default collapses a new directory into
 *       one entry, which under-reported `✎n` for anyone who adds a folder.
 *       If that walk blows the budget the sample is retried collapsed and the
 *       response reports which mode answered (`untrackedMode`).
 *     - one `git rev-parse --show-toplevel --absolute-git-dir` resolves both
 *       the repository root (a subdirectory workspace reports the whole repo)
 *       and the per-worktree git dir, where the eight in-progress operation
 *       markers (`MERGE_HEAD`, `rebase-merge`, …) are stat'd — surfaced as
 *       `operation`, so a paused rebase/cherry-pick is distinguishable from
 *       ordinary dirty work even when its conflicts are already staged.
 *     - ahead/behind compare against the LOCAL remote-tracking ref, which only
 *       moves on fetch. A TTL-bounded fetch (60s per toplevel) keeps that ref
 *       fresh, but it runs OUT OF BAND: the answer is served from the refs at
 *       hand and a successful fetch notifies subscribers so the next refresh
 *       carries corrected ahead/behind. Awaiting it here cost ~3.3s per request
 *       on the first refresh after each TTL window. `GIT_TERMINAL_PROMPT=0`, the
 *       shared timeout and the TTL bound keep an offline or slow remote harmless;
 *       on failure the stale-ref answer simply stands.
 *     - `detail=1` adds one `log -3` plus a stash count. NOTE: no surface
 *       consumes this yet (see the annotation on gitStatus) — it is kept for
 *       the planned hover card, and never paid for by row refresh.
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
import { watch, existsSync } from "node:fs";
import { join } from "node:path";

const inject = ["webServer", "workspaceRegistry"];
const name = "dsh-git-badge";

/**
 * Runtime tunables. Production code never writes these; the test suite mutates
 * them to collapse the debounce / backoff / heartbeat windows and to force the
 * untracked-walk timeout deterministically instead of waiting on a pathological
 * repository. One exported object rather than scattered consts so tests have a
 * single documented seam.
 */
const config = {
	/** budget for every git invocation; an expired call is killed */
	gitTimeoutMs: 3000,
	/** network fetch budget; worst-case route latency, paid once per TTL */
	fetchTimeoutMs: 8000,
	/** minimum interval between background fetches per toplevel */
	fetchTtlMs: 60000,
	/** fs-event burst collapse window */
	debounceMs: 200,
	/** backoff before re-attempting a failed watcher (or a missing .git) */
	watchRetryMs: 60000,
	/**
	 * Degraded-mode poll interval for a workspace whose watcher failed. Only used
	 * where a real watcher could not be established or later errored — a healthy
	 * workspace is event-driven and never polls.
	 */
	pollFallbackMs: 5000,
	/** SSE comment heartbeat interval */
	heartbeatMs: 25000,
	/**
	 * Invoker for the status sample; null means the real runGit. The suite
	 * injects one that reports the `-uall` call as timed out, which exercises the
	 * collapsed-fallback branch deterministically — a real sub-millisecond budget
	 * would just race git's own startup.
	 */
	gitRunner: null
};

/**
 * Run git in dir. Resolves { stdout } on success; on failure { stdout: null }
 * plus exactly one of: timeout (execFile timeout kill), missing (no git
 * binary), or exitCode (git ran and rejected — e.g. "not a repository").
 * The exitCode/timeout distinction separates a definitive answer (non-repo)
 * from a transient one (degraded).
 */
function runGit(dir, args, opts) {
	const { env, timeout = config.gitTimeoutMs } = opts ?? {};
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
 * `config.fetchTtlMs` per repository, regardless of how often the route is hit
 * (watcher bursts included). Mirrors what IDEs do (VS Code's throttled
 * auto-fetch), with a TTL rather than a timer: fetch only happens when
 * someone is actually looking at the badge.
 */
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
		if (now - state.lastAttemptAt < config.fetchTtlMs) return false;
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
			// route latency, paid at most once per fetchTtlMs per workspace.
			timeout: config.fetchTimeoutMs
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
 * In-progress operation markers, in precedence order. Git drops one of these in
 * the per-worktree git dir while an operation is paused; the first match names
 * the operation. `SQUASH_MSG` is listed in its own right because a squash merge
 * records no `MERGE_HEAD`.
 */
const OPERATION_MARKERS = [
	["MERGE_HEAD", "merge"],
	["SQUASH_MSG", "squash"],
	["CHERRY_PICK_HEAD", "cherry-pick"],
	["REVERT_HEAD", "revert"],
	["BISECT_LOG", "bisect"],
	["rebase-merge", "rebase"],
	["rebase-apply", "rebase"],
	["sequencer", "sequencer"]
];

/**
 * Name of the git operation currently paused in gitDir, or null. Markers live in
 * the per-worktree git dir (not the shared one), so the caller passes
 * `rev-parse --absolute-git-dir`. Stat'ing the paths beats eight
 * `rev-parse --git-path` invocations — these are plain existence checks.
 */
function operationMarker(gitDir) {
	if (gitDir === "") return null;
	for (const [marker, operation] of OPERATION_MARKERS) {
		if (existsSync(join(gitDir, marker))) return operation;
	}
	return null;
}

/**
 * Git status for dir; { git: false } when dir is not a repository,
 * GIT_DEGRADED on transient git failure.
 *
 * Subdirectory workspaces: status is computed from `--show-toplevel`, so a
 * workspace pointing INSIDE a larger repository reports that repository's
 * branch, dirty state, and ahead/behind counts (what git itself considers
 * dirty), not the subdirectory in isolation. Intentional.
 *
 * `wantDetail` has no consumer yet: both surfaces fetch without `detail=1`.
 * The branch is retained for the planned hover card — nothing renders
 * lastCommits / stashCount today.
 */
async function gitStatus(dir, wantDetail) {
	// one invocation answers both questions: the repository root (so a
	// subdirectory workspace reports the whole repo) and the per-worktree git
	// dir (where the operation markers above live)
	const top = await runGit(dir, ["rev-parse", "--show-toplevel", "--absolute-git-dir"]);
	if (top.stdout === null) {
		// git ran and rejected ("not a repository") is a definitive answer;
		// timeout / missing binary is transient
		return top.exitCode !== void 0 ? { git: false } : GIT_DEGRADED;
	}
	const topLines = top.stdout.trim().split("\n");
	const toplevel = (topLines[0] ?? "").trim();
	if (toplevel === "") return { git: false };
	const gitDir = (topLines[1] ?? "").trim();
	// -uall counts untracked FILES; git's default collapses a new directory into
	// a single entry, which is why `✎n` under-reported anyone who added a folder.
	// Routed through config.gitRunner so the suite can force the timeout branch.
	const sample = (untrackedAll) => (config.gitRunner ?? runGit)(toplevel, [
		"--no-optional-locks",
		"status",
		"--porcelain=v2",
		"--branch",
		untrackedAll ? "--untracked-files=all" : "--untracked-files=normal"
	]);
	let untrackedMode = "all";
	let statusOut = await sample(true);
	if (statusOut.timeout) {
		// A pathological tree (a huge unignored directory) must not cost the whole
		// badge: retry collapsed and report which answer was served, rather than
		// degrading — or worse, silently reporting a count the client cannot
		// interpret.
		untrackedMode = "collapsed";
		statusOut = await sample(false);
	}
	if (statusOut.stdout === null) return GIT_DEGRADED;
	const parsed = parseStatusV2(statusOut.stdout);
	// The upstream header is the cheap gate: with no upstream the fetch would be a
	// no-op probe, so skip it. With one, refresh the remote-tracking refs OUT OF
	// BAND rather than before the answer.
	//
	// Blocking here cost ~3.3s per request (measured: `git fetch` over SSH) on every
	// request whose TTL had lapsed — and that is the first refresh after each 60s
	// window, i.e. constantly while someone is editing, which made an edit-triggered
	// badge update take seconds. So: answer now from the refs we already have, and
	// when the background fetch succeeds, notify subscribers — the client refetches,
	// finds the TTL fresh, and picks up the corrected ahead/behind in ~50ms. The
	// cost of the trade is that ahead/behind can lag by up to one fetch.
	if (parsed.upstream !== void 0) {
		void maybeFetch(toplevel)
			.then((fetched) => {
				if (fetched) notifyChange(toplevel);
			})
			.catch(() => {
				/* a failed fetch just means the stale-ref answer stands */
			});
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
		untrackedMode,
		operation: operationMarker(gitDir),
		ahead: parsed.ahead,
		behind: parsed.behind
	};
	if (wantDetail) {
		// last 3 commits (subject + relative age) for the planned hover card
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
/** Open SSE responses, so plugin unload can end them instead of leaking them. */
const openStreams = new Set();

function notifyChange(key) {
	// `workspace` lets a client that asked by id match the event without ever
	// knowing a filesystem path; `path` stays for debugging and other consumers.
	const payload = { path: key, workspace: watchers.get(key)?.workspaceId };
	for (const fn of changeListeners) {
		try {
			fn(payload);
		} catch {
			/* a dead SSE subscriber must never break the others */
		}
	}
}

/**
 * Tear down one SSE stream. Idempotent: `req` and `res` both fire `close` and
 * the plugin disposer can race them, so membership in openStreams is the single
 * source of truth for "still open".
 */
function closeStream(stream) {
	if (!openStreams.delete(stream)) return;
	changeListeners.delete(stream.send);
	clearInterval(stream.heartbeat);
	try {
		stream.res.end();
	} catch {
		/* already gone */
	}
}

function unwatchWorkspace(key) {
	const record = watchers.get(key);
	if (record === void 0) return;
	watchers.delete(key);
	if (record.watcher !== null) record.watcher.close();
	if (record.timer !== void 0) clearTimeout(record.timer);
	if (record.poll !== void 0) clearInterval(record.poll);
}

/**
 * Change-detection key for a workspace whose watcher failed. Deliberately cheap:
 * it runs every `config.pollFallbackMs`, so the `-uall` walk is off the table.
 * `status` covers worktree + index, the refs fingerprint covers what a fetch or
 * an external checkout moves, and the marker stat covers an in-progress
 * operation (which porcelain status does not report).
 *
 * The price of the cheap status: a new file inside an ALREADY untracked
 * directory does not change the key, so on a broken-watcher workspace that case
 * waits for the client's 60s poll. Recorded in TESTING.md rather than papered
 * over with a `-uall` walk every few seconds. The git dir is resolved once and
 * cached on the record.
 *
 * Resolves null when git could not run this tick; the caller keeps the previous
 * key and tries again.
 */
async function fallbackStateKey(root, record) {
	const status = await runGit(root, [
		"--no-optional-locks",
		"status",
		"--porcelain=v2",
		"--branch",
		"--untracked-files=normal"
	]);
	if (status.stdout === null) return null;
	if (record.gitDir === void 0) {
		const dir = await runGit(root, ["rev-parse", "--absolute-git-dir"]);
		record.gitDir = dir.stdout === null ? "" : dir.stdout.trim();
	}
	const refs = await runGit(root, ["for-each-ref", "--format=%(refname)%(objectname)", "refs/heads", "refs/remotes"]);
	return [status.stdout, refs.stdout ?? "", operationMarker(record.gitDir) ?? ""].join("\u0000");
}

/**
 * Start the degraded-mode poll for a workspace whose watcher could not be
 * established, or later errored. Only ever called for a workspace that HAS a
 * .git — a directory without one is not a repository, so polling it would be
 * waste; the retry backoff keeps re-checking that case instead.
 *
 * The interval is unref'd so a forgotten one can never hold the process open
 * (test runs included); `unwatchWorkspace` clears it properly.
 */
function startFallbackPoll(key, root) {
	const record = watchers.get(key);
	if (record === void 0 || record.poll !== void 0) return;
	const tick = () => {
		void (async () => {
			const current = watchers.get(key);
			if (current === void 0) return;
			const next = await fallbackStateKey(root, current).catch(() => null);
			if (next === null) return;
			// the first tick only sets a baseline: a fresh subscriber fetches on
			// mount, so there is nothing to announce yet
			if (current.pollKey !== void 0 && current.pollKey !== next) notifyChange(key);
			current.pollKey = next;
		})();
	};
	record.poll = setInterval(tick, config.pollFallbackMs);
	if (typeof record.poll.unref === "function") record.poll.unref();
	// Baseline immediately rather than one interval from now, so a change landing
	// right after the watcher died is still noticed on the following tick instead
	// of being baked into the baseline and never announced.
	tick();
}

function watchWorkspace(root, key, workspaceId) {
	const existing = watchers.get(key);
	if (existing !== void 0) {
		// live watcher, or a failed attempt still inside its retry backoff
		if (existing.watcher !== null || Date.now() - existing.failedAt < config.watchRetryMs) {
			existing.workspaceId = workspaceId;
			return;
		}
		// retrying: the degraded poll is replaced by a real watcher, or by a
		// fresh one created below
		if (existing.poll !== void 0) clearInterval(existing.poll);
		watchers.delete(key);
	}
	// only git workspaces need a badge; a missing .git skips the watcher but
	// retries on the normal backoff (cheap existsSync) so a later `git init`
	// in the workspace is picked up. No poll here: a non-repository has nothing
	// to report.
	if (!existsSync(join(root, ".git"))) {
		watchers.set(key, { watcher: null, failedAt: Date.now(), timer: void 0, workspaceId });
		return;
	}
	try {
		// Watch the whole worktree, .git included: worktree edits (the most
		// common dirty signal) and metadata ops (commit / checkout / stage)
		// all surface here; the debounce collapses save bursts.
		const watcher = watch(root, { recursive: true }, () => {
			const record = watchers.get(key);
			if (record === void 0) return;
			clearTimeout(record.timer);
			record.timer = setTimeout(() => notifyChange(key), config.debounceMs);
		});
		watcher.on("error", () => {
			// The watcher died after being established (inotify budget, tree
			// replaced, permissions). Drop it, but KEEP the record so the retry
			// backoff and the degraded poll both have somewhere to live — and
			// start polling so this workspace stays fresh in the meantime.
			const current = watchers.get(key);
			if (current === void 0) return;
			if (current.watcher !== null) current.watcher.close();
			current.watcher = null;
			current.failedAt = Date.now();
			startFallbackPoll(key, root);
		});
		watchers.set(key, { watcher, timer: void 0, workspaceId });
	} catch {
		// watch refused (permissions, watch budget) — back off AND poll: this
		// repository is real, just unwatchable
		watchers.set(key, { watcher: null, failedAt: Date.now(), timer: void 0, workspaceId });
		startFallbackPoll(key, root);
	}
}

/** Reconcile the watcher set with the current workspace registry. */
function syncWatchers(ctx) {
	const wanted = new Set();
	for (const entity of ctx.workspaceRegistry.list()) {
		// `path` and `id` are the entity's public surface; its `record` is private
		if (typeof entity?.path !== "string") continue;
		wanted.add(entity.path);
		watchWorkspace(entity.path, entity.path, entity.id === void 0 ? void 0 : String(entity.id));
	}
	for (const key of [...watchers.keys()]) if (!wanted.has(key)) unwatchWorkspace(key);
}
//#endregion

/**
 * Resolve a request to a registered workspace directory. The caller says WHO it
 * is, never WHERE to look — no client-supplied path is trusted or probed.
 *
 *   1. `?workspace=<id>` — the entity's own id, which is the same id the sidebar
 *      seam hands a row (the client builds `workspaceId` from `workspace.id`).
 *   2. `?session=<id>` — registry membership first, because `sessionIds` is
 *      header-validated and durable, so a conversation that is no longer live
 *      still resolves; then the live session's cwd validated through the
 *      registry's `resolveByPath`, which covers the window where a brand-new
 *      session is not yet attached to its workspace.
 *
 * @returns `{ id, path }` when resolved, else `{ status, error: { code, message } }`.
 *   The id is returned because the route echoes it: a client that asked by
 *   SESSION needs the workspace id to attribute that workspace's SSE events,
 *   since an event carries a workspace id and a session id can never match it.
 */
async function resolveWorkspace(ctx, params) {
	const workspaceId = params.get("workspace") ?? "";
	const sessionId = params.get("session") ?? "";
	if (workspaceId === "" && sessionId === "") {
		return { status: 400, error: { code: "target-required", message: "pass workspace=<id> or session=<id>" } };
	}
	const entities = [];
	for (const entity of ctx.workspaceRegistry.list()) {
		if (typeof entity?.path === "string") entities.push(entity);
	}
	if (workspaceId !== "") {
		const entity = entities.find((candidate) => String(candidate.id) === workspaceId);
		if (entity === void 0) {
			return { status: 404, error: { code: "workspace-not-found", message: "no workspace with that id" } };
		}
		return { id: String(entity.id), path: entity.path };
	}
	for (const entity of entities) {
		if (Array.isArray(entity.sessionIds) && entity.sessionIds.includes(sessionId)) {
			return { id: String(entity.id), path: entity.path };
		}
	}
	// A brand-new session whose workspace attach has not landed yet. Trust the
	// server-side session header (never the caller), then require the registry to
	// recognise that directory — so the path is still registry-validated.
	const cwd = ctx.get("sessions")?.get?.(sessionId)?.header?.cwd;
	const resolveByPath = ctx.workspaceRegistry.resolveByPath;
	if (typeof cwd === "string" && cwd !== "" && typeof resolveByPath === "function") {
		const entity = await resolveByPath.call(ctx.workspaceRegistry, cwd).catch(() => void 0);
		if (entity !== void 0 && typeof entity?.path === "string") return { id: String(entity.id), path: entity.path };
	}
	return { status: 404, error: { code: "session-not-found", message: "no registered workspace owns that session" } };
}

/** Host plugin body — register the status route and the SSE change feed. */
function apply(ctx) {
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/api/git-badge",
		handler: async (req, res) => {
			try {
				const url = new URL(req.url, "http://localhost");
				const target = await resolveWorkspace(ctx, url.searchParams);
				if (target.error !== void 0) {
					res.writeHead(target.status, { "content-type": "application/json" });
					res.end(JSON.stringify({ git: false, error: target.error }));
					return;
				}
				const detail = url.searchParams.get("detail") === "1";
				const info = await gitStatus(target.path, detail);
				// Echo the resolved workspace id. SSE events identify the workspace,
				// not the session, so a session-targeted client has no other way to
				// tell whether an event belongs to it — without this the input chip
				// only ever refreshed on remount or the 60s poll.
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ ...info, workspace: target.id }));
			} catch (error) {
				res.writeHead(400, { "content-type": "application/json" });
				res.end(JSON.stringify({ git: false, error: { code: "bad-request", message: String(error?.message ?? error) } }));
			}
		}
	}));
	ctx.effect(() => {
		const dispose = ctx.webServer.register({
			kind: "exact",
			path: "/api/git-badge/events",
			handler: async (req, res) => {
				// keep the watcher set aligned with the live registry on every connect
				syncWatchers(ctx);
				res.writeHead(200, {
					"content-type": "text/event-stream",
					"cache-control": "no-cache",
					connection: "keep-alive",
					// proxies (nginx et al) buffer responses by default, which holds
					// event frames back until the buffer fills
					"x-accel-buffering": "no"
				});
				// flush immediately: staged headers only hit the wire on first write,
				// and the first real event may be minutes away
				res.write(": connected\n\n");
				const stream = {
					res,
					heartbeat: null,
					send: (payload) => {
						try {
							// NAMED frame: the client subscribes with
							// addEventListener("change", …), which never sees an
							// unnamed message
							res.write(`event: change\ndata: ${JSON.stringify(payload)}\n\n`);
						} catch {
							/* socket gone; the close handler cleans up */
						}
					}
				};
				changeListeners.add(stream.send);
				// comment-only heartbeat keeps proxies from idling the stream out
				stream.heartbeat = setInterval(() => {
					try {
						res.write(": hb\n\n");
					} catch {
						/* ignore */
					}
				}, config.heartbeatMs);
				openStreams.add(stream);
				// both fire on a client disconnect; closeStream is idempotent
				req.on("close", () => closeStream(stream));
				res.on("close", () => closeStream(stream));
			}
		});
		// unloading the plugin must not leave subscribers holding dead streams,
		// nor keep process-wide watchers alive
		return () => {
			dispose();
			for (const stream of [...openStreams]) closeStream(stream);
			for (const key of [...watchers.keys()]) unwatchWorkspace(key);
		};
	});
}

export { apply, inject, name };

// ---------- test-only exports ----------
// Additive named exports; cordis reads apply/inject/name and ignores the rest.
// The suite in ./test drives these directly instead of booting DSH, which is
// what lets a node-half change be verified without a restart.
export {
	config,
	OPERATION_MARKERS,
	operationMarker,
	parseStatusV2,
	runGit,
	gitStatus,
	resolveWorkspace,
	watchWorkspace,
	unwatchWorkspace,
	syncWatchers,
	watchers,
	changeListeners,
	openStreams,
	closeStream
};
