/**
 * dsh-git-badge — client half.
 *
 * Surfaces:
 *  - sidebar.workspaces.row (seam): row badge — workspace name, then a status
 *    tree whose crown colour is the status, then `⑂<name>` for a linked
 *    worktree. Deliberately shows NO branch: the chip is the surface that
 *    names it.
 *  - conversation.input.left (upstream): chip — dot + branch + linked-worktree
 *    token + in-progress operation token + sync/dirty suffix
 * The hover card is intentionally untouched.
 */
window.__ModuleLoader__.load({
	id: "dsh-git-badge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");

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
		 */
		function targetQuery(target) {
			if (target === void 0 || target.id === void 0) return void 0;
			const param = target.kind === "workspace" ? "workspace" : "session";
			return param + "=" + encodeURIComponent(target.id);
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
		 */
		function useGitStatus(target) {
			const cacheKey = targetQuery(target);
			const hit = cacheKey === void 0 ? void 0 : GIT_CACHE.get(cacheKey);
			// state carries the key it belongs to: switching conversations changes
			// the key, and showing the previous session's badge until the new fetch
			// lands would be wrong
			const [state, setState] = react.useState({ key: cacheKey, data: hit === void 0 ? void 0 : hit.data });
			react.useEffect(() => {
				if (cacheKey === void 0) return;
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
			}, [cacheKey]);
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
		 * The single source of truth for that summary. The chip renders it as a
		 * dot emoji; the sidebar row renders it as the tree crown's colour.
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

		/** Three-state dot — INPUT CHIP ONLY; the sidebar row shows the tree. */
		function badgeDot(info) {
			const status = badgeStatus(info);
			if (status === "error") return "\uD83D\uDD34";
			if (status === "warn") return "\uD83D\uDFE1";
			return "\uD83D\uDFE2";
		}

		/**
		 * Crown colour per status, from the app's own semantic tokens so the row
		 * follows light/dark and custom themes — which the chip's hardcoded dot
		 * emoji cannot do. The literals are only fallbacks for use outside DSH.
		 */
		const CROWN_COLOR = {
			error: "var(--dsw-alias-state-error-primary, #e5484d)",
			warn: "var(--dsw-alias-state-warn-primary, #d29922)",
			ok: "var(--dsw-alias-state-success-primary, #30a46c)"
		};

		/** Accessible name per status: the crown colour must not be the only channel. */
		const STATUS_LABEL = {
			error: "git: conflict, or uncommitted changes on an outdated base",
			warn: "git: uncommitted changes, or out of sync with upstream",
			ok: "git: clean and in sync"
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
		 * Linked-worktree token — INPUT CHIP ONLY (the row marks a worktree its own
		 * way: `⑂<name>` after the status tree). The chip carries no workspace
		 * identity at all, so several worktrees of one repository all render the
		 * same `🟡 main` and there is no way to tell which checkout a conversation
		 * is in. The node half reports whether this is a linked worktree plus its
		 * directory NAME (never a path).
		 *
		 * The glyph always shows for a linked worktree — that fact is worth knowing
		 * on its own — and the name is appended only when it says something the
		 * branch does not. The usual `repo-feat-x` directory sitting on branch
		 * `feat-x` would otherwise read as stutter. (The ROW needs no such rule:
		 * it shows the name instead of the branch, so there is nothing to stutter
		 * against.)
		 */
		const WORKTREE_GLYPH = "\u2442";

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

		/** ` ⑂name` for a linked worktree, ` ⑂` when the name would be stutter, else "". */
		function formatWorktreeToken(info) {
			if (info.isWorktree !== true) return "";
			const name = typeof info.worktreeName === "string" ? info.worktreeName : "";
			return " " + WORKTREE_GLYPH + (worktreeNameIsRedundant(name, info.branch) ? "" : name);
		}

		const META_STYLE = {
			color: "var(--dsw-alias-label-tertiary, #9ea7ad)",
			fontSize: "12px",
			lineHeight: "20px",
			flex: "none",
			whiteSpace: "nowrap"
		};

		/**
		 * Sidebar-row status tree: a 12px tree whose crown is filled with the
		 * status token and whose trunk inherits the surrounding muted row colour.
		 *
		 * Drawn rather than typed because 🌳 is a COLOUR EMOJI — CSS cannot tint
		 * its leaves, so a tree that carries the status has to be an SVG. Three
		 * overlapping crown lobes plus a trunk stay legible at 12px, where a
		 * single circle would just read as the status dot it replaces. Colour is
		 * not the only channel: the accessible name states the status.
		 */
		function StatusTree({ info }) {
			const status = badgeStatus(info);
			const crown = CROWN_COLOR[status];
			return react_jsx_runtime.jsxs("svg", {
				width: 12,
				height: 12,
				viewBox: "0 0 12 12",
				role: "img",
				"aria-label": STATUS_LABEL[status],
				focusable: "false",
				style: { flex: "none", display: "block", marginRight: "4px", color: META_STYLE.color },
				children: [
					// trunk first, so the crown's lobes overlap and join it
					react_jsx_runtime.jsx("rect", { key: "trunk", x: 5.35, y: 7.1, width: 1.3, height: 3.6, rx: 0.55, fill: "currentColor" }),
					react_jsx_runtime.jsx("circle", { key: "crown-1", cx: 6, cy: 3.9, r: 3.1, fill: crown }),
					react_jsx_runtime.jsx("circle", { key: "crown-2", cx: 3.6, cy: 5.5, r: 2.2, fill: crown }),
					react_jsx_runtime.jsx("circle", { key: "crown-3", cx: 8.4, cy: 5.5, r: 2.2, fill: crown })
				]
			});
		}

		/**
		 * Text after the status tree. A main checkout shows NOTHING — the row is a
		 * survey of status, and the branch lives on the input chip — while a linked
		 * worktree shows `⑂<name>`: the one thing the row's own label (the worktree
		 * directory by default) cannot be trusted to say once a workspace is renamed.
		 */
		function rowLabel(info) {
			if (info.isWorktree !== true) return "";
			const name = typeof info.worktreeName === "string" ? info.worktreeName : "";
			return WORKTREE_GLYPH + name;
		}

		/**
		 * Row badge — workspace name, then the status tree, plus a linked
		 * worktree's name (never the branch):
		 *   the_paragliding_app  | 🌳
		 *   worktree_thing       | 🌳 ⑂hotfix-tree
		 * Crown colour via badgeStatus(): green clean+synced, amber dirty or
		 * out-of-sync, red conflict or dirty-and-behind.
		 * Always renders the workspace name (so the row keeps its identity);
		 * appends the muted `| tree [name]` part only for git workspaces.
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
				children.push(react_jsx_runtime.jsx("span", { style: { ...META_STYLE, margin: "0 7px" }, children: "|" }));
				children.push(react_jsx_runtime.jsx(StatusTree, { info }));
				const worktree = rowLabel(info);
				if (worktree !== "") children.push(react_jsx_runtime.jsx("span", { style: META_STYLE, children: worktree }));
			}
			return react_jsx_runtime.jsx("span", { style: { display: "flex", alignItems: "center", minWidth: 0 }, children });
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
		 */
		function ComposerGitChip({ sessionId }) {
			// no detail=1: nothing renders lastCommits / stashCount yet, and asking
			// for them would add a log -3 plus a stash list to every refresh
			const info = useGitStatus(sessionId === void 0 ? void 0 : { kind: "session", id: sessionId });
			if (info === void 0 || info.git !== true) return null;
			const text = badgeDot(info) + " " + info.branch + formatWorktreeToken(info) + formatOperationToken(info) + formatGitSuffix(info);
			return react_jsx_runtime.jsx("span", {
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
				children: text
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
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
