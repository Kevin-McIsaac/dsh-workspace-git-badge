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
 *     - the same invocation identifies a LINKED WORKTREE: its git dir is
 *       `<main>/.git/worktrees/<name>` instead of `<root>/.git`, and unlike the
 *       main worktree's it carries a `commondir` file. One stat of the git dir
 *       the call already returned yields `isWorktree`, plus the checkout's own
 *       directory name as `worktreeName` — so the chip can say WHICH working
 *       tree a conversation is in. Without it, several worktrees of one
 *       repository render identical `🟡 main` badges. The name is a NAME, never
 *       a path: the route takes no path and the client still needs to know none.
 *     - ahead/behind compare against the LOCAL remote-tracking ref, which only
 *       moves on fetch. A TTL-bounded fetch (60s per toplevel) keeps that ref
 *       fresh, but it runs OUT OF BAND: the answer is served from the refs at
 *       hand and a successful fetch notifies subscribers so the next refresh
 *       carries corrected ahead/behind. Awaiting it here cost ~3.3s per request
 *       on the first refresh after each TTL window. `GIT_TERMINAL_PROMPT=0`, the
 *       shared timeout and the TTL bound keep an offline or slow remote harmless;
 *       on failure the stale-ref answer simply stands.
 *     - `detail=1` adds one `log -3` plus a stash count, and `pr=1` adds the
 *       branch's GitHub PR/CI state read through the user's own `gh` CLI. Both
 *       serve the input chip only — the hover card and the PR token — so a
 *       sidebar row refresh pays for neither. The PR read is TTL-bounded and
 *       out of band, like the fetch; it degrades to an ABSENT field rather than
 *       an error whenever `gh` cannot answer (see the PR region).
 *     - `pr=1` requires `gh` on PATH and authenticated for a token to appear.
 *       The plugin never handles the credential: `gh` owns it.
 *
 *   GET /api/git-badge/events   (text/event-stream)
 *     - pushes `{ path }` dirty notifications the moment a workspace's git
 *       state can have changed. Freshness is EVENT-DRIVEN: each registered
 *       workspace is watched recursively, so a commit / checkout / stage /
 *       worktree edit pushes one SSE message and every mounted row refetches
 *       immediately. There is no fixed polling interval anywhere in the
 *       pipeline. A MAIN worktree's git dir is `<root>/.git` and so is covered
 *       by the root watch; a LINKED worktree's is not, so its git dir gets a
 *       second watcher (see the watcher region).
 *
 * When upstream lands a workspace-metadata service, this half is deleted and
 * the client half re-points at it — the seam contract does not change.
 */
import { execFile } from "node:child_process";
import { watch, existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { SESSION_CHECKOUT_TTL_MS, clearRestartMarker, readRestartMarker, readSessionCheckouts } from "../seam/store.js";

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
	/**
	 * Test seam: the session-checkout registrations file. Null (the default)
	 * resolves it under the plugin's data dir (SEAM_DATA_DIR-aware store.js).
	 */
	sessionCheckoutsFile: null,
	/** Test seam: resolves the schema lib the settings namespace is built from. */
	settingsSchemaLoader: async () => (await import("@deepseek-ai/schemastery")).default,
	/** budget for every git invocation; an expired call is killed */
	gitTimeoutMs: 3000,
	/** network fetch budget; worst-case route latency, paid once per TTL */
	fetchTimeoutMs: 8000,
	/** minimum interval between background fetches per toplevel */
	fetchTtlMs: 60000,
	/** how long a resolved default-branch name is trusted (per toplevel) */
	defaultBranchTtlMs: 60000,
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
	gitRunner: null,
	/**
	 * PR / CI status via the `gh` CLI: "auto" reads it where `gh` can answer and
	 * silently shows nothing where it cannot; "off" never invokes `gh` at all.
	 * Only the input chip asks for it, so a sidebar-only view spawns no forge
	 * process — see the PR region.
	 */
	prStatus: "auto",
	/**
	 * Minimum interval between forge refreshes per repository. It must stay BELOW
	 * the client's idle poll (FALLBACK_POLL_MS, 60s in lib/client.js): the refresh
	 * is request-driven, so a TTL longer than that poll silently suppresses every
	 * OTHER request — and a pull request that appears on the forge with no local
	 * git event to announce it then waits out TTL + poll before it shows. At 90s
	 * that worst case was ~2.5 minutes; 20s bounds it at roughly one poll, for up
	 * to one `gh pr view` per open chip per minute.
	 */
	prTtlMs: 20000,
	/**
	 * Forge call budget. Unlike git this is a network round trip to GitHub, so
	 * it gets a more generous budget than the status sample — but it is bounded
	 * all the same, because nothing here may hang the route.
	 */
	prTimeoutMs: 6000,
	/**
	 * Invoker for the `gh` CLI; null means the real runCli. The suite substitutes
	 * one so every degradation path (no gh, logged out, no PR, garbage output,
	 * timeout) is covered with no gh, no network and no forge.
	 */
	prRunner: null,
	/**
	 * Bound on the repository-wide open-PR read (`gh pr list`). Only one page is
	 * read, so a repository with more open PRs than this simply has the excess
	 * invisible to worktree selection; the checkout's own PR read is unaffected.
	 */
	prListLimit: 50,
	/**
	 * Worktree-aware status: "auto" lets a SESSION-targeted badge follow the one
	 * linked worktree whose branch has an open PR, so a conversation doing its
	 * work in a worktree reports that tree instead of the main checkout its
	 * directory names; "off" always reports the session's own directory. A
	 * workspace-targeted row never follows a worktree whatever this is set to — a
	 * row surveys the checkout the registry owns. See effectiveTarget.
	 */
	worktreeStatus: "auto"
};

/**
 * Run an external command in a directory. Resolves { stdout } on success; on
 * failure { stdout: null } plus exactly one of: timeout (execFile timeout kill),
 * missing (no such binary), or exitCode (the command ran and rejected — e.g.
 * "not a repository", or `gh` reporting no pull request).
 *
 * The exitCode/timeout/missing trichotomy is what lets a CALLER tell a
 * definitive answer from a transient one: a missing `gh` and a `gh` that says
 * "no PR" are different facts, and only the caller knows which of them it can
 * act on. Shared by git and `gh` so neither grows its own timeout semantics.
 */
function runCli(cmd, args, opts) {
	const { cwd, env, timeout = config.gitTimeoutMs } = opts ?? {};
	// env is a full replacement for execFile; overlay onto process.env so
	// PATH/HOME (credential helpers, global config) survive
	const fullEnv = env === void 0 ? void 0 : { ...process.env, ...env };
	return new Promise((resolve) => {
		execFile(cmd, args, { cwd, timeout, env: fullEnv }, (error, stdout) => {
			if (error === void 0 || error === null) resolve({ stdout: String(stdout) });
			else if (error.killed) resolve({ stdout: null, timeout: true });
			else if (error.code === "ENOENT") resolve({ stdout: null, missing: true });
			else resolve({ stdout: null, exitCode: error.code });
		});
	});
}

/**
 * Run git in dir. A thin specialization of runCli: the contract above is
 * unchanged, and `config.gitRunner` still substitutes for the whole call so the
 * suite can force the timeout branch.
 */
function runGit(dir, args, opts) {
	return runCli("git", args, { ...opts, cwd: dir });
}

/** Marker response for a git invocation that failed or timed out (transient). */
const GIT_DEGRADED = { git: false, error: "git unavailable (timeout or failure)" };

/**
 * One in-flight run per key, with optional TTL rate-limiting — the shape every
 * cache in this half needs, written once. A caller that arrives while a run is
 * in flight shares its promise instead of stampeding, and one whose record is
 * fresher than `ttlMs` is served from the record instead of starting a new
 * run. The store maps key -> { lastAttemptAt, inFlight, value }: `value` is
 * the last settled answer, kept only when `keepValue` so a lapsed caller can
 * be served the PREVIOUS answer while a refresh runs; `run(record)` receives
 * the record (its `value` is that previous answer) and resolves to the next
 * one. TTL-less stores drop the record when the run settles; a failed run is
 * not remembered except as a TTL'd store's attempt time, which rate-limits
 * the retry. `serve` decides what a busy-or-fresh call returns (default: the
 * in-flight promise, or the kept value).
 */
function singleFlight(store, key, { ttlMs = 0, keepValue = false, serve }, run) {
	const previous = store.get(key);
	if (previous !== void 0 && (previous.inFlight !== null || Date.now() - previous.lastAttemptAt < ttlMs)) {
		return serve !== void 0 ? serve(previous) : keepValue ? previous.value : previous.inFlight;
	}
	const record = { lastAttemptAt: Date.now(), inFlight: null, value: keepValue ? previous?.value : void 0 };
	record.inFlight = (async () => {
		try {
			const value = await run(record);
			if (keepValue) record.value = value;
			return value;
		} finally {
			record.lastAttemptAt = Date.now();
			record.inFlight = null;
			if (ttlMs === 0) store.delete(key);
		}
	})();
	store.set(key, record);
	return keepValue ? record.value : record.inFlight;
}

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
/**
 * toplevel -> { at, value } for the repository's default branch name ("main"),
 * resolved from `refs/remotes/origin/HEAD`. Read on the HOT path and refreshed
 * out of band, exactly like the fetch: a status call must never pay a process
 * for it, so the first request after a cache miss simply answers without the
 * flag and the next one carries it.
 */
const defaultBranchState = new Map();

/** The cached default branch, kicking a refresh when stale. Never throws. */
function defaultBranchFor(toplevel, notify) {
	return singleFlight(defaultBranchState, toplevel, {
		ttlMs: config.defaultBranchTtlMs,
		keepValue: true,
		serve: (state) => state.value
	}, async (record) => {
		const out = await runGit(toplevel, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
		const name = out.stdout === null ? "" : out.stdout.trim().replace(/^origin\//u, "");
		const value = name === "" ? void 0 : name;
		if (record.value !== value) notify?.();
		return value;
	});
}

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
	return singleFlight(fetchState, toplevel, {
		ttlMs: config.fetchTtlMs,
		// a lapsed-but-idle caller is served "nothing fetched"; only an in-flight
		// fetch is worth sharing
		serve: (state) => (state.inFlight ?? false)
	}, async () => {
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
		return out.stdout !== null;
	});
}
//#endregion

//#region PR / CI status (gh)
/**
 * GitHub pull-request and check state for the current branch, read through the
 * user's own `gh` CLI.
 *
 * Why the CLI and not the REST API: `gh` already owns the user's credentials in
 * its own config, so this plugin never reads, stores, caches or forwards a
 * token. There is no secret here to leak and no OAuth flow to maintain — and a
 * machine that has never authenticated `gh` simply gets no PR token.
 *
 * Degradation is a MISSING FIELD, never an error. A machine without `gh`, a
 * logged-out `gh`, a remote that is not GitHub, an offline network, a forge rate
 * limit, unparseable output and a timed-out call all produce exactly the same
 * response: no `pr` key at all. That is the honest answer, because in every one
 * of those cases the badge has nothing to say — and a caller that could tell
 * "no PR" from "no gh" would still not know what to draw.
 *
 * Like the fetch above this is TTL-bounded and NEVER awaited by the route: the
 * cached value is served immediately and a refresh that CHANGES it notifies
 * subscribers, so the request that lapses the window carries the previous answer
 * and the follow-up carries the new one. A forge round trip must never become
 * badge latency.
 */
/** toplevel -> { lastAttemptAt, inFlight, value }; `value` undefined = nothing to say. */
const prState = new Map();

/** Test seam: the CLI invoker `gh` calls go through, so no test needs `gh`. */
function runPrCli(cmd, args, opts) {
	return (config.prRunner ?? runCli)(cmd, args, opts);
}

/**
 * Does `origin` point at github.com? A cheap LOCAL call, so a non-GitHub repo
 * never pays for a `gh` process. Deliberately scoped to origin: that is the
 * remote `gh` itself resolves the repository from, so agreeing with it here is
 * what keeps the two from disagreeing later.
 */
async function originIsGitHub(toplevel) {
	const out = await runGit(toplevel, ["remote", "get-url", "origin"]);
	if (out.stdout === null) return false;
	return /(^|[/@.])github\.com[:/]/i.test(out.stdout.trim());
}

/**
 * Reduce a `statusCheckRollup` to ONE worst-case state, so the chip needs a
 * single colour rather than a list.
 *
 * Two entry shapes share the array: a CheckRun carries `status` + `conclusion`,
 * a StatusContext carries `state` alone. A single failure outweighs any number
 * of successes and pending checks — "mostly passing" is not a thing a red/green
 * token can express — so failure returns immediately and pending only wins over
 * an otherwise all-successful set.
 */
function summarizeChecks(checks) {
	let sawAny = false;
	let sawPending = false;
	for (const check of checks) {
		const state = String(check?.state ?? "").toUpperCase();
		const status = String(check?.status ?? "").toUpperCase();
		const conclusion = String(check?.conclusion ?? "").toUpperCase();
		sawAny = true;
		const failed =
			["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(state) ||
			["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(conclusion);
		if (failed) return "failing";
		// unfinished: a CheckRun that has not completed, or a StatusContext PENDING
		if (state === "PENDING" || (status !== "" && status !== "COMPLETED")) sawPending = true;
	}
	if (!sawAny) return "none";
	return sawPending ? "pending" : "passing";
}

/** The compact PR shape the chip renders, or undefined when there is nothing to say. */
function summarizePr(json) {
	if (json === null || typeof json !== "object") return void 0;
	const number = Number.isFinite(json?.number) ? json.number : void 0;
	if (number === void 0) return void 0;
	const pr = {
		number,
		state: summarizeChecks(Array.isArray(json.statusCheckRollup) ? json.statusCheckRollup : []),
		// draft and review state are separate from CI: a draft with green checks
		// is not ready, and a blocked review is not a failing build
		draft: json.isDraft === true,
		open: String(json.state ?? "OPEN").toUpperCase() === "OPEN"
	};
	// omitted, not present-and-undefined: absence is the contract for "nothing to
	// say" throughout this half, so a consumer tests the key, never the value
	if (typeof json.reviewDecision === "string" && json.reviewDecision !== "") pr.review = json.reviewDecision;
	// GitHub's OWN merge verdict (CLEAN / BLOCKED / BEHIND / DIRTY / DRAFT /
	// UNSTABLE / HAS_HOOKS / UNKNOWN), passed through rather than re-derived here:
	// whether a PR is mergeable depends on branch protection and required reviews,
	// which is the forge's business and not this plugin's to interpret. `gh pr list`
	// does not ask for it, so a worktree-candidate entry simply has no `mergeState`
	// — absence is the contract, as everywhere else in this half.
	if (typeof json.mergeStateStatus === "string" && json.mergeStateStatus !== "") pr.mergeState = json.mergeStateStatus.toUpperCase();
	// The chip links the token to the PR, so `url` is the one field that becomes an
	// `href`: only http(s) is emitted, and anything else is omitted like every
	// other "nothing to say" field, so a payload value cannot reach an anchor as a
	// `javascript:` URL. The client re-checks before it builds the href — this half
	// is the authority on what it vouches for, not the only guard.
	if (typeof json.url === "string" && json.url !== "") {
		try {
			const { protocol } = new URL(json.url);
			if (protocol === "http:" || protocol === "https:") pr.url = json.url;
		} catch {
			// not a URL at all — omitted, exactly like an absent one
		}
	}
	return pr;
}

/**
 * Read PR state for `branch`, or undefined. NEVER throws and never rejects: a
 * forge is an optional luxury, so every failure path is "nothing to say".
 */
async function readPrStatus(toplevel, branch) {
	// a detached HEAD is not a branch `gh` can resolve a PR for
	if (typeof branch !== "string" || branch === "" || branch.startsWith("HEAD")) return void 0;
	if (!(await originIsGitHub(toplevel))) return void 0;
	const out = await runPrCli("gh", ["pr", "view", branch, "--json", "number,state,isDraft,reviewDecision,statusCheckRollup,url,mergeStateStatus"], {
		cwd: toplevel,
		timeout: config.prTimeoutMs,
		// GH_PROMPT_DISABLED: an auth prompt must never hang the refresh (the gh
		// analogue of the git fetch's GIT_TERMINAL_PROMPT=0). The pager vars keep
		// gh from waiting on a pager that will never answer, and NO_COLOR keeps
		// escape codes out of the JSON.
		env: { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_PAGER: "cat", NO_COLOR: "1" }
	});
	if (out.stdout === null) return void 0;
	let json;
	try {
		json = JSON.parse(out.stdout);
	} catch {
		return void 0;
	}
	return summarizePr(json);
}


/** Order-insensitive identity for an open-PR set, so "did it change?" is exact. */
function prListKey(byBranch) {
	if (byBranch === void 0) return "";
	return JSON.stringify([...byBranch].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * PR state for toplevel: the value to serve NOW (possibly undefined, possibly
 * stale), spawning an out-of-band refresh when the TTL has lapsed. `notify` is
 * called only when the refreshed value CHANGES, so an unchanged answer costs one
 * forge call per TTL and zero SSE traffic.
 *
 * Keyed by BRANCH as well as toplevel: a checkout inside the TTL window would
 * otherwise be served the PR of the branch it was on when the window opened.
 */
function prStatusFor(toplevel, branch, notify) {
	if (config.prStatus === "off") return void 0;
	const key = toplevel + "\u0000" + branch;
	return singleFlight(prState, key, {
		ttlMs: config.prTtlMs,
		keepValue: true,
		// the previous answer is served while a refresh runs, so a forge round
		// trip is never route latency
		serve: (state) => state.value
	}, async (record) => {
		const value = await readPrStatus(toplevel, branch).catch(() => void 0);
		const changed = JSON.stringify(record.value ?? null) !== JSON.stringify(value ?? null);
		if (changed) notify(toplevel);
		return value;
	});
}
//#endregion

/**
 * Parse `git status --porcelain=v2 --branch` output.
 * Headers: `# branch.head <name>` (or `(detached)`), `# branch.upstream
 * <name>`, `# branch.ab +ahead -behind`. Records per path: `1`/`2` carry the
 * two-column XY status (X = index/staged, Y = worktree), `u` unmerged,
 * `?` untracked.
 */
/** Relative path shortened to its last two segments — the hover-name contract. */
function shortenPath(name) {
	const parts = name.split("/");
	return parts.length <= 2 ? name : parts.slice(-2).join("/");
}

/**
 * Convert a remote URL to the hosted repo's WEB root: https stays https,
 * `git@host:path` ssh syntax converts, a `.git` suffix is stripped. Null when
 * the URL is neither form — the caller decides what a null is worth.
 */
function remoteToWebUrl(raw) {
	const trimmed = raw.trim().replace(/\.git$/u, "");
	const https = trimmed.match(/^https:\/\/([^/]+)\/(.+?)\/?$/u);
	const ssh = trimmed.match(/^[^@]+@([^:]+):(.+)$/u);
	const web = https !== null ? https[1] + "/" + https[2] : ssh !== null ? ssh[1] + "/" + ssh[2] : null;
	if (web === null) return null;
	try {
		const url = new URL("https://" + web);
		if (url.protocol === "https:" && url.pathname.length > 1) return url.origin + url.pathname.replace(/\/$/u, "");
	} catch {
		// not a URL we can vouch for
	}
	return null;
}

function parseStatusV2(out) {
	let branch = "HEAD (detached)";
	let upstream;
	let ahead;
	let behind;
	let staged = 0;
	let unstaged = 0;
	let unmerged = 0;
	let untracked = 0;
	const untrackedNames = [];
	const unstagedNames = [];
	const stagedNames = [];
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
			if (line[2] !== ".") {
				staged += 1;
				const path = line.startsWith("2 ")
					? line.split("\t").pop().trim()
					: line.split(" ").slice(8).join(" ").trim();
				if (path !== "") stagedNames.push(path);
			}
			if (line[3] !== ".") {
				unstaged += 1;
				// the path is the LAST field in both records (space-separated, and
				// the path itself may contain spaces) — collected untruncated and
				// capped by the caller, exactly like the untracked names
				const path = line.startsWith("2 ")
					? line.split("\t").pop().trim()
					: line.split(" ").slice(8).join(" ").trim();
				if (path !== "") unstagedNames.push(path);
			}
		} else if (line.startsWith("u ")) unmerged += 1;
		else if (line.startsWith("? ")) {
			untracked += 1;
			// `-uall` prints one `? <path>` per untracked FILE, so the names are
			// the lines themselves — collected untruncated here and capped by the
			// caller, so the hover's "and k more" arithmetic stays honest.
			const name = line.slice(2).trim();
			if (name !== "") untrackedNames.push(name);
		}
	}
	return { branch, upstream, ahead, behind, staged, unstaged, unmerged, untracked, untrackedNames, unstagedNames, stagedNames };
}

/**
 * Parse `git worktree list --porcelain`. Blocks of `key value` lines separated by
 * a blank line: `worktree <path>`, `HEAD <sha>`, `branch refs/heads/<name>` (the
 * line is ABSENT when the entry is detached), and the flag lines `bare`, `locked`
 * and `prunable`, which may carry a reason after the key.
 *
 * The last field is the checkout's directory NAME, which is all the badge ever
 * reports — never the path (AGENTS.md rule 7). Git prints the main worktree first,
 * but the caller identifies the checkout it is standing in by comparing `path`
 * against its own toplevel rather than by list position.
 */
function parseWorktreeList(stdout) {
	const entries = [];
	let entry = null;
	const flush = () => {
		if (entry !== null) entries.push({ ...entry, name: basename(entry.path) });
		entry = null;
	};
	for (const raw of String(stdout ?? "").split("\n")) {
		const line = raw.trim();
		if (line === "") {
			flush();
			continue;
		}
		const at = line.indexOf(" ");
		const key = at === -1 ? line : line.slice(0, at);
		const value = at === -1 ? "" : line.slice(at + 1);
		if (key === "worktree") {
			flush();
			entry = { path: value, head: "", branch: void 0, detached: false, bare: false, locked: false, prunable: false };
			continue;
		}
		if (entry === null) continue;
		if (key === "HEAD") entry.head = value;
		else if (key === "branch") entry.branch = value.replace(/^refs\/heads\//, "");
		else if (key === "detached") entry.detached = true;
		else if (key === "bare") entry.bare = true;
		else if (key === "locked") entry.locked = true;
		else if (key === "prunable") entry.prunable = true;
	}
	flush();
	return entries;
}

/**
 * The worktree landscape of the repository `dir` sits in: its toplevel in GIT's
 * own spelling (so it compares exactly against the listed paths, with no
 * spelling guesswork) and every worktree of that repository, main one included.
 *
 * Two cheap local invocations. A failure of either degrades to "no linked
 * worktrees", which leaves the badge on the directory the session actually names
 * rather than substituting a guess.
 */
async function readWorktrees(dir) {
	const top = await runGit(dir, ["rev-parse", "--show-toplevel"]);
	const toplevel = top.stdout === null ? "" : top.stdout.trim();
	if (toplevel === "") return { toplevel: "", worktrees: [] };
	const list = await runGit(dir, ["worktree", "list", "--porcelain"]);
	return { toplevel, worktrees: list.stdout === null ? [] : parseWorktreeList(list.stdout) };
}

/** In-flight worktree probes, so a burst of callers shares one pair of calls. */
const worktreeInFlight = new Map();

/**
 * `readWorktrees` with identical CONCURRENT calls collapsed, the same way
 * `gitStatus` collapses status reads: every session row of one workspace probes
 * the same directory at the same moment. Deliberately no TTL — the probe is two
 * local git calls, and a worktree created a moment ago must be visible at once.
 */
function worktreesFor(dir) {
	return singleFlight(worktreeInFlight, dir, {}, () => readWorktrees(dir));
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
 * The one command a paused operation resumes with. A squash merge records no
 * MERGE_HEAD (its conclusion is an ordinary commit), and bisect's next step is
 * the user's judgement call (good/bad) — it gets a WHY but no command.
 */
const OPERATION_NEXT = {
	merge: "git merge --continue",
	squash: "git commit",
	"cherry-pick": "git cherry-pick --continue",
	revert: "git revert --continue",
	rebase: "git rebase --continue",
	sequencer: "git cherry-pick --continue",
	bisect: void 0
};

/**
 * The configurable action ranking. Every rule carries a category; the order
 * below (first match wins) is the default, and a user can override it by
 * naming categories in `~/.dsh/git-badge-next.json`:
 *
 *   { "order": ["operation", "unmerged", "sync", "publish", "merge", "commit", "checks"] }
 *
 * Any subset in any order; categories not listed rank after the listed ones in
 * default order, unknown names are ignored. Typically edited for you by the
 * agent via `/gh order`.
 */
const DEFAULT_NEXT_ORDER = ["operation", "unmerged", "sync", "publish", "merge", "commit", "checks"];

/** Normalise any order list: known categories first, then the rest in default order. */
function normalizeOrder(order) {
	if (!Array.isArray(order)) return DEFAULT_NEXT_ORDER;
	const known = order.filter((cat) => DEFAULT_NEXT_ORDER.includes(cat));
	return [...known, ...DEFAULT_NEXT_ORDER.filter((cat) => !known.includes(cat))];
}

/** The settings namespace this plugin owns — its order lives there, live. */
const SETTINGS_NS = "git-badge";

/**
 * The namespace schema, built from the host-provided schema lib — imported
 * LAZILY because this plugin's module graph must load without it (the test
 * suite runs from a bare checkout, and a host without the settings stack should
 * lose only the settings card, never the badge).
 */
function orderSettingsSchema(Schema) {
	return Schema.object({
		order: Schema.array(Schema.union(DEFAULT_NEXT_ORDER)).default(DEFAULT_NEXT_ORDER)
	});
}

/**
 * The pre-settings override file. Still honoured as the namespace's BASE (a
 * composition default, so a user who configured the JSON keeps their order
 * after the upgrade) and as a fallback when the settings service is absent.
 */
function legacyOrderFile() {
	try {
		const home = process.env.DSH_HOME || join(process.env.HOME || "", ".dsh");
		const raw = JSON.parse(readFileSync(join(home, "git-badge-next.json"), "utf8"));
		return normalizeOrder(raw?.order);
	} catch {
		return DEFAULT_NEXT_ORDER;
	}
}

/**
 * The live order — one in-memory value, updated by the settings scope. It is
 * authoritative only once the namespace actually registered; until then (and on
 * a host without the settings stack, or in a unit test that never calls apply)
 * the legacy file is read per call, which is the pre-settings behaviour.
 */
let currentOrder = DEFAULT_NEXT_ORDER;
let settingsOrderActive = false;

/** The ranking order every status read uses. */
function nextOrder() {
	return settingsOrderActive ? currentOrder : legacyOrderFile();
}

/**
 * The hover card's "action" row and the (+) menu's picker: every sub-action the
 * checkout justifies, each as a `gh`-skill invocation ({ args, why, what } —
 * what the invocation DOES, why THIS checkout justifies it now), ranked. Pure
 * derivation over fields the status response already carries — no extra git
 * invocations, so it rides the base response.
 *
 * Ranking: rule candidates are collected with a category, then sorted by the
 * configured order (nextOrder) — NOT first-match — so a configuration can, for
 * example, rank "commit" above "sync" without touching code. Ties keep
 * collection order.
 *
 * The new rules this generation adds:
 *   - diverged (ahead AND behind) → `sync`: reconciling means rebase-then-push,
 *     which the agent must confirm step by step — a plain pull would discard
 *     the local-commit context
 *   - merge-ready (`pr.mergeState === "CLEAN"`, GitHub's own verdict, or checks
 *     passing + review approved) → `merge <n>`: the endgame action the old
 *     table could never see
 *
 * Clean, synced, nothing failing → null: the row is omitted entirely, because
 * "no suggestion" is also a suggestion.
 *
 * @returns {{ args: string, command: string|undefined, why: string, what: string } | null}
 */
function nextStepRules(info) {
	if (info === void 0 || info === null || info.git !== true) return null;
	const unmerged = info.unmergedFiles || 0;
	const plural = (n) => (n === 1 ? "" : "s");
	const ahead = info.ahead || 0;
	const behind = info.behind || 0;
	const staged = info.stagedFiles || 0;
	const unstaged = info.unstagedFiles || 0;
	const untracked = info.untrackedFiles || 0;
	const dirty = staged + unstaged + untracked;
	const rules = [];
	const add = (cat, args, why, what, command) => rules.push({ cat, args, why, what, command });

	if (info.operation !== void 0 && info.operation !== null) {
		const op = String(info.operation);
		add("operation", "next",
			unmerged > 0
				? `${unmerged} unmerged file${plural(unmerged)} blocking the paused ${op}`
				: `a ${op} is paused mid-operation`,
			`resume the paused ${op}`,
			OPERATION_NEXT[op]);
	}
	if (unmerged > 0) {
		add("unmerged", "next", `${unmerged} unmerged file${plural(unmerged)} to resolve`, "resolve the unmerged files (with you)", "git status");
	}
	if (behind > 0 && ahead > 0) {
		add("sync", "sync", `${ahead} ahead, ${behind} behind — diverged`, "rebase your commits onto upstream and push (asks before any force)");
	} else if (behind > 0) {
		add("sync", "pull", `${behind} behind ${info.upstream ?? "upstream"}`, "update this branch from upstream", "git pull --ff-only");
	}
	if (info.upstream === void 0 && dirty > 0) {
		add("publish", "push", "no upstream configured", `publish ${info.branch} for the first time`, `git push -u origin ${info.branch}`);
	} else if (ahead > 0) {
		add("publish", "push", `${ahead} ahead of ${info.upstream ?? "upstream"}`, "push local commits to the remote", "git push");
	}
	const pr = info.pr === void 0 || info.pr === null ? void 0 : info.pr;
	if (pr !== void 0 && pr.number !== void 0 && pr.open !== false
		&& (pr.mergeState === "CLEAN" || (pr.state === "passing" && pr.review === "APPROVED"))) {
		add("merge", `merge ${pr.number}`, `pull request ${pr.number} is ready to merge`, `merge pull request ${pr.number} (squash)`);
	}
	if (dirty > 0) {
		const parts = [
			staged > 0 ? `${staged} staged` : null,
			unstaged > 0 ? `${unstaged} unstaged` : null,
			untracked > 0 ? `${untracked} untracked` : null
		].filter(Boolean).join(", ");
		const command = staged > 0
			? "git commit"
			: untracked > 0 && unstaged === 0
				? "git add -A && git commit"
				: "git add -p && git commit";
		add("commit", "commit", `work to commit: ${parts}`, staged > 0 ? "commit the staged changes" : "stage and commit the working changes", command);
	}
	if (pr !== void 0 && pr.number !== void 0 && pr.state === "failing") {
		add("checks", `checks ${pr.number}`, `checks failing on #${pr.number}`, "watch the CI checks on pull request " + pr.number, `gh pr checks ${pr.number} --watch`);
	}

	// STANDING options: never ranked, never the primary suggestion — they are
	// things you may do, not things the checkout is asking for. `pr view` exists
	// whenever a pull request does; `pr` (create) only for a pushed branch that
	// is not the default; `clean` last and flagged, because a destructive verb
	// whose intent git status cannot reveal must never be suggested.
	const standing = [];
	if (pr !== void 0 && pr.number !== void 0) {
		standing.push({
			args: `pr view ${pr.number}`,
			why: `open pull request #${pr.number}`,
			what: `show pull request ${pr.number} on GitHub`
		});
	} else if (ahead === 0 && behind === 0 && info.upstream !== void 0 && dirty === 0 && info.defaultBranch !== true) {
		standing.push({ args: "pr", why: "branch is pushed and has no pull request", what: "open a pull request for this branch" });
	}
	if (untracked > 0) {
		standing.push({
			args: "clean",
			why: `${untracked} untracked file${plural(untracked)}`,
			what: "remove untracked files — lists them and asks first",
			danger: true
		});
	}

	const order = nextOrder();
	const rank = (cat) => {
		const at = order.indexOf(cat);
		return at === -1 ? order.length : at;
	};
	const ranked = [...rules].sort((a, b) => rank(a.cat) - rank(b.cat)).slice(0, 5);
	return { ranked, standing };
}

/**
 * Every action the checkout justifies, in order — the ONE list both surfaces
 * render: the card shows the primary entry, the (+) picker lists them all.
 *
 * The server owns the whole list because both halves previously carried their
 * own copy of these conditions and drifted: the card promoted a client-only
 * extra into its action row, and `/gh pr` was offered on the default branch.
 * One authority, one list, no reconciliation.
 *
 * Exactly one entry can be `primary` (the top RANKED rule) or none at all —
 * a clean, synced checkout has actions (look at the PR, clean up) but no
 * suggestion, because "no suggestion" is also a suggestion.
 *
 * @returns {{ actions: Array<{args, why, what, command?, danger?, primary?}>, next: object|null }}
 */
function nextActions(info) {
	const built = nextStepRules(info);
	if (built === null) return { actions: [], next: null };
	const { ranked, standing } = built;
	const actions = [
		...ranked.map((rule, index) => ({
			args: rule.args,
			why: rule.why,
			what: rule.what,
			...(rule.command === void 0 ? {} : { command: rule.command }),
			...(index === 0 ? { primary: true } : {})
		})),
		...standing
	];
	const primary = actions.find((action) => action.primary === true) ?? null;
	return { actions, next: primary };
}

/**
 * The single ranked suggestion, or null — the card's action row and the legacy
 * shape. It is the primary entry of {@link nextActions}, never a standing
 * option.
 */
function nextStep(info) {
	return nextActions(info).next;
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
 * Worktree identity is reported, not assumed: `isWorktree` marks a linked
 * worktree and `worktreeName` names the checkout. A subdirectory of a linked
 * worktree reports that worktree (the toplevel walk starts above it), which is
 * the same whole-repository rule as above.
 *
 * `wantDetail` serves the input chip's HOVER CARD (recent commits + stash) and
 * `wantPr` its PR/CI token. They are asked for separately and by the chip only,
 * so neither is paid for by a sidebar row refresh: a row needs status and
 * identity, nothing more.
 */
async function gitStatusUncached(dir, wantDetail, wantPr) {
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
	// A linked worktree's git dir carries a `commondir` file pointing back at
	// the shared git dir; a main worktree's does not. Stat'ing it costs nothing
	// extra — `gitDir` came from the invocation above. A submodule also has an
	// out-of-tree git dir but no `commondir`, so it is correctly NOT a worktree.
	const isWorktree = existsSync(join(gitDir, "commondir"));
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
		isWorktree,
		// the checkout's own directory name (of the worktree root, so a
		// subdirectory workspace still names the checkout it belongs to)
		worktreeName: basename(toplevel),
		ahead: parsed.ahead,
		behind: parsed.behind
	};
	// Is this the repository's DEFAULT branch? main/master with no pull request
	// is that branch's normal state, and "open a pull request for this branch" is
	// nonsense there, so the surfaces suppress it. Cached and refreshed out of
	// band: the flag may be absent on the very first read, present on the next.
	const defaultBranch = defaultBranchFor(toplevel, notifyChange);
	if (defaultBranch !== void 0 && defaultBranch === parsed.branch) info.defaultBranch = true;
	// Resolved inside the detail block; the PR-token hover below reuses it, so it
	// is declared here rather than scoped to that block.
	let baseRef = null;
	if (wantDetail) {
		// The ✎n NAMES — the one part of the count the numbers cannot answer
		// ("what are these?"). Hover-gated with the rest of detail=1, so no
		// refresh pays for it. Posture: RELATIVE names only (git's own output,
		// never absolute — AGENTS.md rule 7 is relaxed by an inch, not a mile),
		// shortened to the last two path segments, capped at 20 with the total
		// carried separately so the client can say "… and k more" honestly.
		// Staged and unstaged names are TRACKED files: the collapsed untracked
		// retry never affects them, so they ride regardless of untrackedMode.
		const capped = (names) => names.slice(0, 20).map(shortenPath);
		if (untrackedMode === "all" && parsed.untrackedNames.length > 0) {
			info.untrackedNames = capped(parsed.untrackedNames);
			info.untrackedNamesTotal = parsed.untrackedNames.length;
		}
		if (parsed.unstagedNames.length > 0) {
			info.unstagedNames = capped(parsed.unstagedNames);
			info.unstagedNamesTotal = parsed.unstagedNames.length;
		}
		if (parsed.stagedNames.length > 0) {
			info.stagedNames = capped(parsed.stagedNames);
			info.stagedNamesTotal = parsed.stagedNames.length;
		}
		// The signed commit list and the counts-vs-main row: ahead/behind against origin/main (then
		// origin/master) is the merge-state line — "3 ahead, 0 behind" reads as
		// "this is the PR's content"; "0 ahead, 5 behind" as "stale, rebase
		// first". One rev-list --left-right, hover-gated like everything here,
		// absent entirely when both are zero (in sync needs no row).
		// The repo's WEB URL — the branch hover links the branch name to the
		// compare view (`<repo>/compare/<base>...<branch>`), and that URL must be
		// vouched for like pr.url is: http(s) only, rebuilt from the parsed parts
		// so no payload value can reach an anchor as a scheme. Derived from
		// `remote get-url origin` with ssh syntax converted; absent when there is
		// no origin or the URL is not recognisably a hosted repo.
		// These reads are independent — one batch, so hover latency is the
		// longest call rather than their sum. `logHead` is the plain HEAD log
		// the no-base-branch fallback below serves as the branch's commit list;
		// the only dependent calls (the left-right count and the signed log both
		// need a probed base ref) run after the batch and tolerate failure.
		const [remoteUrl, probeMain, probeMaster, logHead, stashOut] = await Promise.all([
			runGit(toplevel, ["remote", "get-url", "origin"]),
			runGit(toplevel, ["rev-parse", "--verify", "--quiet", "origin/main"]),
			runGit(toplevel, ["rev-parse", "--verify", "--quiet", "origin/master"]),
			runGit(toplevel, ["log", "-10", "--format=%h%x09%s%x09%cr", "HEAD"]),
			runGit(toplevel, ["stash", "list"])
		]);
		if (remoteUrl.stdout !== null && remoteUrl.stdout.trim() !== "") {
			info.repoUrl = remoteToWebUrl(remoteUrl.stdout);
		}
		baseRef = probeMain.stdout !== null && probeMain.stdout.trim() !== ""
			? "origin/main"
			: probeMaster.stdout !== null && probeMaster.stdout.trim() !== "" ? "origin/master" : null;
		if (baseRef !== null && info.repoUrl !== void 0) {
			const baseName = baseRef.replace(/^origin\//u, "");
			try {
				const compare = new URL(info.repoUrl + "/compare/" + encodeURIComponent(baseName) + "..." + encodeURIComponent(info.branch));
				if (compare.protocol === "https:") info.compareUrl = compare.href;
			} catch {
				// absent rather than wrong
			}
		}
		if (baseRef !== null) {
			const lrOut = await runGit(toplevel, ["rev-list", "--count", "--left-right", baseRef + "...HEAD"]);
			const [mBehind, mAhead] = (lrOut.stdout ?? "").trim().split("\t").map((v) => Number.parseInt(v, 10));
			if (Number.isFinite(mBehind) && Number.isFinite(mAhead) && (mBehind > 0 || mAhead > 0)) {
				info.mainAhead = mAhead;
				info.mainBehind = mBehind;
			}
		}
		if (baseRef !== null) {
			// The signed commit list: mixed newest-first from base...HEAD, each
			// entry signed "+" (only on this branch - the PR's content) or "−"
			// (only on main - what a rebase/merge brings in), git's own left-right
			// verdict mapped onto the diff convention. Capped at 10 with the total
			// from the same base so "... and k more" counts both sides. Without a
			// default branch the list degrades to the plain last 10 on HEAD.
			const signedOut = await runGit(toplevel, ["log", "--left-right", "-10", "--format=%m%x09%h%x09%s%x09%cr", baseRef + "...HEAD"]);
			if (signedOut.stdout !== null && signedOut.stdout.trim() !== "") {
				info.branchCommits = signedOut.stdout.trim().split("\n").map((line) => {
					const [marker, hash, subject, when] = line.split("\t");
					return {
						sign: marker === ">" ? "+" : marker === "<" ? "−" : void 0,
						hash,
						subject: subject ?? "",
						when: when ?? ""
					};
				}).filter((c) => c.hash !== void 0);
				const totalOut = await runGit(toplevel, ["rev-list", "--count", baseRef + "...HEAD"]);
				const total = Number.parseInt((totalOut.stdout ?? "").trim(), 10);
				if (Number.isFinite(total)) info.branchCommitsTotal = total;
			}
		} else {
			// already fetched in the batch above — no second invocation
			if (logHead.stdout !== null && logHead.stdout.trim() !== "") {
				info.branchCommits = logHead.stdout.trim().split("\n").map((line) => {
					const [hash, subject, when] = line.split("\t");
					return { hash, subject: subject ?? "", when: when ?? "" };
				}).filter((c) => c.hash !== void 0);
			}
		}
		if (stashOut.stdout !== null) {
			const count = stashOut.stdout.split("\n").filter((l) => l.trim() !== "").length;
			if (count > 0) info.stashCount = count;
		}
	}
	// PR / CI is the INPUT CHIP's business, so it is asked for explicitly
	// (`?pr=1`) rather than paid for by every sidebar row: a row that surveys
	// twenty workspaces must not spawn twenty forge processes. Served from the
	// TTL cache and refreshed out of band, exactly like the fetch above — the
	// forge round trip is never route latency.
	if (wantPr) {
		const pr = prStatusFor(toplevel, parsed.branch, notifyChange);
		if (pr !== void 0) info.pr = pr;
	}
	if (baseRef !== null && info.pr !== void 0 && info.pr !== null && info.pr.number !== void 0
		&& info.pr.open !== false && (info.mainAhead || 0) > 0) {
		// The PR's OWN commits (base..HEAD) — the token's hover answers "what is in
		// this pull request", so it lists exactly that: not the branch's recent
		// history, nothing else. Hover-gated with the rest of detail=1, and the
		// total is the ahead count already computed above (no second rev-list).
		const prOut = await runGit(toplevel, ["log", "-10", "--format=%h%x09%s%x09%cr", baseRef + "..HEAD"]);
		if (prOut.stdout !== null && prOut.stdout.trim() !== "") {
			info.prCommits = prOut.stdout.trim().split("\n").map((line) => {
				const [hash, subject, when] = line.split("\t");
				return { hash, subject: subject ?? "", when: when ?? "" };
			}).filter((c) => c.hash !== void 0);
			info.prCommitsTotal = info.mainAhead;
		}
	}
	// The ranked suggestion rides EVERY response (it is pure derivation, and a
	// sidebar row may one day use it instead of its own copy of these rules);
	// the full action list is sent only for `pr=1`, the surfaces that have a
	// picker, so a row's payload stays lean.
	const { actions, next } = nextActions(info);
	if (next !== null) info.next = next;
	if (wantPr && actions.length > 0) info.actions = actions;
	return info;
}

/** In-flight status reads, so N callers asking at once share one `git status`. */
const statusInFlight = new Map();

/**
 * Status for dir, with identical CONCURRENT reads collapsed into one. That is the
 * shape a burst of sidebar session rows produces when they mount together: N rows
 * of one workspace resolve to the same directory, and without this they would run
 * N `git status` walks of the same tree at the same instant. Deliberately NO
 * completed-read cache: one that outlived the call would let a caller that
 * mutates a repository and asks again read a stale answer, and correctness of a
 * *status* badge outranks saving a walk.
 */
function gitStatus(dir, wantDetail, wantPr) {
	const key = dir + "\u0000" + (wantDetail === true) + "\u0000" + (wantPr === true);
	return singleFlight(statusInFlight, key, {}, () => gitStatusUncached(dir, wantDetail, wantPr));
}

//#region git-state watcher
/**
 * One recursive watcher per workspace, plus a second one when the git dir lives
 * outside the workspace (a linked worktree). Any event under either (HEAD swap,
 * index write, ref update, worktree save) marks the workspace dirty; a 200ms
 * debounce collapses burst events (a single `git commit` touches index, refs,
 * COMMIT_EDITMSG, objects…) into one notification.
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

/**
 * Close every watcher attached to a record, leaving the record itself in place
 * — the retry backoff and the degraded poll live on it. Tolerates a record
 * whose watchers were never established, so every record shape is safe.
 */
function closeWatchers(record) {
	for (const watcher of [record.watcher, record.extra]) {
		if (watcher === null || watcher === void 0) continue;
		try {
			watcher.close();
		} catch {
			/* already closed */
		}
	}
	record.watcher = null;
	if ("extra" in record) record.extra = null;
}

function unwatchWorkspace(key) {
	const record = watchers.get(key);
	if (record === void 0) return;
	watchers.delete(key);
	closeWatchers(record);
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

/**
 * The out-of-tree git dir for a workspace whose `.git` is a FILE rather than a
 * directory — a linked worktree (`<main>/.git/worktrees/<name>`) or a submodule
 * (`<parent>/.git/modules/<name>`). Git writes the index, HEAD and reflogs
 * THERE, so a watcher on the worktree root alone never sees a stage, commit or
 * checkout in a linked worktree; it only ever catches file edits. (Symptom
 * before this fix: a worktree's badge moved only on a save or the client's 60s
 * poll, never on commit.) Reading the gitfile mirrors git's own resolution,
 * costs one small read at watch setup rather than another `rev-parse`, and stays
 * correct for submodules. Returns null for a main worktree, whose `.git` is a
 * directory already covered by the root watch.
 */
function outerGitDir(root) {
	let content;
	try {
		// Reading the DIRECTORY `.git` of a main worktree raises EISDIR, which is
		// the "no out-of-tree git dir" answer; a `.git` symlink to a gitfile
		// still reads, where an isFile() stat would have followed it instead.
		content = readFileSync(join(root, ".git"), "utf8");
	} catch {
		return null;
	}
	const match = /^gitdir:\s*(.+?)\s*$/m.exec(content);
	if (match === null) return null;
	const target = match[1];
	return isAbsolute(target) ? target : resolve(root, target);
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
		watchers.set(key, { watcher: null, extra: null, failedAt: Date.now(), timer: void 0, workspaceId });
		return;
	}
	// Both watchers share one debounce and one failure path. Either dying means
	// this workspace can no longer be trusted to be event-driven, so both are
	// dropped and the degraded poll covers it until the retry backoff
	// re-establishes them.
	const onEvent = () => {
		const record = watchers.get(key);
		if (record === void 0) return;
		clearTimeout(record.timer);
		record.timer = setTimeout(() => notifyChange(key), config.debounceMs);
	};
	const onError = () => {
		// The watcher died after being established (inotify budget, tree
		// replaced, permissions). Drop it, but KEEP the record so the retry
		// backoff and the degraded poll both have somewhere to live — and
		// start polling so this workspace stays fresh in the meantime.
		const current = watchers.get(key);
		if (current === void 0) return;
		closeWatchers(current);
		current.failedAt = Date.now();
		startFallbackPoll(key, root);
	};
	try {
		// Watch the whole worktree: worktree edits (the most common dirty signal)
		// surface here and the debounce collapses save bursts. In a MAIN worktree
		// this covers git metadata too, because its git dir IS `<root>/.git`.
		const watcher = watch(root, { recursive: true }, onEvent);
		watcher.on("error", onError);
		// A linked worktree's git dir is OUTSIDE root, so staging, committing and
		// checking out there write nothing this watch can see. Watch it too; if it
		// cannot be watched the root watch still covers file edits, and the
		// degraded poll is not started for a merely partial loss.
		const gitDir = outerGitDir(root);
		let extra = null;
		if (gitDir !== null) {
			try {
				extra = watch(gitDir, { recursive: true }, onEvent);
				extra.on("error", onError);
			} catch {
				extra = null;
			}
		}
		watchers.set(key, { watcher, extra, timer: void 0, workspaceId });
	} catch {
		// watch refused (permissions, watch budget) — back off AND poll: this
		// repository is real, just unwatchable
		watchers.set(key, { watcher: null, extra: null, failedAt: Date.now(), timer: void 0, workspaceId });
		startFallbackPoll(key, root);
	}
}

/**
 * Workspace path -> { worktreePath, workspaceId, owned } for the worktree a
 * session badge is currently following. One per workspace: a session follows at
 * most one tree, so following a different tree (or none) retires the previous
 * entry here.
 */
const selectedWorktrees = new Map();

/**
 * Keep the watcher set aligned with the worktree a session badge has been told to
 * follow.
 *
 * A selected worktree is usually NOT a registered workspace, so nothing else
 * watches it — and freshness would then depend on the owning checkout's recursive
 * watch happening to cover it (true for a worktree nested inside the repository,
 * false for a sibling directory). Its events must also carry the OWNING workspace
 * id, because that is what a session-targeted client matches its events against:
 * `notifyChange` reads the id off the watcher record for the path it watched.
 *
 * `owned` records whether this call created the watcher. A worktree can itself be
 * a registered workspace (someone may have opened one as a workspace), and
 * retiring the selection must never tear down a watcher the registry owns.
 *
 * Idempotent and cheap: called on every session request, and a no-op while the
 * selection is unchanged. `chosenPath === undefined` retires whatever was
 * selected — the "the worktree is gone, or its PR closed" path.
 */
function selectWorktreeWatch(ownerPath, workspaceId, chosenPath) {
	const previous = selectedWorktrees.get(ownerPath);
	if (previous !== void 0 && previous.worktreePath === chosenPath) {
		previous.workspaceId = workspaceId;
		return;
	}
	if (previous !== void 0) {
		if (previous.owned) unwatchWorkspace(previous.worktreePath);
		selectedWorktrees.delete(ownerPath);
	}
	if (chosenPath === undefined) return;
	const owned = !watchers.has(chosenPath);
	watchWorkspace(chosenPath, chosenPath, workspaceId);
	selectedWorktrees.set(ownerPath, { worktreePath: chosenPath, workspaceId, owned });
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
	// An inferred worktree is watched because a session request selected it, not
	// because the registry owns it. Keep the ones whose owner is still registered
	// and retire the rest, so this reconcile never tears down a live selection.
	for (const [ownerPath, entry] of selectedWorktrees) {
		if (!wanted.has(ownerPath)) {
			if (entry.owned) unwatchWorkspace(entry.worktreePath);
			selectedWorktrees.delete(ownerPath);
			continue;
		}
		wanted.add(entry.worktreePath);
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

/**
 * The checkout a session registered for itself, or undefined.
 *
 * This is the ONLY source for "which worktree is this session using", and it has
 * to be explicit: DSH records no session→worktree link (a session's cwd is
 * immutable creation metadata and always the main checkout), so nothing in the
 * host can answer it. The agent writes the registration with
 * `dsh-git-badge-checkout <path>`; the file is advisory, so it is validated
 * here before it is believed — the path must be a worktree git itself lists,
 * the entry must be fresher than SESSION_CHECKOUT_TTL_MS, and the name/branch
 * come from git rather than from the file. A stale, hand-edited or removed
 * registration can therefore only fail to resolve, never point the badge at a
 * directory that is not a worktree of this repository.
 */
function sessionCheckouts() {
	if (typeof config.sessionCheckoutsFile === "string") {
		try {
			const raw = JSON.parse(readFileSync(config.sessionCheckoutsFile, "utf8"));
			return raw !== null && typeof raw === "object" && typeof raw.sessions === "object" && raw.sessions !== null
				? raw.sessions
				: {};
		} catch {
			return {};
		}
	}
	return readSessionCheckouts();
}

async function registeredCheckout(target, sessionId) {
	if (typeof sessionId !== "string" || sessionId === "") return void 0;
	const entry = sessionCheckouts()[sessionId];
	if (entry === void 0 || typeof entry?.path !== "string") return void 0;
	const at = Date.parse(String(entry.at ?? ""));
	if (!Number.isFinite(at) || Date.now() - at > SESSION_CHECKOUT_TTL_MS) return void 0;
	const { toplevel, worktrees } = await worktreesFor(target.path);
	// Git lists the main worktree first, and a registration only means something
	// when the session's own directory IS that main checkout: a session already
	// inside a linked worktree is its own answer and is never swapped sideways.
	const main = worktrees[0];
	if (toplevel === "" || main === void 0 || main.path !== toplevel || target.path !== toplevel || worktrees.length <= 1) return void 0;
	const found = worktrees.find((tree) => tree.path === entry.path);
	if (found === void 0 || found.path === toplevel) return void 0;
	return { path: found.path, name: found.name, branch: found.branch };
}

/**
 * The directory a request is ABOUT.
 *
 * A SESSION-targeted chip follows the checkout that session REGISTERED — the one
 * signal that knows where the agent is actually working. Without a registration
 * the request stays on the session's own directory: the plugin never guesses a
 * worktree from pull requests (an earlier build inferred one from the branch
 * with the open PR; the guess was invisible to the session that made it and
 * silently wrong whenever two trees were in play).
 *
 * A WORKSPACE-targeted row never follows a worktree: a row surveys the checkout
 * the registry owns, and substituting a tree would make the row lie about the
 * branch it is on.
 */
async function effectiveTarget(target, sessionId) {
	const bySession = typeof sessionId === "string" && sessionId !== "";
	if (config.worktreeStatus !== "off") {
		const registered = bySession ? await registeredCheckout(target, sessionId) : void 0;
		if (registered !== void 0) {
			selectWorktreeWatch(target.path, target.id, registered.path);
			// The name and branch travel; the PATH never does (AGENTS.md rule 7).
			return { id: target.id, path: registered.path, worktree: { name: registered.name, branch: registered.branch } };
		}
	}
	// No registration (or a stale one): retire any follow this workspace had, so
	// clearing the registration actually stops the extra watcher.
	selectWorktreeWatch(target.path, target.id, void 0);
	return { id: target.id, path: target.path };
}

/** Host plugin body — register the status route and the SSE change feed. */
function apply(ctx) {
	// The ranking order lives in this plugin's own settings namespace: declared
	// with a schema so the host validates it, stored in the user's settings
	// document, and observed live — a change applies to the next status read
	// with no file poll and no restart. The pre-settings JSON file, when it
	// exists, seeds the namespace as its composition BASE so an order configured
	// before this existed survives the upgrade; it is also the fallback when the
	// settings service is absent (a host composed without dsh-settings).
	currentOrder = legacyOrderFile();
	if (typeof ctx.inject === "function") {
		try {
			ctx.inject(["settings"], async (settingsCtx) => {
				let Schema;
				try {
					Schema = await config.settingsSchemaLoader();
				} catch (error) {
					console.error("[dsh-git-badge] schema lib unavailable; keeping the legacy order file:", error);
					return;
				}
				const scope = settingsCtx.settings.register(SETTINGS_NS, orderSettingsSchema(Schema), {
					base: { order: legacyOrderFile() }
				});
				currentOrder = normalizeOrder(scope.get()?.order);
				settingsOrderActive = true;
				settingsCtx.effect(() => scope.watch((next) => {
					currentOrder = normalizeOrder(next?.order);
				}), "dsh-git-badge: order settings");
				settingsCtx.effect(() => () => {
					settingsOrderActive = false;
				}, "dsh-git-badge: order settings teardown");
			});
		} catch (error) {
			console.error("[dsh-git-badge] settings namespace unavailable, using the legacy order file:", error);
		}
	}
	// A fresh boot composed the files on disk into the new bundles — any
	// restart-pending marker was written by an install/apply against the PREVIOUS
	// boot and its change is now live. Clearing here is what makes the marker
	// self-expiring: it survives exactly until the restart it asks for happens.
	clearRestartMarker();
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
				const pending = readRestartMarker();
				const detail = url.searchParams.get("detail") === "1";
				const pr = url.searchParams.get("pr") === "1";
				// WHO asked decides whether a linked worktree may stand in for the
				// session's own directory — see effectiveTarget. A workspace-targeted
				// row never leaves the checkout the registry owns.
				const session = url.searchParams.get("session");
				const effective = await effectiveTarget(target, session ?? void 0);
				const info = await gitStatus(effective.path, detail, pr);
				const body = { ...info, workspace: target.id };
				if (effective.worktree !== void 0 && info.git === true) {
					// The status describes a worktree the SESSION's directory does not
					// name. Saying so is the whole honesty of the feature: the chip's
					// mark says "worktree", its name says which, and this flag tells the
					// card why the checkout below differs from the branch beside it.
					body.worktreeFollowed = true;
					if (detail) {
						// The session's OWN directory, for the card's `checkout` row, so the
						// main checkout stays visible once the badge follows a tree. Gated
						// by detail=1 (a pointer resting on the chip), so nothing at rest
						// pays for the second read.
						const own = await gitStatus(target.path, false, false);
						if (own.git === true) {
							body.checkout = {
								branch: own.branch,
								dirty: own.dirty,
								changedFiles: own.changedFiles,
								untrackedFiles: own.untrackedFiles,
								ahead: own.ahead,
								behind: own.behind
							};
						}
					}
				}
				// Echo the resolved workspace id. SSE events identify the workspace,
				// not the session, so a session-targeted client has no other way to
				// tell whether an event belongs to it — without this the input chip
				// only ever refreshed on remount or the 60s poll.
				res.writeHead(200, { "content-type": "application/json" });
				if (pending !== null) {
					// dshmarket cannot see postinstall/apply host-file changes; this
					// flag is how the running UI learns a restart is pending and
					// offers its own Restart button (dshmarket v1 restart endpoint).
					body.seamRestartPending = { by: pending.by, at: pending.at };
				}
				res.end(JSON.stringify(body));
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
	nextStep,
	nextActions,
	outerGitDir,
	parseStatusV2,
	parseWorktreeList,
	readWorktrees,
	worktreesFor,
	runCli,
	runGit,
	gitStatus,
	gitStatusUncached,
	resolveWorkspace,
	effectiveTarget,
	readPrStatus,
	summarizePr,
	summarizeChecks,
	prStatusFor,
	prState,
	selectWorktreeWatch,
	selectedWorktrees,
	statusInFlight,
	watchWorkspace,
	unwatchWorkspace,
	syncWatchers,
	watchers,
	changeListeners,
	openStreams,
	closeStream
};
