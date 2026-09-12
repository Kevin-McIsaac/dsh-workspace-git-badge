/**
 * dsh-git-badge — client half.
 *
 * Both surfaces show the SAME status mark — a circle, or a tree for a linked
 * worktree, filled with the status colour — so status and worktree-ness read
 * identically wherever they appear.
 *
 * Surfaces:
 *  - sidebar.workspaces.row (seam): row badge — workspace name, the status mark
 *    floated right, and a worktree's name beside it. Deliberately shows NO
 *    branch: the chip is the surface that names it.
 *  - conversation.input.left (upstream): chip — status mark + branch + a
 *    worktree's name + in-progress operation token + sync/dirty suffix + the
 *    PR/CI token, with a HOVER CARD carrying the breakdown the chip has no room
 *    for (file detail, recent commits, stash, PR state).
 *
 * The hover card is the INPUT CHIP's, not the sidebar row's, and it needs
 * nothing but the upstream slot: the Tooltip primitive is seeded by the shell
 * itself, so the card works on a PRISTINE install with no seam patch. Its extra
 * fields are fetched only once a pointer rests on the chip, so the everyday
 * badge pays for none of them.
 */
window.__ModuleLoader__.load({
	id: "dsh-git-badge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");

		/**
		 * Shell-seeded UI primitives. `Tooltip` is handed to EVERY client bundle
		 * by the web shell itself — it needs no `dsh.client.inject` entry and no
		 * npm dependency (dsh-client-ui-open-in-app requires it the same way).
		 *
		 * Guarded, because the seed table belongs to the shell and not to this
		 * plugin: on a shell that does not provide it the chip must still render,
		 * just without the hover card. A missing card is a smaller failure than a
		 * missing badge.
		 */
		let primitives = null;
		try {
			primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		} catch {
			primitives = null;
		}
		const Tooltip = primitives === null ? void 0 : primitives.Tooltip;

		/** Module-level git-status cache. Entries are invalidated by SSE events, never by age. */
		const GIT_CACHE = new Map();
		/** In-flight fetches per cacheKey: bursts collapse into one request. */
		const GIT_INFLIGHT = new Map();
		/** Slow safety-net poll: refreshes even if the SSE stream is silently dead. */
		const FALLBACK_POLL_MS = 60000;

		/**
		 * A request target names WHO is asking, never a filesystem path — the node
		 * half resolves the directory itself, so a surface never needs to know
		 * one. The chip targets its conversation (`session`); a sidebar row
		 * targets the workspace id the seam hands it. The query string doubles as
		 * the cache key.
		 *
		 * The two optional additions are the INPUT CHIP's alone, and each is an
		 * explicit request rather than something every badge pays for:
		 *   - `detail=1` — recent commits and stash for the hover card;
		 *   - `pr=1` — the branch's GitHub PR/CI state.
		 * A sidebar row asks for neither, so surveying N workspaces never costs N
		 * forge calls (see the node half's PR region).
		 */
		function targetQuery(target, options) {
			if (target === void 0 || target.id === void 0) return void 0;
			const param = target.kind === "workspace" ? "workspace" : "session";
			let query = param + "=" + encodeURIComponent(target.id);
			if (options?.pr === true) query += "&pr=1";
			if (options?.detail === true) query += "&detail=1";
			return query;
		}

		//#region SSE change feed (one EventSource per page, ref-counted)
		const eventListeners = new Set();
		let eventSource = null;
		let eventRefs = 0;

		function subscribeGitEvents(onChange) {
			eventListeners.add(onChange);
			eventRefs += 1;
			if (eventSource === null) {
				eventSource = new EventSource("/api/git-badge/events");
				// NAMED frames: the node half writes `event: change`, and onmessage
				// never fires for a named event
				eventSource.addEventListener("change", (message) => {
					let payload;
					try {
						payload = JSON.parse(message.data);
					} catch {
						return;
					}
					// The server names the workspace it watched, so a subscriber that
					// asked by id matches without ever knowing a path. Each
					// subscriber refetches itself, and the per-key in-flight map
					// collapses the resulting burst into one request.
					for (const fn of [...eventListeners]) {
						try {
							fn(payload);
						} catch {
							/* one bad subscriber must not starve the rest */
						}
					}
				});
			}
			return () => {
				eventListeners.delete(onChange);
				eventRefs -= 1;
				if (eventRefs === 0 && eventSource !== null) {
					eventSource.close();
					eventSource = null;
				}
			};
		}
		//#endregion

		/**
		 * Shared git-status hook. Fetches once on mount and then only when the
		 * node half's watcher reports a change for this target (SSE), plus a slow
		 * safety-net poll in case the stream dies silently. Returns undefined
		 * while loading and for non-git workspaces.
		 *
		 * `options.detail` / `options.pr` ask the node half for the chip's extras
		 * (see targetQuery). `options.enabled: false` holds the fetch back
		 * entirely — that is what makes the hover card's extra fields LAZY: the
		 * chip renders without them and only starts paying for `log -3` plus a
		 * stash list once a pointer actually rests on it. The hook is still called
		 * unconditionally (hooks may not be conditional); the GATE is inside.
		 */
		function useGitStatus(target, options) {
			const enabled = options?.enabled !== false;
			const cacheKey = targetQuery(target, options);
			const hit = cacheKey === void 0 ? void 0 : GIT_CACHE.get(cacheKey);
			// state carries the key it belongs to: switching conversations changes
			// the key, and showing the previous session's badge until the new fetch
			// lands would be wrong
			const [state, setState] = react.useState({ key: cacheKey, data: hit === void 0 ? void 0 : hit.data });
			react.useEffect(() => {
				if (cacheKey === void 0 || !enabled) return;
				let alive = true;
				// The workspace this target resolved to, taken from the response (the
				// server echoes it). THIS is what events are matched against: an event
				// carries a workspace id, and a session-targeted chip has only a
				// session id, so comparing the two directly never matches.
				let resolvedWorkspace;
				// Re-seed from cache when the key changes (switching conversations):
				// render the last-known badge immediately instead of blanking until the
				// fetch lands, and take the workspace id from it so events still match.
				const cached = GIT_CACHE.get(cacheKey);
				if (cached !== void 0) {
					if (typeof cached.data?.workspace === "string") resolvedWorkspace = cached.data.workspace;
					setState({ key: cacheKey, data: cached.data });
				}
				const apply = (data) => {
					// A degraded response (git timeout/failure) must never clobber a
					// good cached badge — keep the last-known state until a real
					// event or the fallback poll succeeds.
					if (data !== null && data.error !== void 0 && GIT_CACHE.has(cacheKey)) return;
					if (data !== null && typeof data.workspace === "string") resolvedWorkspace = data.workspace;
					GIT_CACHE.set(cacheKey, { at: Date.now(), data });
					if (alive) setState({ key: cacheKey, data });
				};
				const load = () => {
					// dedupe: an in-flight fetch for this key serves all callers
					let pending = GIT_INFLIGHT.get(cacheKey);
					if (pending === void 0) {
						pending = fetch("/api/git-badge?" + cacheKey)
							.then((r) => r.json())
							.finally(() => GIT_INFLIGHT.delete(cacheKey));
						GIT_INFLIGHT.set(cacheKey, pending);
					}
					pending.then(apply).catch(() => {});
				};
				load();
				const unsubscribe = subscribeGitEvents((payload) => {
					// An event with no workspace id (no watcher record for that path)
					// cannot be attributed, and neither can one arriving before we have
					// resolved our own target — refetch rather than guess, since a
					// missed refresh is the bug this guards and an extra request is cheap
					// (the in-flight map collapses bursts).
					if (payload.workspace === void 0 || resolvedWorkspace === void 0 || payload.workspace === resolvedWorkspace) load();
				});
				const fallback = setInterval(load, FALLBACK_POLL_MS);
				return () => {
					alive = false;
					unsubscribe();
					clearInterval(fallback);
				};
			}, [cacheKey, enabled]);
			return state.key === cacheKey ? state.data : void 0;
		}

		/**
		 * Three-state status, checked top-down, first match wins:
		 *  - "error": unmerged files (mid-conflict, git is blocked) — or a dirty
		 *    tree that is ALSO behind upstream (unsaved edits on an outdated
		 *    base: commit-then-pull friction ahead).
		 *  - "warn": dirty files, or any ahead/behind (routine work or sync
		 *    pending — including the previously "quiet" green-but-↓1 case).
		 *  - "ok": clean and in sync.
		 * Red never means merely "behind": a clean tree one commit behind is
		 * normal between pulls, not an alarm.
		 *
		 * The single source of truth for that summary. BOTH surfaces render it the
		 * same way (see StatusMark): a circle, or a tree in a linked worktree,
		 * filled with the colour below.
		 */
		function badgeStatus(info) {
			const dirty = info.dirty === true;
			const behind = (info.behind || 0) > 0;
			const ahead = (info.ahead || 0) > 0;
			const conflict = (info.unmergedFiles || 0) > 0;
			if (conflict || (dirty && behind)) return "error";
			if (dirty || ahead || behind) return "warn";
			return "ok";
		}

		/**
		 * Mark fill per status, from the app's own semantic tokens so BOTH surfaces
		 * follow light/dark and custom themes — which a hardcoded emoji cannot do.
		 * The literals are only fallbacks for use outside DSH.
		 */
		const MARK_FILL = {
			error: "var(--dsw-alias-state-error-primary, #e5484d)",
			warn: "var(--dsw-alias-state-warn-primary, #d29922)",
			ok: "var(--dsw-alias-state-success-primary, #30a46c)"
		};

		/**
		 * Accessible name per status, WITHOUT the "git" prefix — the mark adds
		 * "git: " or "git worktree: ", so shape and colour are never the only
		 * channel for either fact.
		 */
		const STATUS_LABEL = {
			error: "conflict, or uncommitted changes on an outdated base",
			warn: "uncommitted changes, or out of sync with upstream",
			ok: "clean and in sync"
		};

		/**
		 * Sync/dirty suffix — INPUT CHIP ONLY. The sidebar row shows status alone;
		 * the chip is the surface that carries the numbers. Rule set:
		 *  - dirty files render as ✎n (pencil = worktree files, distinct from
		 *    the ↑/↓ commit-sync axis)
		 *  - while dirty, BOTH sync counts render including zeros (↑0 ↓2 ✎3),
		 *    so every number is positionally attributable
		 *  - clean workspaces stay quiet: arrows only when nonzero, no ✎ at 0
		 *  - no upstream: arrows omitted entirely
		 */
		function formatGitSuffix(info) {
			const parts = [];
			const hasUpstream = info.ahead !== void 0 || info.behind !== void 0;
			const files = (info.changedFiles || 0) + (info.untrackedFiles || 0);
			if (hasUpstream && (files > 0 || info.ahead > 0 || info.behind > 0)) {
				parts.push("\u2191" + (info.ahead || 0));
				parts.push("\u2193" + (info.behind || 0));
			}
			if (files > 0) parts.push("\u270E" + files);
			return parts.length > 0 ? " " + parts.join(" ") : "";
		}

		/**
		 * PR / CI token — INPUT CHIP ONLY, and absent entirely when the node half
		 * has nothing to say (no `gh`, no GitHub remote, no PR for the branch), so
		 * a machine without `gh` sees precisely the chip it saw before.
		 *
		 * The state glyph is not the only channel: the token carries an accessible
		 * name spelling the state out, the same rule the status mark follows.
		 */
		const PR_STATE_GLYPH = { passing: "\u2713", pending: "\u2026", failing: "\u2717", none: "" };
		const PR_STATE_LABEL = { passing: "checks passing", pending: "checks running", failing: "checks failing", none: "no checks" };

		/** ` PR#142 ✗` (plus ` draft`), or "" when there is no PR to report. */
		function formatPrToken(info) {
			const pr = info.pr;
			if (pr === void 0 || pr === null || pr.number === void 0) return "";
			const state = PR_STATE_GLYPH[pr.state] === void 0 ? "none" : pr.state;
			const glyph = PR_STATE_GLYPH[state];
			return " PR#" + pr.number + (glyph === "" ? "" : " " + glyph) + (pr.draft === true ? " draft" : "");
		}

		/** The token's accessible name: "pull request 142, checks failing, draft". */
		function prTokenLabel(info) {
			const pr = info.pr;
			if (pr === void 0 || pr === null || pr.number === void 0) return void 0;
			const state = PR_STATE_LABEL[pr.state] === void 0 ? PR_STATE_LABEL.none : PR_STATE_LABEL[pr.state];
			return "pull request " + pr.number + ", " + state + (pr.draft === true ? ", draft" : "");
		}

		/**
		 * In-progress operation token — INPUT CHIP ONLY (the row shows the status
		 * tree alone). A paused rebase or cherry-pick whose conflicts are all
		 * already staged has no unmerged files, so the three-state summary cannot
		 * distinguish it from ordinary dirty work; this says which
		 * history-rewriting operation git is waiting on.
		 */
		const OPERATION_LABELS = {
			merge: "\u2694merge",
			squash: "\u2694squash",
			"cherry-pick": "\u2694cherry-pick",
			revert: "\u2694revert",
			bisect: "\u2694bisect",
			rebase: "\u2694rebase",
			sequencer: "\u2694sequencer"
		};

		/** ` ⚔rebase` when an operation is paused, else "". */
		function formatOperationToken(info) {
			const label = OPERATION_LABELS[info.operation];
			return label === void 0 ? "" : " " + label;
		}

		/**
		 * Linked-worktree NAME token — INPUT CHIP ONLY, and only the name: worktree-
		 * ness itself is carried by the status mark's shape (a tree instead of a
		 * circle) on both surfaces. The chip has no other workspace identity, so
		 * several worktrees of one repository would otherwise render identical chips
		 * with no way to tell which checkout a conversation is in. The node half
		 * reports whether this is a linked worktree plus its directory NAME (never a
		 * path).
		 *
		 * The name is appended only when it says something the branch does not: the
		 * usual `repo-feat-x` directory sitting on branch `feat-x` would otherwise
		 * read as stutter. (The ROW needs no such rule — it shows the name instead
		 * of the branch, so there is nothing to stutter against.)
		 */

		/**
		 * True when the worktree name is already implied by the branch name, so
		 * showing both is pure repetition. Compared on a normalized form —
		 * case-folded, with `/` and `_` folded to `-` — because directory and
		 * branch conventions differ without changing the meaning (`feat/x` in a
		 * `repo-feat-x` directory).
		 */
		function worktreeNameIsRedundant(name, branch) {
			if (typeof name !== "string" || name === "" || typeof branch !== "string") return true;
			const normalize = (value) => value.toLowerCase().replace(/[/_]/g, "-");
			const normalizedName = normalize(name);
			const normalizedBranch = normalize(branch);
			return normalizedName === normalizedBranch
				|| normalizedName.endsWith("-" + normalizedBranch)
				|| normalizedBranch.endsWith("-" + normalizedName);
		}

		/** ` name` for a worktree whose name the branch does not already say, else "". */
		function formatWorktreeToken(info) {
			if (info.isWorktree !== true) return "";
			const name = typeof info.worktreeName === "string" ? info.worktreeName : "";
			return worktreeNameIsRedundant(name, info.branch) ? "" : " " + name;
		}

		const META_STYLE = {
			color: "var(--dsw-alias-label-tertiary, #9ea7ad)",
			fontSize: "12px",
			lineHeight: "20px",
			flex: "none",
			whiteSpace: "nowrap"
		};

		/**
		 * Status mark, SHARED BY BOTH SURFACES: the same shape in the same fill
		 * wherever it appears, so the sidebar row and the input chip read
		 * identically. The FILL is the status colour; the SHAPE carries
		 * worktree-ness — a circle for a main checkout, a tree for a linked
		 * worktree — so the two facts never compete for the same channel.
		 *
		 * Drawn rather than typed because 🌳 is a COLOUR EMOJI: CSS cannot tint
		 * its leaves, and a mark that carries the status has to be paintable.
		 * Three overlapping crown lobes plus a trunk stay legible at this size.
		 *
		 * Neither colour nor shape is the only channel: the accessible name
		 * states both.
		 */
		function StatusMark({ info }) {
			const status = badgeStatus(info);
			const fill = MARK_FILL[status];
			const isWorktree = info.isWorktree === true;
			const svg = {
				// 14px, NOT 12px: a colour emoji draws well above its nominal size — the
				// 🔴/🟡/🟢 dot this replaces put down ~13-14px of ink at the surfaces'
				// 12px font-size, so a 12px box read as a shrunken dot.
				width: 14,
				height: 14,
				viewBox: "0 0 12 12",
				role: "img",
				"aria-label": (isWorktree ? "git worktree: " : "git: ") + STATUS_LABEL[status],
				focusable: "false",
				style: { flex: "none", display: "block", color: META_STYLE.color }
			};
			if (!isWorktree) {
				// a plain filled disc: this is a main checkout. It fills its box so the
				// ink lands at the size the emoji dot used to.
				return react_jsx_runtime.jsx("svg", { ...svg, children: react_jsx_runtime.jsx("circle", { cx: 6, cy: 6, r: 5.5, fill }) });
			}
			return react_jsx_runtime.jsxs("svg", {
				...svg,
				children: [
					// trunk first, so the crown's lobes overlap and join it. These are the
					// 12px-era coordinates scaled 1.15 about the tree's centre, so its ink
					// stays comparable to the disc's instead of reading small beside it.
					react_jsx_runtime.jsx("rect", { key: "trunk", x: 5.25, y: 7.3, width: 1.5, height: 4.14, rx: 0.63, fill: "currentColor" }),
					react_jsx_runtime.jsx("circle", { key: "crown-1", cx: 6, cy: 3.62, r: 3.57, fill }),
					react_jsx_runtime.jsx("circle", { key: "crown-2", cx: 3.24, cy: 5.46, r: 2.53, fill }),
					react_jsx_runtime.jsx("circle", { key: "crown-3", cx: 8.76, cy: 5.46, r: 2.53, fill })
				]
			});
		}

		/**
		 * A linked worktree's directory name, or null when there is nothing to
		 * show. A main checkout shows NO text: the row surveys status and identity,
		 * and the branch lives on the input chip — which is why the branch is never
		 * rendered here. The name is the one thing the row's own label (the
		 * worktree directory by default) cannot be trusted to say once a workspace
		 * has been renamed.
		 */
		function rowName(info) {
			if (info.isWorktree !== true) return null;
			const name = typeof info.worktreeName === "string" ? info.worktreeName : "";
			return name === "" ? null : name;
		}

		/**
		 * Row badge — workspace name on the left, the status mark floated right:
		 *   the_paragliding_app                       ●
		 *   worktree_thing                  hotfix-tree 🌳
		 * Fill colour via badgeStatus(): green clean+synced, amber dirty or
		 * out-of-sync, red conflict or dirty-and-behind. Shape via the node half's
		 * isWorktree: circle = main checkout, tree = linked worktree.
		 * Always renders the workspace name (so the row keeps its identity) and
		 * appends the right-hand mark only for git workspaces. No branch, and no
		 * `|` separator.
		 *
		 * Targets the row's `workspaceId`. The seam also passes `cwd`, which is
		 * deliberately ignored: the node half resolves the directory itself, so
		 * the client never has to name one. A row with no workspaceId (the
		 * ungrouped bucket) has no workspace to report on, so it renders
		 * name-only.
		 */
		function WorkspaceGitBadge({ label, workspaceId }) {
			// no detail=1: the row needs status and identity only, and the extra
			// log / stash calls have no consumer yet
			const info = useGitStatus(workspaceId === void 0 ? void 0 : { kind: "workspace", id: workspaceId });
			const children = [react_jsx_runtime.jsx("span", { style: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: label })];
			if (workspaceId !== void 0 && info !== void 0 && info.git === true) {
				// marginLeft:auto floats the mark to the right edge, so the status
				// shape holds a fixed right-hand column and a worktree's name grows
				// leftwards from it instead of shoving the shape around.
				const meta = [];
				const name = rowName(info);
				if (name !== null) meta.push(react_jsx_runtime.jsx("span", { key: "name", style: META_STYLE, children: name }));
				meta.push(react_jsx_runtime.jsx(StatusMark, { key: "mark", info }));
				children.push(react_jsx_runtime.jsx("span", { style: { display: "inline-flex", alignItems: "center", gap: "6px", flex: "none", marginLeft: "auto", paddingLeft: "8px" }, children: meta }));
			}
			return react_jsx_runtime.jsx("span", { style: { display: "flex", alignItems: "center", minWidth: 0, width: "100%" }, children });
		}

		/**
		 * The chip's `✎n` is one number for four different things; the card splits
		 * it, so "ready to commit" is distinguishable from "not staged yet". The
		 * collapsed caveat is the node half's own honesty flag: when the untracked
		 * walk blew its budget the count is a DIRECTORY count, and saying so beats
		 * presenting an under-count as exact.
		 */
		function formatFileBreakdown(info) {
			const parts = [];
			if ((info.stagedFiles || 0) > 0) parts.push(info.stagedFiles + " staged");
			if ((info.unstagedFiles || 0) > 0) parts.push(info.unstagedFiles + " unstaged");
			if ((info.unmergedFiles || 0) > 0) parts.push(info.unmergedFiles + " unmerged");
			const untracked = info.untrackedFiles || 0;
			if (untracked > 0) parts.push(untracked + " untracked" + (info.untrackedMode === "collapsed" ? " (collapsed)" : ""));
			return parts.length === 0 ? "clean" : parts.join(" \u00B7 ");
		}

		/** The PR's full state as text, for the card: "#142 · checks failing · draft · review approved". */
		function formatPrDetail(pr) {
			if (pr === void 0 || pr === null || pr.number === void 0) return void 0;
			const state = PR_STATE_LABEL[pr.state] === void 0 ? PR_STATE_LABEL.none : PR_STATE_LABEL[pr.state];
			const bits = ["#" + pr.number, state];
			if (pr.draft === true) bits.push("draft");
			if (pr.review !== void 0) bits.push(String(pr.review).toLowerCase().replace(/_/g, " "));
			if (pr.open === false) bits.push("not open");
			return bits.join(" \u00B7 ");
		}

		const CARD_CONTAINER = {
			display: "flex",
			flexDirection: "column",
			gap: "4px",
			fontSize: "12px",
			lineHeight: "18px",
			maxWidth: "340px"
		};
		const CARD_ROW = { display: "flex", gap: "8px", alignItems: "baseline" };
		const CARD_LABEL = { color: "var(--dsw-alias-label-tertiary, #9ea7ad)", flex: "none", minWidth: "62px" };
		const CARD_VALUE = { minWidth: 0, overflowWrap: "anywhere" };

		/**
		 * Hover card body for the input chip — INPUT CHIP ONLY. Pure presentation
		 * over fields the status response already carries, plus the `detail=1`
		 * additions (recent commits, stash) when they have arrived. Everything is
		 * spelled out in text, so no fact here depends on a colour or a glyph.
		 */
		function HoverCard({ info, detail }) {
			// the detail payload is a superset of the plain one, so it wins when it
			// has landed; until then the card still shows the base facts
			const data = detail === void 0 ? info : detail;
			const rows = [];
			const add = (label, value) => {
				if (value === void 0 || value === null || value === "") return;
				rows.push(
					react_jsx_runtime.jsxs("div", {
						style: CARD_ROW,
						children: [
							react_jsx_runtime.jsx("span", { style: CARD_LABEL, children: label }),
							react_jsx_runtime.jsx("span", { style: CARD_VALUE, children: value })
						]
					}, label)
				);
			};
			add("branch", info.branch);
			add("upstream", info.upstream === void 0 ? "none configured" : info.upstream);
			if (info.ahead !== void 0 || info.behind !== void 0) {
				add("sync", "\u2191" + (info.ahead || 0) + " \u2193" + (info.behind || 0));
			}
			add("files", formatFileBreakdown(info));
			add("operation", info.operation === void 0 || info.operation === null ? void 0 : String(info.operation));
			add("pull request", formatPrDetail(data.pr));
			if (Array.isArray(data.lastCommits) && data.lastCommits.length > 0) {
				rows.push(
					react_jsx_runtime.jsxs("div", {
						style: CARD_ROW,
						children: [
							react_jsx_runtime.jsx("span", { style: CARD_LABEL, children: "commits" }),
							react_jsx_runtime.jsx("span", {
								style: { ...CARD_VALUE, display: "flex", flexDirection: "column", gap: "2px" },
								children: data.lastCommits.map((commit) =>
									react_jsx_runtime.jsxs("span", {
										children: [
											react_jsx_runtime.jsx("span", { style: CARD_LABEL, children: commit.hash }),
											" " + commit.subject + (commit.when === "" ? "" : " \u00B7 " + commit.when)
										]
									}, commit.hash)
								)
							})
						]
					}, "commits")
				);
			}
			add("stash", data.stashCount === void 0 ? void 0 : data.stashCount + " stashed");
			return react_jsx_runtime.jsx("div", { style: CARD_CONTAINER, children: rows });
		}

		//#region composer chip (upstream additive surface: conversation.input.left)
		/**
		 * Chip line in the input row: git state of the workspace the CURRENT
		 * conversation is attached to. It targets the session id and lets the node
		 * half resolve the workspace, so this surface needs no `workspaces`
		 * service, no cwd and no path plumbing at all. Works on unpatched installs
		 * (conversation.input.left is an upstream additive slot), and stays useful
		 * next to the sidebar rows because it is context-anchored ("where am I")
		 * rather than surveying.
		 *
		 * This is the ONLY surface that asks the node half for the extras (`pr=1`
		 * always, `detail=1` on hover), because it is the only one that renders
		 * them — see targetQuery.
		 */
		function ComposerGitChip({ sessionId }) {
			const target = sessionId === void 0 ? void 0 : { kind: "session", id: sessionId };
			// the PR/CI token is always on the chip, so its fetch is not gated
			const info = useGitStatus(target, { pr: true });
			// The card's extras cost a `log -3` plus a stash list, so they are
			// fetched only once a pointer actually RESTS on the chip, then kept
			// fresh by the same SSE path. Eagerly asking would add both invocations
			// to every refresh — and a refresh fires on every file edit.
			const [hovered, setHovered] = react.useState(false);
			const detail = useGitStatus(target, { pr: true, detail: true, enabled: hovered });
			if (info === void 0 || info.git !== true) return null;
			// the mark is an element now rather than a leading glyph in the string, so
			// the SAME StatusMark the sidebar row draws carries the status here too;
			// the container's 4px gap supplies the space the emoji's own did
			const text = info.branch + formatWorktreeToken(info) + formatOperationToken(info) + formatGitSuffix(info);
			const prToken = formatPrToken(info);
			const chip = react_jsx_runtime.jsxs("span", {
				style: {
					display: "inline-flex",
					alignItems: "center",
					flex: "none",
					gap: "4px",
					color: "var(--dsw-alias-label-secondary, #5b6570)",
					fontSize: "12px",
					lineHeight: "24px",
					whiteSpace: "nowrap",
					cursor: "default"
				},
				// the card is fetched for a pointer that RESTS here, not one that
				// merely crosses the chip
				onPointerEnter: () => setHovered(true),
				children: [
					react_jsx_runtime.jsx(StatusMark, { key: "mark", info }),
					react_jsx_runtime.jsx("span", { key: "text", children: text }),
					prToken === ""
						? null
						: react_jsx_runtime.jsx("span", {
								key: "pr",
								// the glyph is not the only channel: the token says what the
								// CI state IS, for anyone who cannot see it
								"aria-label": prTokenLabel(info),
								children: prToken
							})
				]
			});
			// No Tooltip primitive (a shell that does not seed it): render the chip
			// itself rather than losing the badge. The card is an enhancement, the
			// badge is the feature.
			if (Tooltip === void 0) return chip;
			return react_jsx_runtime.jsx(Tooltip, {
				side: "top",
				maxWidth: 360,
				// a function label keeps the card's element tree out of every render
				// until the tooltip actually opens
				label: () => react_jsx_runtime.jsx(HoverCard, { info, detail }),
				children: chip
			});
		}
		//#endregion

		// `workspaces` is no longer required: both surfaces target an id and the
		// node half resolves the workspace, so the client never needs a service
		// lookup. Fewer declared services also means fewer ways to fail to load.
		const inject = ["slots"];

		/**
		 * Register the badge into both seams. The seam owner hands each entry the
		 * row owner share as props; the badge destructures { workspaceId, label }
		 * and deliberately ignores the cwd it is also given.
		 */
		function apply(ctx) {
			// inject() re-evaluates when a seam's declaration appears, so boot
			// order relative to the workspace browser does not matter. On an
			// unpatched install the row seam is never declared, so this callback
			// never fires and the row badge simply never renders.
			//
			// The registration is reported from INSIDE the callback on purpose: a
			// `spec()` check here at apply() time runs before the workspace browser
			// declares the seam, so it reports the boot race rather than the
			// outcome. That mistake made the old one-shot line claim "sidebar rows
			// = off" while five row badges were rendering.
			let rowsReported = false;
			ctx.slots.inject("sidebar.workspaces.row", () => {
				if (!rowsReported) {
					rowsReported = true;
					console.info("[dsh-git-badge] surfaces: sidebar rows = on (seam present).");
				}
				return ctx.slots.register({
					name: "sidebar.workspaces.row",
					id: "git-badge"
				}, WorkspaceGitBadge);
			});
			// Input-row chip: upstream additive slot rendered in the input bar's
			// leading cluster, right after the access picker — the git state sits
			// with the controls that govern the conversation. Present on every
			// install. (Alternative surface if ever needed:
			// conversation.input.dock = the row below the input, shared with the
			// usage-stats entry.)
			ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
				name: "conversation.input.left",
				id: "git-badge-chip",
				inject: (sessionId) => ({ sessionId })
			}, ComposerGitChip));
			const seamDeclared = ctx.slots.spec("sidebar.workspaces.row") !== void 0;
			console.info("[dsh-git-badge] surfaces: input chip = on; sidebar rows = " + (seamDeclared ? "on (seam present)." : "awaiting the sidebar.workspaces.row seam — the line above reports it if it appears."));
			// The hover card depends on a primitive the SHELL seeds, not on anything
			// this plugin declares. Report the outcome rather than letting a missing
			// seed look like a missing feature: the try/catch above deliberately keeps
			// the badge working, which would otherwise make this failure silent.
			console.info(
				"[dsh-git-badge] hover card = " +
					(Tooltip === void 0
						? "off (this shell seeds no Tooltip primitive) — the chip renders uncarded."
						: "on (shell Tooltip primitive).")
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		// ---------- test-only exports ----------
		// Additive; the host reads apply/inject and ignores the rest. The suite
		// drives these to assert the REQUEST contract — which surface asks for the
		// expensive extras — without a browser, a fetch or a network.
		exports.__internals = { targetQuery, formatPrToken, formatFileBreakdown, formatPrDetail };
		return module.exports;
	}
});
