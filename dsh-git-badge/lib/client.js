/**
 * dsh-git-badge — client half.
 *
 * Surfaces:
 *  - sidebar.workspaces.row (seam): row badge — dot + branch
 *  - conversation.input.left (upstream): chip — dot + branch + in-progress
 *    operation token + sync/dirty suffix
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
			const targetId = target === void 0 ? void 0 : target.id;
			const hit = cacheKey === void 0 ? void 0 : GIT_CACHE.get(cacheKey);
			// state carries the key it belongs to: switching conversations changes
			// the key, and showing the previous session's badge until the new fetch
			// lands would be wrong
			const [state, setState] = react.useState({ key: cacheKey, data: hit === void 0 ? void 0 : hit.data });
			react.useEffect(() => {
				if (cacheKey === void 0) return;
				let alive = true;
				const cached = GIT_CACHE.get(cacheKey);
				if (cached !== void 0) setState({ key: cacheKey, data: cached.data });
				const apply = (data) => {
					// A degraded response (git timeout/failure) must never clobber a
					// good cached badge — keep the last-known state until a real
					// event or the fallback poll succeeds.
					if (data !== null && data.error !== void 0 && GIT_CACHE.has(cacheKey)) return;
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
				// this target's watcher events → refetch. An event carrying no
				// workspace id cannot be attributed, so refetch rather than guess.
				const unsubscribe = subscribeGitEvents((payload) => {
					if (payload.workspace === void 0 || payload.workspace === targetId) load();
				});
				const fallback = setInterval(load, FALLBACK_POLL_MS);
				return () => {
					alive = false;
					unsubscribe();
					clearInterval(fallback);
				};
			}, [cacheKey, targetId]);
			return state.key === cacheKey ? state.data : void 0;
		}

		/**
		 * Three-state dot color, shared by the sidebar row badge and the
		 * composer chip. Checked top-down, first match wins:
		 *  - RED: unmerged files (mid-conflict, git is blocked) — or a dirty
		 *    tree that is ALSO behind upstream (unsaved edits on an outdated
		 *    base: commit-then-pull friction ahead).
		 *  - YELLOW: dirty files, or any ahead/behind (routine work or sync
		 *    pending — including the previously "quiet" green-but-↓1 case).
		 *  - GREEN: clean and in sync.
		 * Red never means merely "behind": a clean tree one commit behind is
		 * normal between pulls, not an alarm.
		 */
		function badgeDot(info) {
			const dirty = info.dirty === true;
			const behind = (info.behind || 0) > 0;
			const ahead = (info.ahead || 0) > 0;
			const conflict = (info.unmergedFiles || 0) > 0;
			if (conflict || (dirty && behind)) return "\uD83D\uDD34";
			if (dirty || ahead || behind) return "\uD83D\uDFE1";
			return "\uD83D\uDFE2";
		}

		/**
		 * Sync/dirty suffix — INPUT CHIP ONLY. The sidebar row badge shows
		 * status + branch alone; the chip is the detailed surface. Rule set:
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
		 * In-progress operation token — INPUT CHIP ONLY (the row badge stays
		 * dot + branch). A paused rebase or cherry-pick whose conflicts are all
		 * already staged has no unmerged files, so the three-state dot cannot
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

		const META_STYLE = {
			color: "var(--dsw-alias-label-tertiary, #9ea7ad)",
			fontSize: "12px",
			lineHeight: "20px",
			flex: "none",
			whiteSpace: "nowrap"
		};

		/**
		 * Row badge — three-state dot + branch (sync/dirty detail lives on
		 * the input chip):
		 *   the_paragliding_app  | 🟢 main
		 * Dot color via badgeDot(): green clean+synced, yellow dirty or
		 * out-of-sync, red conflict or dirty-and-behind.
		 * Always renders the workspace name (so the row keeps its identity);
		 * appends the muted `| emoji branch` part only for git workspaces.
		 *
		 * Targets the row's `workspaceId`. The seam also passes `cwd`, which is
		 * deliberately ignored: the node half resolves the directory itself, so
		 * the client never has to name one. A row with no workspaceId (the
		 * ungrouped bucket) has no workspace to report on, so it renders
		 * name-only.
		 */
		function WorkspaceGitBadge({ label, workspaceId }) {
			// no detail=1: the row renders dot + branch only, and the extra log /
			// stash calls have no consumer yet
			const info = useGitStatus(workspaceId === void 0 ? void 0 : { kind: "workspace", id: workspaceId });
			const children = [react_jsx_runtime.jsx("span", { style: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: label })];
			if (workspaceId !== void 0 && info !== void 0 && info.git === true) {
				children.push(
					react_jsx_runtime.jsx("span", { style: { ...META_STYLE, margin: "0 7px" }, children: "|" }),
					react_jsx_runtime.jsx("span", { style: { ...META_STYLE, marginRight: "4px" }, children: badgeDot(info) }),
					react_jsx_runtime.jsx("span", { style: META_STYLE, children: info.branch })
				);
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
			const text = badgeDot(info) + " " + info.branch + formatOperationToken(info) + formatGitSuffix(info);
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
