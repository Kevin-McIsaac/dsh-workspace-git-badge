/**
 * dsh-git-badge — client half.
 *
 * Surfaces:
 *  - sidebar.workspaces.row (seam): full row badge — emoji, branch, sync, ✎files
 *  - conversation.input.left (upstream): compact chip — emoji + branch only
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

		//#region SSE change feed (one EventSource per page, ref-counted)
		const eventListeners = new Set();
		let eventSource = null;
		let eventRefs = 0;

		function subscribeGitEvents(onChange) {
			eventListeners.add(onChange);
			eventRefs += 1;
			if (eventSource === null) {
				eventSource = new EventSource("/api/git-badge/events");
				eventSource.onmessage = (message) => {
					let path;
					try {
						path = JSON.parse(message.data).path;
					} catch {
						return;
					}
					// invalidate every cache entry for this workspace, then refetch
					for (const key of [...GIT_CACHE.keys()]) {
						if (key === path) GIT_CACHE.delete(key);
					}
					for (const fn of [...eventListeners]) {
						try {
							fn(path);
						} catch {
							/* one bad subscriber must not starve the rest */
						}
					}
				};
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
		 * node half's watcher reports a change for this workspace (SSE), plus a
		 * slow safety-net poll in case the stream dies silently. Returns
		 * undefined while loading and for non-git paths.
		 */
		function useGitStatus(cwd) {
			const cacheKey = cwd;
			const hit = cacheKey === void 0 ? void 0 : GIT_CACHE.get(cacheKey);
			const [info, setInfo] = react.useState(hit !== void 0 ? hit.data : void 0);
			react.useEffect(() => {
			if (cacheKey === void 0) return;
			let alive = true;
			const apply = (data) => {
				// A degraded response (git timeout/failure) must never clobber a
				// good cached badge — keep the last-known state until a real
				// event or the fallback poll succeeds.
				if (data !== null && data.error !== void 0 && GIT_CACHE.has(cacheKey)) return;
				GIT_CACHE.set(cacheKey, { at: Date.now(), data });
				if (alive) setInfo(data);
			};
			const load = () => {
				// dedupe: an in-flight fetch for this key serves all callers
				let pending = GIT_INFLIGHT.get(cacheKey);
				if (pending === void 0) {
					pending = fetch("/api/git-badge?path=" + encodeURIComponent(cwd))
						.then((r) => r.json())
						.finally(() => GIT_INFLIGHT.delete(cacheKey));
					GIT_INFLIGHT.set(cacheKey, pending);
				}
				pending.then(apply).catch(() => {});
			};
			load();
			// this workspace's watcher events → refetch
			const unsubscribe = subscribeGitEvents((path) => {
				if (path === cwd) load();
			});
			const fallback = setInterval(load, FALLBACK_POLL_MS);
			return () => {
				alive = false;
				unsubscribe();
				clearInterval(fallback);
			};
		}, [cacheKey]);
			return info;
		}

		/**
		 * Shared sync/dirty suffix for all surfaces. Rule set:
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

		const META_STYLE = {
			color: "var(--dsw-alias-label-tertiary, #9ea7ad)",
			fontSize: "12px",
			lineHeight: "20px",
			flex: "none",
			whiteSpace: "nowrap"
		};

		/**
		 * Row badge, Claude Code statusline style:
		 *   the_paragliding_app  | 🟢 main ↑1 ↓2
		 * Always renders the workspace name (so the row keeps its identity);
		 * appends the muted `| emoji branch sync` part only for git workspaces.
		 */
		function WorkspaceGitBadge({ label, cwd }) {
			const info = useGitStatus(cwd, false);
			const children = [react_jsx_runtime.jsx("span", { style: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: label })];
			if (cwd !== void 0 && info !== void 0 && info.git === true) {
				children.push(
					react_jsx_runtime.jsx("span", { style: { ...META_STYLE, margin: "0 7px" }, children: "|" }),
					react_jsx_runtime.jsx("span", { style: { ...META_STYLE, marginRight: "4px" }, children: info.dirty ? "🟡" : "🟢" }),
					react_jsx_runtime.jsx("span", { style: META_STYLE, children: info.branch + formatGitSuffix(info) })
				);
			}
			return react_jsx_runtime.jsx("span", { style: { display: "flex", alignItems: "center", minWidth: 0 }, children });
		}

		//#region composer chip (fallback + companion surface: conversation.composer.dock)
		/** Client root ctx, captured at apply() for the chip's service lookups. */
		let clientCtx = null;

		/**
		 * Resolve the workspace cwd attached to a session: projects the
		 * workspaces service's snapshot store (items carry path + sessionIds)
		 * and re-resolves on change. Returns undefined while unknown.
		 */
		function useSessionWorkspaceCwd(sessionId) {
			const workspaces = clientCtx === null ? null : clientCtx.get("workspaces");
			const resolve = () => {
				if (sessionId === void 0 || workspaces === void 0) return void 0;
				const item = workspaces.list.getSnapshot().items.find((w) => w.sessionIds !== void 0 && w.sessionIds.includes(sessionId));
				return item === void 0 ? void 0 : item.path;
			};
			const [cwd, setCwd] = react.useState(resolve);
			react.useEffect(() => {
				if (sessionId === void 0 || workspaces === void 0) return;
				setCwd(resolve());
				return workspaces.list.subscribe(() => {
					setCwd(resolve());
				});
			}, [sessionId, workspaces]);
			return cwd;
		}

		/**
		 * Chip line docked at the composer: git state of the workspace the
		 * CURRENT conversation is attached to. Works on unpatched installs
		 * (conversation.composer.dock is an upstream additive slot), and stays
		 * useful next to the sidebar rows on patched/upstream-seam installs
		 * because it is context-anchored ("where am I") rather than surveying.
		 */
		function ComposerGitChip({ sessionId }) {
			const cwd = useSessionWorkspaceCwd(sessionId);
			const info = useGitStatus(cwd, true);
			if (cwd === void 0 || info === void 0 || info.git !== true) return null;
			const text = (info.dirty ? "\uD83D\uDFE1 " : "\uD83D\uDFE2 ") + info.branch + formatGitSuffix(info);
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

		const inject = ["slots", "workspaces"];

		/**
		 * Register the badge into both seams. The seam owner hands each entry the
		 * row owner share as props; the badge destructures { workspaceId, cwd,
		 * label } from it.
		 */
		function apply(ctx) {
			clientCtx = ctx;
			// inject() re-evaluates when a seam's declaration appears, so boot
			// order relative to the workspace browser does not matter. On an
			// unpatched install the row seams never get declared, so those two
			// registrations simply never render anything.
			ctx.slots.inject("sidebar.workspaces.row", () => ctx.slots.register({
				name: "sidebar.workspaces.row",
				id: "git-badge"
			}, WorkspaceGitBadge));
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
			console.info("[dsh-git-badge] surfaces: input chip = on; sidebar rows = " + (seamDeclared ? "on (seam present)" : "off (seam absent — sidebar badges need the sidebar.workspaces.row seam)") + ".");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
