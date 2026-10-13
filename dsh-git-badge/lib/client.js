/**
 * dsh-git-badge — client half.
 *
 * Every surface rides an UPSTREAM seat. No patch, no manual step.
 *
 * Surfaces:
 *  - sidebar.session.row.leading: the session row's token as a single glyph in
 *    the row's 16px leading cell, from the node half's `rowToken`. Upstream
 *    renders this seat only while the session is IDLE.
 *  - sidebar.session.row.hover: the hover card that explains the token and
 *    names the checkout, rendered inside the card upstream ALREADY shows for a
 *    session row rather than in a tooltip nested inside it.
 *  - conversation.input.left: chip — status mark + branch + a
 *    worktree's name + in-progress operation token + sync/dirty suffix + the
 *    PR/CI token, with a HOVER CARD carrying the breakdown the chip has no room
 *    for (file detail, recent commits, stash, PR state, and the conversation's own
 *    checkout when the badge followed a worktree).
 *
 * The chip's hover card needs nothing but the upstream slot: the Tooltip
 * primitive is seeded by the shell itself. Its extra fields are fetched only once
 * a pointer rests on the chip, so the everyday badge pays for none of them.
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

		/**
		 * Module-level git-status cache. Entries are invalidated by SSE events,
		 * never by age — and BOUNDED, because a long-lived tab opens and closes
		 * many sessions and nothing else removes an entry. When the cap is
		 * exceeded the oldest-INSERTED key is evicted (Map order is insertion,
		 * not use); an evicted surface simply refetches, which the in-flight map
		 * collapses like any other request.
		 */
		const GIT_CACHE = new Map();
		/** The cache's entry bound — each surface is one key, plus lazy detail keys. */
		const GIT_CACHE_LIMIT = 64;
		/** In-flight fetches per cacheKey: bursts collapse into one request. */
		const GIT_INFLIGHT = new Map();
		/** Slow safety-net poll: refreshes even if the SSE stream is silently dead. */
		const FALLBACK_POLL_MS = 60000;

		/**
		 * A request target names WHO is asking, never a filesystem path — the node
		 * half resolves the directory itself, so a surface never needs to know
		 * one. Every surface here targets its conversation (`session`). The query
		 * string doubles as the cache key.
		 *
		 * The two optional additions, each an explicit request:
		 *   - `detail=1` — recent commits and stash for the chip's hover card;
		 *   - `pr=1` — the branch's GitHub PR/CI state, which both the chip and
		 *     the row token need (the leading glyph and the hover card share this
		 *     exact key, so they cost one request between them).
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

		function subscribeGitEvents(onChange) {
			eventListeners.add(onChange);
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
				if (eventListeners.size === 0 && eventSource !== null) {
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
		 * chip renders without them and only starts paying for a `log -10` plus a
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
					GIT_CACHE.set(cacheKey, { data });
					if (GIT_CACHE.size > GIT_CACHE_LIMIT) {
						GIT_CACHE.delete(GIT_CACHE.keys().next().value);
					}
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
		 * The actions BOTH surfaces render — the server's list, verbatim.
		 *
		 * This half used to re-derive pull/push/commit/pr from the raw counts,
		 * which meant two implementations of the same conditions drifting apart:
		 * the card once promoted a client-only extra into its action row, and
		 * `/gh pr` was offered on the default branch. The node half owns the
		 * rules and the ranking now; the client adds presentation only — the risk
		 * gate for `clean`, and the labels.
		 */
		function ghSkillActions(info) {
			if (info === void 0 || info === null || info.git !== true) return [];
			return Array.isArray(info.actions) ? info.actions : [];
		}

		/**
		 * The risk gate the menu shows for `/gh clean`, in the host's own
		 * confirmation shape (RiskConfirmation: title, description, an acknowledge
		 * checkbox, two button labels). Confirm stays disabled until the box is
		 * ticked — that is the "are you sure?", before the invocation is even sent.
		 * The agent then re-establishes the exact list with `git clean -n` and asks
		 * again: two gates, because this one names the risk and that one names the
		 * files.
		 */
		function cleanGate() {
			return {
				title: "Remove untracked files?",
				description: "Untracked files have no reflog and no stash entry — once removed they cannot be recovered. The agent will show the exact list (`git clean -n`) and ask again before removing anything.",
				acknowledgeLabel: "I understand untracked files cannot be recovered",
				cancelLabel: "Cancel",
				confirmLabel: "Continue"
			};
		}

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
		/**
		 * The upstream sync arrows (" ↑1 ↓2"), or "". Split out from the file
		 * count so each rides the surface that OWNS it: the arrows belong to the
		 * branch (they are the branch's standing against its upstream, and the
		 * branch name's hover and compare link cover them), while ✎n belongs to the
		 * count's names tooltip.
		 */
		function formatSync(info) {
			const hasUpstream = info.ahead !== void 0 || info.behind !== void 0;
			const files = (info.changedFiles || 0) + (info.untrackedFiles || 0);
			if (!hasUpstream || (files === 0 && !(info.ahead > 0) && !(info.behind > 0))) return "";
			return " \u2191" + (info.ahead || 0) + " \u2193" + (info.behind || 0);
		}

		/** The ✎n file count (" ✎3"), or "". */
		function formatFileCount(info) {
			const files = (info.changedFiles || 0) + (info.untrackedFiles || 0);
			return files > 0 ? " \u270E" + files : "";
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
		/** The PR's state label, defaulting to "no checks". */
		function prStateLabel(pr) {
			return PR_STATE_LABEL[pr.state] === void 0 ? PR_STATE_LABEL.none : PR_STATE_LABEL[pr.state];
		}

		/**
		 * The CI state -> colour, for the token's STATE GLYPH only. The number and
		 * the link keep the chip's own muted colour, so the token still reads as one
		 * row and only the state shouts. These are the same app state tokens the
		 * action glyph uses.
		 */
		const PR_STATE_COLOUR = {
			passing: "var(--dsw-alias-state-success-primary, #30a46c)",
			pending: "var(--dsw-alias-state-warn-primary, #d29922)",
			failing: "var(--dsw-alias-state-error-primary, #e5484d)"
		};

		/** The PR token's parts, so its plain text and its coloured form cannot drift. */
		function prTokenParts(info) {
			const pr = info.pr;
			if (pr === void 0 || pr === null || pr.number === void 0) return null;
			const state = PR_STATE_GLYPH[pr.state] === void 0 ? "none" : pr.state;
			return {
				number: " PR#" + pr.number,
				glyph: PR_STATE_GLYPH[state],
				colour: PR_STATE_COLOUR[state] ?? META_STYLE.color,
				draft: pr.draft === true ? " draft" : ""
			};
		}

		/** The token's accessible name: "pull request 142, checks failing, draft". */
		function prTokenLabel(info) {
			const pr = info.pr;
			if (pr === void 0 || pr === null || pr.number === void 0) return void 0;
			const state = prStateLabel(pr);
			return "pull request " + pr.number + ", " + state + (pr.draft === true ? ", draft" : "");
		}

		/**
		 * The PR's web URL, or undefined — the token is a LINK only when the node
		 * half vouched for a URL, and is plain text otherwise (no `gh`, no GitHub
		 * remote, an unauthenticated `gh`: the token still appears, it just does not
		 * pretend to be clickable, so there is no dead link to discover).
		 *
		 * The protocol is re-checked HERE even though the node half already dropped
		 * a non-http(s) value: an `href` is the one place a payload string becomes
		 * executable, so the element that creates it verifies its own input rather
		 * than trusting an upstream guard to stay in place. The shell's own markdown
		 * renderer guards its links the same way.
		 */
		function prLinkUrl(info) {
			const pr = info.pr;
			if (pr === void 0 || pr === null || typeof pr.url !== "string") return void 0;
			try {
				const { protocol } = new URL(pr.url);
				return protocol === "http:" || protocol === "https:" ? pr.url : void 0;
			} catch {
				return void 0;
			}
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
		 * NOTE: a worktree's NAME is deliberately NOT part of the chip's text. It is
		 * long, it competes with the branch for the same glance, and the chip already
		 * says THAT the checkout is a worktree through the mark's shape. WHICH tree it
		 * is belongs to the hover card's `worktree` row — see worktreeDetail. (The
		 * old append-unless-redundant rule lived here; it is gone with the name.)
		 */

		const META_STYLE = {
			color: "var(--dsw-alias-label-tertiary, #9ea7ad)",
			fontSize: "12px",
			lineHeight: "20px",
			flex: "none",
			whiteSpace: "nowrap"
		};

		/**
		 * Session-row badge — the ACTION, and nothing else:
		 *   Session title…                                        merge
		 *
		 * An experiment in what a sidebar row is FOR. It used to carry the chip's mark
		 * plus a PR token; it now answers exactly one question — does this conversation
		 * need me? — in one word, and says nothing otherwise. The chip keeps the mark,
		 * the branch, the counts and the PR/CI token, because that is the surface for
		 * "where am I, and what is the state".
		 *
		 * Consequences, all deliberate: the row no longer shows local status (clean /
		 * dirty / ahead / behind) at a glance, no longer carries the worktree's tree
		 * SHAPE, and a silent row cannot distinguish "nothing to do" from "no PR" or
		 * "no gh". Those answers live in the hover line below, which also names the
		 * pull request the action refers to.
		 *
		 * Targets the row's `sessionId`: the node half resolves the session to the
		 * checkout it is working in. `workspaceId` arrives in the owner share and is
		 * deliberately unused — the flat and search lists render without one, which is
		 * what keeps badges off them.
		 *
		 * `pr: true` is what makes an action possible at all (`merge` especially). It
		 * costs one forge read per (repository, branch) per TTL, and the detail line
		 * below reuses THIS request rather than issuing its own.
		 */
		/**
		 * Severity -> colour. The NODE half decides the severity
		 * (`error` | `warn` | `success` | `business`) and every surface paints from
		 * that one field, so the chip and the row cannot disagree about how loud a
		 * state is. Colour here means SEVERITY — how much this needs you — rather
		 * than identity: a broken build and a conflict are the loud ones, a requested
		 * review is a nudge, `merge` is the all-clear, and routine work is the quiet
		 * blue end of the same ramp rather than outside it. The WORD remains the
		 * channel (colour only reinforces it), and the tokens are the app's own, so
		 * both themes work.
		 */
		const SEVERITY_FILL = {
			error: "var(--dsw-alias-state-error-primary, #e5484d)",
			warn: "var(--dsw-alias-state-warn-primary, #d29922)",
			success: "var(--dsw-alias-state-success-primary, #30a46c)",
			business: "var(--dsw-alias-state-business-primary, #3b82f6)"
		};

		/**
		 * Action -> TEXT glyph. The SHAPE channel for the five tokens whose icon is a
		 * character. The other six are DRAWN (see DRAWN_ICONS) and deliberately have
		 * NO entry here: a leftover text fallback would be a second, unreachable
		 * rendering of the same icon — and for `merge` it was exactly the check mark
		 * the drawn Octicon replaced.
		 *
		 * A missing entry degrades to the bare word.
		 */
		const ACTION_GLYPH = {
			resume: "\u23F5",
			resolve: "!",
			"fix CI": "\u2717",
			review: "\u25C6",
			commit: "\u271A"
		};

		/**
		 * The icons DRAWN rather than typed, each with its own grid and render size.
		 *
		 * `↑ ↓ ⇄ ↻` are hairline strokes in the shell's font, and no weight or size
		 * makes them as solid as the filled glyphs; these four are paths on a 12x12
		 * grid, painted with `currentColor`, so each arrow matches the text's weight
		 * and centres on it. `in sync` is drawn for the same reason: the idle disc
		 * must be exactly round, not a font's idea of a circle.
		 *
		 * `merge` is Remix Icon's `git-merge-line` (24x24), vendored VERBATIM rather
		 * than redrawn, and rendered at 16px to fill the row's 16px leading cell.
		 * Unicode has no merge glyph at all, so every tool draws this shape family.
		 * Its ink is inset (about 16 of its 24 units), so at 16px it puts down
		 * ~10.7px — the arrows' weight, which a 12px render would miss.
		 *
		 * The other five tokens stay text.
		 */
		const DRAWN_ICONS = {
			push: { size: 12, viewBox: "0 0 12 12", shapes: [{ d: "M6 1 L10.6 6.6 H7.5 V11 H4.5 V6.6 H1.4 Z" }] },
			pull: { size: 12, viewBox: "0 0 12 12", shapes: [{ d: "M6 11 L1.4 5.4 H4.5 V1 H7.5 V5.4 H10.6 Z" }] },
			sync: {
				size: 12,
				viewBox: "0 0 12 12",
				shapes: [
					{ d: "M1.5 3.4 H8.4 V2 L11 4 L8.4 6 V4.6 H1.5 Z" },
					{ d: "M10.5 8.6 H3.6 V10 L1 8 L3.6 6 V7.4 H10.5 Z" }
				]
			},
			update: {
				size: 12,
				viewBox: "0 0 12 12",
				shapes: [
					{ d: "M6 1.9 A4.1 4.1 0 1 1 1.9 6", stroke: true },
					{ d: "M4.3 0.4 L8.3 1.9 L4.3 3.4 Z" }
				]
			},
			"in sync": { size: 12, viewBox: "0 0 12 12", shapes: [{ circle: true }] },
			// Remix Icon `git-merge-line` (24x24), vendored verbatim from
			// https://github.com/Remix-Design/RemixIcon/blob/master/icons/Development/git-merge-line.svg
			// EXP-1: this is an experiment. Swapping back to GitHub's Octicon
			// `git-merge` is this one entry — a 16x16 grid, same shape family.
			merge: {
				size: 16,
				viewBox: "0 0 24 24",
				shapes: [{ d: "M7.10508 8.78991C7.45179 10.0635 8.61653 11 10 11H14C16.4703 11 18.5222 12.7915 18.9274 15.1461C20.1303 15.5367 21 16.6668 21 18C21 19.6569 19.6569 21 18 21C16.3431 21 15 19.6569 15 18C15 16.7334 15.7849 15.6501 16.8949 15.2101C16.5482 13.9365 15.3835 13 14 13H10C8.87439 13 7.83566 12.6281 7 12.0004V15.1707C8.16519 15.5825 9 16.6938 9 18C9 19.6569 7.65685 21 6 21C4.34315 21 3 19.6569 3 18C3 16.6938 3.83481 15.5825 5 15.1707V8.82929C3.83481 8.41746 3 7.30622 3 6C3 4.34315 4.34315 3 6 3C7.65685 3 9 4.34315 9 6C9 7.26661 8.21506 8.34988 7.10508 8.78991ZM6 7C6.55228 7 7 6.55228 7 6C7 5.44772 6.55228 5 6 5C5.44772 5 5 5.44772 5 6C5 6.55228 5.44772 7 6 7ZM6 19C6.55228 19 7 18.5523 7 18C7 17.4477 6.55228 17 6 17C5.44772 17 5 17.4477 5 18C5 18.5523 5.44772 19 6 19ZM18 19C18.5523 19 19 18.5523 19 18C19 17.4477 18.5523 17 18 17C17.4477 17 17 17.4477 17 18C17 18.5523 17.4477 19 18 19Z" }]
			}
		};

		/**
		 * The icon NODE: a drawn shape for the six drawn tokens, a text glyph for the
		 * rest. The parent span carries the accessible name, so the drawing is
		 * decoration (`aria-hidden`).
		 */
		function actionGlyphNode(token) {
			const icon = DRAWN_ICONS[token];
			if (icon === void 0) return ACTION_GLYPH[token] ?? token;
			return react_jsx_runtime.jsx("svg", {
				viewBox: icon.viewBox,
				width: icon.size,
				height: icon.size,
				"aria-hidden": true,
				focusable: "false",
				style: { display: "block", flex: "none", color: "inherit" },
				children: icon.shapes.map((shape, index) => shape.circle === true
					? react_jsx_runtime.jsx("circle", {
						cx: shape.cx ?? 6,
						cy: shape.cy ?? 6,
						r: shape.r ?? 5,
						fill: "currentColor"
					}, "shape-" + index)
					: react_jsx_runtime.jsx("path", shape.stroke === true
						? { d: shape.d, fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }
						: { d: shape.d, fill: "currentColor" }, "shape-" + index))
			});
		}

		/**
		 * The icon's own type style, for the TEXT glyphs only. A drawn arrow is a
		 * fixed 12px box, so size and weight do not apply to it; the six text glyphs
		 * sit one pixel larger than the surrounding 12px text.
		 */
		const GLYPH_TEXT = { fontSize: "13px" };

		/**
		 * The row's own run state, from the shell's standard kit.
		 *
		 * The renderer that assembles slots hands EVERY entry the sessions store as
		 * a selector hook (`useSessions`) — the same kit that supplies
		 * `useWorkspaces` — which is how a row can tell an idle session from one
		 * mid-turn without the row slot having to carry it. A shell that does not
		 * seed that kit leaves the prop undefined: then we cannot know, and the
		 * glyph behaves exactly as it did before rather than guessing "idle".
		 *
		 * One helper and one call site, so the hook order is identical on every path
		 * (the fallback is a plain function, never a hook).
		 */
		function useSessionRunning(useSessions, sessionId) {
			const select = typeof useSessions === "function" ? useSessions : () => void 0;
			return select((state) => state?.byId?.[sessionId]?.running) === true;
		}

		/**
		 * Report the idle gate ONCE, the way the boot diagnostics report the
		 * Tooltip primitive. Whether the shell actually handed a slot the
		 * sessions store is invisible from anywhere else, and a gate that silently
		 * never fires is indistinguishable from a gate that never needed to.
		 */
		let idleGateReported = false;
		function reportIdleGate(present) {
			if (idleGateReported) return;
			idleGateReported = true;
			console.info(
				"[dsh-git-badge] session-row idle gate = " +
					(present
						? "on (the standard kit supplies useSessions)."
						: "off (no useSessions prop) — the token cannot tell a running turn, so it shows as before.")
			);
		}

		/**
		 * The leading-cell token glyph — the row's compact signal, on upstream's
		 * own `sidebar.session.row.leading` seat. No patch and no seam.
		 *
		 * It asks for PR state too (`pr: true`), the SAME query the row card uses,
		 * so the glyph shows the same PR tokens (`merge`, `review`, `fix CI`) as
		 * the card — not only the local ones. The matching query string means the
		 * glyph and the card share one cache entry and one in-flight read. The
		 * price is one forge read per row per TTL.
		 *
		 * Geometry: the cell is `width:16px; flex:none` and the row has `gap:0`, so
		 * a word would overflow into the title. Only one glyph is drawn, and no
		 * wrapper changes the cell's box.
		 *
		 * The glyph is NOT `aria-hidden`: with no word beside it, it is the
		 * accessible name. With nothing to say the cell renders NOTHING: no token
		 * means no action, so there is no icon and no colour to explain.
		 *
		 * It carries NO hover of its own. The row is already a HoverCard anchor,
		 * and the explanation rides the row's own card (SessionGitDetail) — so
		 * hovering the glyph shows exactly what hovering the session line shows.
		 */
		function LeadingTokenGlyph({ sessionId, useSessions }) {
			const info = useGitStatus(sessionId === void 0 ? void 0 : { kind: "session", id: sessionId }, { pr: true });
			const running = useSessionRunning(useSessions, sessionId);
			reportIdleGate(typeof useSessions === "function");
			if (running) return null;
			if (sessionId === void 0 || info === void 0 || info.git !== true) return null;
			const token = info.rowToken;
			if (typeof token === "string" && token !== "") {
				const colour = SEVERITY_FILL[info.rowSeverity];
				return react_jsx_runtime.jsx("span", {
					role: "img",
					"aria-label": "git action: " + token,
					style: { ...META_STYLE, ...(colour === void 0 ? {} : { color: colour }), ...GLYPH_TEXT, display: "inline-flex", alignItems: "center" },
					children: actionGlyphNode(token)
				});
			}
			return null;
		}

		const CARD_CONTAINER = {
			display: "flex",
			flexDirection: "column",
			gap: "4px",
			fontSize: "12px",
			lineHeight: "18px",
			// Auto-width: the card fits its widest row instead of a guessed
			// constant, capped at 600px. The Tooltip's maxWidth must stay >= the
			// cap or IT becomes the clamp.
			width: "max-content",
			maxWidth: "600px"
		};
		const CARD_ROW = { display: "flex", gap: "8px", alignItems: "baseline" };
		const CARD_LABEL = { color: "var(--dsw-alias-label-tertiary, #9ea7ad)", flex: "none", minWidth: "62px" };
		const CARD_VALUE = { minWidth: 0, overflowWrap: "anywhere", whiteSpace: "normal" };
		// The chip card's HEADER: the action sentence as a heading, not a labelled
		// row. `fontWeight` is also the hook the suite uses to find it.
		const CHIP_HEADER = { display: "flex", alignItems: "baseline", gap: "6px", fontWeight: 600 };
		// A section rule between the checkout rows and the branch rows. The label
		// makes the split explicit instead of leaving `state`/`base` to look like
		// more checkout detail.
		const CARD_DIVIDER = {
			marginTop: "4px",
			paddingTop: "6px",
			borderTop: ".5px solid var(--dsw-alias-border-l4, #e4e8eb)",
			color: "var(--dsw-alias-label-tertiary, #9ea7ad)",
			fontSize: "10px",
			lineHeight: "14px",
			letterSpacing: ".08em",
			textTransform: "uppercase"
		};

		/** One label/value row — the shape every hover body shares. */
		function cardRow(label, value) {
			return react_jsx_runtime.jsxs("div", {
				style: CARD_ROW,
				children: [
					react_jsx_runtime.jsx("span", { style: CARD_LABEL, children: label }),
					react_jsx_runtime.jsx("span", { style: CARD_VALUE, children: value })
				]
			}, label);
		}

		/** Push one label/value row unless the value is empty. */
		function addRow(rows, label, value) {
			if (value === void 0 || value === null || value === "") return;
			rows.push(cardRow(label, value));
		}

		/**
		 * The action SENTENCE as a raw value. SHARED by the session-row card
		 * (actionRow wraps it in the card label/value shape) and the chip card
		 * (actionHeader wraps it in a heading), so the two cannot describe the icon
		 * differently. Returns undefined when the checkout has no token.
		 *
		 * The glyph is DECORATION here: the word follows it, so `aria-hidden` keeps
		 * the accessible name the bare action.
		 */
		function actionRow(info) {
			const token = info?.rowToken;
			if (typeof token !== "string" || token === "") return void 0;
			const why = typeof info.rowTokenWhy === "string" && info.rowTokenWhy !== "" ? info.rowTokenWhy : void 0;
			const colour = SEVERITY_FILL[info.rowSeverity];
			const value = [];
			if (DRAWN_ICONS[token] !== void 0 || ACTION_GLYPH[token] !== void 0) {
				value.push(react_jsx_runtime.jsx("span", {
					"aria-hidden": true,
					style: { color: colour === void 0 ? META_STYLE.color : colour, fontWeight: 700, display: "inline-flex", alignItems: "center" },
					children: actionGlyphNode(token)
				}, "action-glyph"));
				value.push(" ");
			}
			value.push(token + (why === void 0 ? "" : " \u2014 " + why));
			return value;
		}

		/**
		 * The chip card's HEADER: the same sentence actionRow produces, rendered as a
		 * heading so the checkout's verdict leads the card instead of sitting in a
		 * labelled row. It calls actionRow, so the two surfaces cannot drift.
		 */
		function actionHeader(info) {
			const value = actionRow(info);
			if (value === void 0) return void 0;
			return react_jsx_runtime.jsx("div", { style: CHIP_HEADER, children: value }, "action-header");
		}

		/**
		 * Session-row hover card — everything the action glyph cannot say: what the
		 * action means and why, which checkout the row's status describes, and which
		 * pull request it refers to. It renders through the upstream
		 * sidebar.session.row.hover seat, inside the card upstream already opens for
		 * a row.
		 *
		 * LABEL/VALUE ROWS, the shape the chip card uses. The `action` row comes from
		 * the shared actionRow() helper, so the two cards cannot describe the icon
		 * differently; `checkout` and `pull request` follow.
		 *
		 * This matters MORE now that the row shows only a glyph: `merge` with no way
		 * to see merge WHAT would be a nag rather than a hint, so the card renders
		 * whenever there is something to name — the row's action, a worktree, a pull
		 * request, or any combination.
		 *
		 * It makes no request of its own: the same `{ pr: true }` query as the
		 * leading glyph resolves to the same cache key, so a card that mounts for
		 * every row still costs one fetch per row, and a cold cache is served by
		 * the glyph's own in-flight request.
		 *
		 * Only a WORKTREE's checkout is spelled out. For a main checkout the branch is
		 * the ordinary case and repeating it on every session's card would be noise;
		 * a tree, by contrast, is exactly what the row's own title cannot tell you.
		 */
		function SessionGitDetail({ sessionId }) {
			const info = useGitStatus(sessionId === void 0 ? void 0 : { kind: "session", id: sessionId }, { pr: true });
			if (info === void 0 || info.git !== true) return null;
			const rows = [];
			const add = (label, value) => addRow(rows, label, value);
			// The HEADER, the shape the chip card leads with: the same sentence from
			// the same actionRow, so the two cards cannot describe the icon
			// differently, and the sentence gains the 62px label column's width.
			const header = actionHeader(info);
			if (header !== void 0) rows.push(header);
			if (info.isWorktree === true) {
				// WHICH tree, not just that there is one: the row's glyph cannot say
				// it, and the branch is ordinary for a main checkout.
				const name = typeof info.worktreeName === "string" ? info.worktreeName : "";
				add("checkout", name === "" ? String(info.branch) : name + " on " + info.branch);
			}
			// The dirty breakdown, so a higher-ranked token cannot hide uncommitted
			// work. formatFileBreakdown says "clean" when there is none; a clean row
			// keeps its short card.
			const changes = formatFileBreakdown(info);
			if (changes !== "clean") add("changes", changes);
			add("pull request", formatPrDetail(info.pr));
			if (rows.length === 0) return null;
			// The row's hover card is upstream's FIXED-WIDTH box: HoverCard.module.css
			// pins `.card` to 244px. `width: max-content` (CARD_CONTAINER) would
			// overflow it, so the stack FILLS the box instead and the value cells wrap
			// inside it. The chip card is different — its Tooltip sizes to the content,
			// so it keeps max-content.
			return react_jsx_runtime.jsx("div", {
				style: { ...CARD_CONTAINER, width: "100%", maxWidth: "100%" },
				children: rows
			});
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
			const state = prStateLabel(pr);
			const bits = ["#" + pr.number, state];
			if (pr.draft === true) bits.push("draft");
			if (pr.review !== void 0) bits.push(String(pr.review).toLowerCase().replace(/_/g, " "));
			if (pr.open === false) bits.push("not open");
			return bits.join(" \u00B7 ");
		}

		/**
		 * The `checkout` row: the directory the CONVERSATION itself names, present
		 * only when the badge is describing a FOLLOWED worktree instead. The chip's
		 * branch and counts are the tree's in that case, so without this row the
		 * checkout's own state is nowhere on screen. Branch, then files (or "clean"),
		 * then sync counts only when they are nonzero — the chip's own rule.
		 */
		function formatCheckoutDetail(checkout) {
			if (checkout === void 0 || checkout === null || typeof checkout.branch !== "string") return void 0;
			const files = (checkout.changedFiles || 0) + (checkout.untrackedFiles || 0);
			const bits = [checkout.branch, files > 0 ? "\u270E" + files : "clean"];
			if ((checkout.ahead || 0) > 0 || (checkout.behind || 0) > 0) {
				bits.push("\u2191" + (checkout.ahead || 0) + " \u2193" + (checkout.behind || 0));
			}
			return bits.join(" \u00B7 ");
		}

		/**
		 * The `worktree` row: WHICH linked worktree the badge is describing. The chip
		 * names only the branch (see the note above formatOperationToken), so the
		 * card is the one place a tree is identified — the mark's shape can only say
		 * *that* the checkout is a worktree, never which.
		 */
		function worktreeDetail(info) {
			if (info === void 0 || info === null || info.isWorktree !== true) return void 0;
			const name = typeof info.worktreeName === "string" ? info.worktreeName : "";
			if (name === "") return void 0;
			return name;
		}

		/**
		 * The `worktrees` row: how many LINKED worktrees this repository has while
		 * the badge follows none of them.
		 *
		 * It earns its place on one thing only — the failure it makes visible. A
		 * registration is written outside the repository, so a file sandbox or a
		 * read-only home can refuse it. When that happens the badge silently keeps
		 * describing the session's own checkout, and the agent's work sits in a tree
		 * the UI never names. That state is indistinguishable from a session with
		 * nothing to follow, so the card is the only place it can be said. The node
		 * half computes it under `detail=1` only, so nothing at rest pays for it.
		 */
		function linkedWorktreesDetail(info) {
			const linked = info?.linkedWorktrees;
			if (typeof linked !== "number" || linked <= 0) return void 0;
			return linked + " linked \u00B7 none registered \u2014 npx dsh-git-badge checkout <path>";
		}

		/**
		 * ONE commit line, shared by the branch hover and the PR token's hover so
		 * the two cannot drift apart again: a fixed-width monospace hash cell, so
		 * every description starts on the same column and the list reads as a
		 * table, then `subject · age`. `sign` belongs to the branch hover — "+"
		 * (only on this branch) or "−" (only on main); the PR list passes none,
		 * because all of its commits are `base..HEAD`.
		 *
		 * The cell needs `display: inline-block` for `minWidth` to mean anything: an
		 * inline span ignores it, which is exactly how the PR list came to render a
		 * hash with NO gap at all — it reused the card's label style, whose
		 * `minWidth` and `flex` only do anything inside a flex row.
		 */
		function CommitLine({ commit, sign = "" }) {
			return react_jsx_runtime.jsxs("span", {
				style: { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
				children: [
					react_jsx_runtime.jsx("span", {
						style: {
							color: "var(--dsw-alias-label-tertiary, #9ea7ad)",
							fontFamily: "monospace",
							display: "inline-block",
							minWidth: "68px",
							flex: "none"
						},
						children: sign + commit.hash
					}),
					commit.subject + (commit.when === "" ? "" : "  \u00B7 " + shortWhen(commit.when))
				]
			});
		}

		/**
		 * The PR token's own hover body — the commits IN THIS PULL REQUEST
		 * (`base..HEAD`), and nothing else: the token already says the number and
		 * CI state, so the one question left is "what is in it?". Same line format
		 * as the branch hover's commit list (see CommitLine — one renderer, so the
		 * columns line up in both by construction), and the card's own width
		 * behaviour: full-width lines, nowrap, ellipsis.
		 */
		function PrCommitsList({ info, pending = false }) {
			const commits = info?.prCommits;
			if (!Array.isArray(commits) || commits.length === 0) {
				// `pending`: the detail payload has not landed yet, so "no commits"
				// would be a false negative — name the pull request the token points
				// at instead, the way the mark's card degrades to the base response.
				if (pending) {
					return react_jsx_runtime.jsx("span", { style: CARD_CONTAINER, children: formatPrDetail(info?.pr) ?? "loading\u2026" });
				}
				return react_jsx_runtime.jsx("span", { style: CARD_CONTAINER, children: "no commits beyond the base branch" });
			}
			return react_jsx_runtime.jsxs("div", { style: CARD_CONTAINER, children: [
				react_jsx_runtime.jsxs("div", {
					style: { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 },
					children: [
						...commits.map((commit) => react_jsx_runtime.jsx(CommitLine, { commit }, commit.hash)),
						(typeof info.prCommitsTotal === "number" && info.prCommitsTotal > commits.length
							? "\u2026 and " + (info.prCommitsTotal - commits.length) + " more"
							: null)
					]
				})
			] });
		}

		/**
		 * The ✎n count's own hover body — the changed-file lists and NOTHING
		 * else: the full card stays on the status mark, and this tooltip answers
		 * the one question the count poses ("what are these?"). One stacked
		 * column with sub-headers: UNSTAGED (tracked, edited — valid regardless
		 * of the collapsed untracked retry) then UNTRACKED. Reads the same lazy
		 * detail payload the mark's card uses. The wrapper is always mounted (see
		 * withTooltip) and the label degrades while the names are in flight: the
		 * COUNTS are already in the base response, so it restates the breakdown
		 * rather than claiming an empty list. "no changed files" is reserved for a
		 * landed payload that genuinely has no names.
		 */
		function CountNames({ info, pending = false }) {
			const sections = [
				{
					label: "staged",
					names: info?.stagedNames,
					total: info?.stagedNamesTotal
				},
				{
					label: "unstaged",
					names: info?.unstagedNames,
					total: info?.unstagedNamesTotal
				},
				{
					label: "untracked",
					names: info?.untrackedNames,
					total: info?.untrackedNamesTotal
				}
			].filter((section) => Array.isArray(section.names) && section.names.length > 0);
			if (sections.length === 0) {
				// `pending`: the names have not been fetched yet, but the COUNTS have —
				// restate those rather than the false "no changed files".
				if (pending) {
					return react_jsx_runtime.jsx("span", { style: CARD_CONTAINER, children: formatFileBreakdown(info) });
				}
				return react_jsx_runtime.jsx("span", { style: CARD_CONTAINER, children: "no changed files" });
			}
			return react_jsx_runtime.jsxs("div", { style: CARD_CONTAINER, children:
				sections.map((section) => react_jsx_runtime.jsxs("div", { style: CARD_ROW, children: [
					react_jsx_runtime.jsx("span", { style: CARD_LABEL, children: section.label }),
					react_jsx_runtime.jsx("span", {
						style: { ...CARD_VALUE, display: "flex", flexDirection: "column", gap: "2px" },
						children: [
							...section.names.map((name) => react_jsx_runtime.jsx("span", { children: name }, section.label + name)),
							(typeof section.total === "number" && section.total > section.names.length
								? "\u2026 and " + (section.total - section.names.length) + " more"
								: null)
						]
					})
				] }, section.label))
			});
		}

		/**
		 * Compress git's relative age to its shortest honest form: 43 seconds
		 * ago -> 43s ago, 2 hours ago -> 2h ago, weeks -> w, months -> mo (to
		 * stay distinct from minutes), years -> y.
		 */
		function shortWhen(when) {
			return String(when)
				.replace(/(\d+) seconds? ago/u, "$1s ago")
				.replace(/(\d+) minutes? ago/u, "$1m ago")
				.replace(/(\d+) hours? ago/u, "$1h ago")
				.replace(/(\d+) days? ago/u, "$1d ago")
				.replace(/(\d+) weeks? ago/u, "$1w ago")
				.replace(/(\d+) months? ago/u, "$1mo ago")
				.replace(/(\d+) years? ago/u, "$1y ago");
		}

		/**
		 * The branch LINEAGE rows, for the chip's one card. The state row always
		 * renders (the pull-request verdict, or the base-branch note); the base row
		 * follows when the counts are known; then the branch's last 10 commits
		 * (WHAT THIS BRANCH HAS, full stop — no base-relative filtering, which
		 * empties on every push or merge). The pull request has no row here — the
		 * chip's own PR token already carries number, CI state and the link.
		 */
		function lineageRows(info) {
			const rows = [];
			const add = (label, value) => addRow(rows, label, value);
			// The STATE row always renders. The old upstream and sync rows spoke
			// about the push axis (the branch's own remote), which the state row
			// subsumes: the merge verdict is the fact that matters. The base counts
			// stay a SEPARATE row below, so a reader never reconstructs either.
			const pr = info?.pr;
			const stateParts = [];
			if (pr !== void 0 && pr !== null && pr.number !== void 0) {
				if (pr.draft === true) stateParts.push("blocked: draft");
				else if (pr.mergeState === "BLOCKED") {
					stateParts.push(pr.review === "REVIEW_REQUIRED" ? "blocked: review required"
						: pr.state === "failing" ? "blocked: checks failing"
						: "blocked");
				} else if (pr.state === "failing") stateParts.push("blocked: checks failing");
				else if (pr.mergeState === "CLEAN" || (pr.state === "passing" && pr.review === "APPROVED")) stateParts.push("ready to merge");
				else if (pr.review === "REVIEW_REQUIRED") stateParts.push("blocked: review required");
			} else if (info?.defaultBranch === true) {
				// The default branch is the BASE, not a branch with a missing PR:
				// pull requests merge INTO it and none is ever opened FROM it, so
				// "no pull request" here reads as a nag for something that cannot
				// exist. The node half computes `defaultBranch` for exactly this
				// suppression (see the comment where it is set in lib/index.js);
				// until now only the action rules consulted it, not this row.
				stateParts.push("base branch \u00B7 pull requests merge into this");
			} else {
				stateParts.push("no pull request");
			}
			// The state row states the PR verdict and nothing else.
			add("state", stateParts.join(" \u00B7 "));
			// The counts are this branch's standing against its BASE, so on the base
			// itself they are self-referential ("N ahead, M behind main" while ON
			// main) and the divergence they would state is already the chip's own
			// \u2191a \u2193b token. Suppress them on the default branch, with or without a
			// PR. A SEPARATE row from state: whether the PR can merge and how far the
			// branch is from its base are two facts, so neither hides the other.
			if (info?.defaultBranch !== true && (info?.mainAhead !== void 0 || info?.mainBehind !== void 0)) {
				add("base", (info.mainAhead || 0) + " ahead, " + (info.mainBehind || 0) + " behind main");
			}
			const commits = info?.branchCommits;
			if (Array.isArray(commits) && commits.length > 0) {
				// Full-width block, not the label/value two-column row: commit lines
				// use the card's whole width, and each line is nowrap with CSS
				// ellipsis so long subjects clip at the edge instead of pushing the
				// card out. `when` is compressed the way git log users shorten it:
				// 43 seconds ago -> 43s ago.
				rows.push(
					react_jsx_runtime.jsxs("div", {
						style: { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 },
						children:
							commits.map((commit) => react_jsx_runtime.jsx(CommitLine, {
								commit,
								sign: commit.sign === "+" ? "+" : commit.sign === "\u2212" ? "\u2212" : ""
							}, commit.hash))
					}, "branch-commits")
				);
			}
			// NO pull-request row: the chip's own PR token (number, CI state, link)
			// carries it — a second rendering two pixels away is pure duplication.
			return rows;
		}

		// The host's plugin-card chrome, reproduced inline: its CSS module is not
		// exported to plugins, so these values mirror PluginCard.module.css so our
		// card sits in the same list as its siblings.
		const CARD_BASE = {
			border: ".5px solid var(--dsw-alias-border-l4, #e4e8eb)",
			borderRadius: "16px",
			listStyle: "none",
			transition: "border-color .16s, background .16s"
		};
		const CARD_CLOSED = { ...CARD_BASE, background: "var(--dsw-alias-bg-layer-3, #ffffff)" };
		const CARD_OPEN = {
			...CARD_BASE,
			background: "var(--dsw-alias-bg-layer-2, #f7f8f9)",
			borderColor: "var(--dsw-alias-label-dimmed, #b8bfc4)"
		};
		const CARD_HEADER = {
			appearance: "none",
			width: "100%",
			font: "inherit",
			color: "inherit",
			textAlign: "left",
			cursor: "pointer",
			background: "none",
			border: 0,
			borderRadius: "12px",
			display: "flex",
			alignItems: "center",
			gap: "12px",
			padding: "14px 16px"
		};
		const CARD_NAME = { color: "var(--dsw-alias-label-primary, #1f2328)", fontSize: "15px", fontWeight: "600", lineHeight: "1.4" };
		const CARD_DESCRIPTION = { color: "var(--dsw-alias-label-tertiary, #9ea7ad)", fontSize: "13px", lineHeight: "1.5" };

		const CARD_BUTTON = {
			cursor: "pointer",
			color: "inherit",
			background: "none",
			border: "1px solid var(--dsw-alias-border-secondary, #d0d7de)",
			borderRadius: "4px",
			fontSize: "11px",
			lineHeight: "18px",
			padding: "0 6px",
			flex: "none"
		};

		/**
		 * The checkout's verdict rows, for the chip's one card — INPUT CHIP ONLY.
		 * Pure presentation over fields the status response already carries, plus
		 * the `detail=1` additions (recent commits, stash) when they have arrived.
		 * Everything is spelled out in text, so no fact here depends on a colour or
		 * a glyph.
		 */
		function statusRows(info, detail) {
			// the detail payload is a superset of the plain one, so it wins when it
			// has landed; until then the card still shows the base facts
			const data = detail === void 0 ? info : detail;
			const rows = [];
			const add = (label, value) => addRow(rows, label, value);
			// The ACTION header, first: the SAME sentence the session-row card renders,
			// from the same helper, so the chip card explains the icon the row shows.
			// It is a heading, not a labelled row, so the verdict leads the card.
			const header = actionHeader(data);
			if (header !== void 0) rows.push(header);
			// The "next step" row — the SERVER's ranked suggestion, and nothing else. The
			// client's extras (secondary picker entries) must never promote
			// themselves into this line: when the server says there is nothing to do
			// — clean and synced — the row is omitted, and "no suggestion" stays a
			// suggestion. Plain text, no affordance: the actionable surface is the
			// (+) menu's /gh picker, and this row is the read-only pointer to it.
			const topAction = data.next;
			if (topAction !== void 0) {
				// git-comment convention: the invocation, two spaces, then "# "
				// plus what it does. The marker makes the one actionable line findable
				// among the detail rows.
				add("next step", "\u25B8 /gh " + topAction.args + "  # " + topAction.what);
			}
			// The branch lineage rows (branch, upstream, sync, pull request) moved
			// to the branch NAME's hover — the card is the checkout's verdict, not
			// the branch's CV. The branch name is also the chip's own text, so a
			// card row for it was pure repetition.
			add("changes", formatFileBreakdown(data));
			add("operation", data.operation === void 0 || data.operation === null ? void 0 : String(data.operation));
			// WHICH checkout the badge describes, when it is a worktree. The chip shows
			// the branch alone, so this row is the only place the tree is named.
			add("worktree", worktreeDetail(data));
			// The linked-but-unregistered state — the on-screen difference between
			// "nothing to follow" and "the registration could not be written". Rides
			// the detail payload, so it appears once the hover has fetched, exactly
			// like the `checkout` row below it.
			add("worktrees", linkedWorktreesDetail(data));
			// The conversation's OWN directory, present only when the badge is
			// describing a followed worktree — the chip's branch and counts are the
			// tree's in that case, so this is where the checkout's own state stays
			// visible. Labelled `own checkout` because `checkout` now names the
			// checkout a session-row card describes. Absent until the `detail=1`
			// response lands, like commits/stash.
			if (data.worktreeFollowed === true) add("own checkout", formatCheckoutDetail(data.checkout));
			add("stash", data.stashCount === void 0 ? void 0 : data.stashCount + " stashed");
			return rows;
		}

		/**
		 * The chip's ONE card, behind the leading cluster (the action glyph and the
		 * branch name together). It stacks the checkout's verdict rows over the
		 * branch's lineage rows, so one hover answers both "what is this checkout
		 * doing" and "what is on this branch".
		 *
		 * One card, not two: the glyph and the branch are one target, and the branch
		 * is the element that always exists — so a clean checkout, which has no
		 * glyph, still opens the card from its branch name.
		 */
		function ChipCard({ info, detail }) {
			const data = detail === void 0 ? info : detail;
			const rows = statusRows(info, detail);
			const lineage = lineageRows(data);
			return react_jsx_runtime.jsx("div", {
				style: CARD_CONTAINER,
				children: [
					...rows,
					lineage.length === 0 ? null : react_jsx_runtime.jsx("div", { style: CARD_DIVIDER, children: "branch" }, "branch-divider"),
					...lineage
				]
			});
		}

		//#region composer chip (upstream additive surface: conversation.input.left)
		/**
		 * The ONE copy of the hover-card degrade rule: wrap a node in the shell's
		 * Tooltip when the primitive exists, and render the node bare otherwise — a
		 * missing card is a smaller failure than a missing badge. `label` is the
		 * thunk the Tooltip calls only when it opens, so the card's element tree
		 * stays out of closed tooltips.
		 *
		 * ALWAYS mount the wrapper — never conditionally, once its data arrives.
		 * The primitive is uncontrolled (it has no `open` prop) and opens on the
		 * CHILD's mouseenter, so a wrapper mounted after the pointer is already
		 * inside can never open for that visit: the pointer has to leave and
		 * return. Gate the LABEL's content instead.
		 */
		function withTooltip(node, label, maxWidth) {
			if (Tooltip === void 0) return node;
			return react_jsx_runtime.jsx(Tooltip, { side: "top", maxWidth, label, children: node });
		}

		/**
		 * The chip's leading action glyph, or null when the checkout needs none.
		 * The SAME token the sidebar row draws, in the node half's severity colour.
		 * No token means NO GLYPH: a clean, synced checkout has no action to triage,
		 * so it shows no icon rather than a decorative dot.
		 */
		function chipGlyphNode(info) {
			const token = info.rowToken;
			if (typeof token !== "string" || token === "") return null;
			return react_jsx_runtime.jsx("span", {
				key: "glyph",
				role: "img",
				"aria-label": "git action: " + token,
				style: { color: SEVERITY_FILL[info.rowSeverity] ?? META_STYLE.color, flex: "none", ...GLYPH_TEXT, display: "inline-flex", alignItems: "center" },
				children: actionGlyphNode(token)
			});
		}

		/**
		 * The shared anchor for the chip's two links — the branch compare link and
		 * the PR token. Both were near-identical `<a>` elements; this is the one
		 * copy of target, rel, cursor and handler wiring, so they cannot drift.
		 * `underline` is the hover/focus state and `children` is the label.
		 */
		function chipAnchor(props) {
			return react_jsx_runtime.jsx("a", {
				href: props.href,
				target: "_blank",
				rel: "noopener noreferrer",
				"aria-label": props.ariaLabel,
				onPointerEnter: props.onPointerEnter,
				onPointerLeave: props.onPointerLeave,
				onFocus: props.onFocus,
				onBlur: props.onBlur,
				style: {
					color: "inherit",
					textDecoration: props.underline ? "underline" : "none",
					cursor: "pointer"
				},
				children: props.children
			});
		}

		/**
		 * The branch name, as a compare anchor when the detail payload vouches an
		 * http(s) URL. The sync arrows ride WITH the branch: they are the branch's
		 * standing against its upstream, so the same hover and the same link cover
		 * them. The ✎n count keeps its own surface.
		 */
		function chipBranchInner(info, detail, isBranchLink, hoveredLink, setHovered, setHoveredLink) {
			const sync = formatSync(info);
			const branchLabel = info.branch + sync;
			if (!isBranchLink) return branchLabel;
			return chipAnchor({
				href: detail.compareUrl,
				ariaLabel: "Compare " + info.branch + " with main on GitHub" + (sync === "" ? "" : ", " + (info.ahead || 0) + " ahead and " + (info.behind || 0) + " behind upstream"),
				underline: hoveredLink === "branch",
				onPointerEnter: () => setHoveredLink("branch"),
				onPointerLeave: () => setHoveredLink(null),
				onFocus: () => { setHovered(true); setHoveredLink("branch"); },
				onBlur: () => setHoveredLink(null),
				children: branchLabel
			});
		}

		/**
		 * The LEADING CLUSTER — the action glyph (when the checkout needs one) and
		 * the branch name — wrapped in the one hover card. It is the chip card's ONLY
		 * anchor: pointer rest here enables the detail=1 fetch.
		 */
		function chipLeadingHover(info, detail, tokenGlyph, branchInner, isBranchLink, setHovered) {
			return withTooltip(
				react_jsx_runtime.jsx("span", {
					onPointerEnter: () => setHovered(true),
					style: { display: "inline-flex", alignItems: "center", gap: "6px", flex: "none", cursor: isBranchLink ? "pointer" : "default" },
					children: [tokenGlyph, react_jsx_runtime.jsx("span", { key: "branch", children: branchInner })]
				}),
				() => react_jsx_runtime.jsx(ChipCard, { info, detail }),
				600
			);
		}

		/**
		 * The ✎n count as its OWN hover surface: a names-only tooltip. It shares
		 * the mark's lazy detail fetch and degrades to a plain count without the
		 * Tooltip primitive.
		 */
		function chipCountHover(info, detail, setHovered) {
			const countText = formatFileCount(info);
			const count = react_jsx_runtime.jsx("span", {
				onPointerEnter: () => setHovered(true),
				style: { cursor: "default" },
				children: countText
			});
			const pending = detail === void 0 || detail === null;
			return withTooltip(count, () => react_jsx_runtime.jsx(CountNames, { info: detail ?? info, pending }), 480);
		}

		/**
		 * The PR token, with its own hover: the commits IN THIS PR. The token is its
		 * OWN detail gate: resting on it (or focusing it) enables the same `detail=1`
		 * fetch the mark and the branch do. ONE element, split so the STATE GLYPH can
		 * take the CI colour while the number keeps the chip's muted colour.
		 */
		function chipPrTokenHover(info, detail, hoveredLink, setHovered, setHoveredLink) {
			const prParts = prTokenParts(info);
			const prToken = prParts === null ? null : [
				prParts.number,
				prParts.glyph === "" ? null : react_jsx_runtime.jsx("span", {
					key: "pr-state",
					style: { color: prParts.colour },
					children: " " + prParts.glyph
				}),
				prParts.draft
			];
			const prUrl = prLinkUrl(info);
			const token = prUrl === void 0
				? react_jsx_runtime.jsx("span", {
					// the glyph is not the only channel: the token says what the CI state IS
					"aria-label": prTokenLabel(info),
					onPointerEnter: () => setHovered(true),
					style: { cursor: "default" },
					children: prToken
				})
				: chipAnchor({
					href: prUrl,
					ariaLabel: prTokenLabel(info) + ", opens on GitHub in a new tab",
					underline: hoveredLink === "pr",
					onPointerEnter: () => { setHovered(true); setHoveredLink("pr"); },
					onPointerLeave: () => setHoveredLink(null),
					onFocus: () => { setHovered(true); setHoveredLink("pr"); },
					onBlur: () => setHoveredLink(null),
					children: prToken
				});
			const pending = detail === void 0 || detail === null;
			return withTooltip(token, () => react_jsx_runtime.jsx(PrCommitsList, { info: detail ?? info, pending }), 480);
		}

		/** The chip row itself: leading cluster, operation text, count and PR token. */
		function chipAssemble(leadingHover, text, countHover, prTokenHover) {
			return react_jsx_runtime.jsxs("span", {
				style: {
					display: "inline-flex",
					alignItems: "center",
					flex: "none",
					// 6px, not 4px: the PR token leads with a space, and CSS drops leading
					// whitespace at the start of a flex item, so 4px read as no separation
					// at all between the branch and `PR#…`
					gap: "6px",
					color: "var(--dsw-alias-label-secondary, #5b6570)",
					fontSize: "12px",
					lineHeight: "24px",
					whiteSpace: "nowrap",
					cursor: "default"
				},
				children: [
					leadingHover,
					react_jsx_runtime.jsx("span", { key: "text", children: text }),
					countHover,
					prTokenHover
				]
			});
		}

		/**
		 * Chip line in the input row: git state of the workspace the CURRENT
		 * conversation is attached to. It targets the session id and lets the node
		 * half resolve the workspace, so this surface needs no `workspaces`
		 * service, no cwd and no path plumbing at all. `conversation.input.left`
		 * is an upstream additive slot, so it works on every install, and it stays
		 * useful next to the session row because it is context-anchored ("where am
		 * I") rather than surveying.
		 *
		 * This is the ONLY surface that asks the node half for the extras (`pr=1`
		 * always, `detail=1` on hover), because it is the only one that renders
		 * them — see targetQuery.
		 */
		function ComposerGitChip({ sessionId }) {
			const target = sessionId === void 0 ? void 0 : { kind: "session", id: sessionId };
			// the PR/CI token is always on the chip, so its fetch is not gated
			const info = useGitStatus(target, { pr: true });
			// The card's extras cost a `log -10` plus a stash list, so they are fetched
			// only once a pointer actually RESTS on the chip. A refresh fires on every
			// file edit, so eagerly asking would add both invocations to every refresh.
			const [hovered, setHovered] = react.useState(false);
			// Which of the chip's two links is hovered/focused — ONE enum, not two
			// booleans: "branch" | "pr" | null. The anchor underlines only when its
			// own value matches, so hovering one link never underlines the other.
			const [hoveredLink, setHoveredLink] = react.useState(null);
			const detail = useGitStatus(target, { pr: true, detail: true, enabled: hovered });
			if (info === void 0 || info.git !== true) return null;

			const tokenGlyph = chipGlyphNode(info);
			// The branch name links to the compare view (base...branch). Vouched http(s)
			// only; new tab, never navigating the conversation away.
			const isBranchLink = typeof detail?.compareUrl === "string" && detail.compareUrl.startsWith("https://");
			const branchInner = chipBranchInner(info, detail, isBranchLink, hoveredLink, setHovered, setHoveredLink);
			// The Tooltip's CHILD must not change element type once the detail payload
			// lands, so the cluster span is the stable hover surface. ALWAYS wrapped.
			const leadingHover = chipLeadingHover(info, detail, tokenGlyph, branchInner, isBranchLink, setHovered);
			const text = formatOperationToken(info);
			const countHover = chipCountHover(info, detail, setHovered);
			const prTokenHover = chipPrTokenHover(info, detail, hoveredLink, setHovered, setHoveredLink);
			const chip = chipAssemble(leadingHover, text, countHover, prTokenHover);
			// No Tooltip primitive (a shell that does not seed it): the leading cluster
			// renders bare and the badge still works — the card is an enhancement.
			return chip;
		}

		//#endregion

		// `workspaces` is no longer required: both surfaces target an id and the
		// node half resolves the workspace, so the client never needs a service
		// lookup. Fewer declared services also means fewer ways to fail to load.
		/** The built-in ranking order — what "Reset to default" restores. */
		const DEFAULT_ORDER = ["operation", "unmerged", "conflict", "review", "sync", "publish", "merge", "commit", "checks"];

		/**
		 * Move one category within the ranking order — the card's only reorder
		 * primitive, pure so the suite can drive it without a browser. Out-of-range
		 * moves are no-ops (the buttons disable at the ends, this is the belt).
		 */
		function moveCategory(order, index, delta) {
			const next = [...order];
			const to = index + delta;
			if (index < 0 || index >= next.length || to < 0 || to >= next.length) return next;
			const [moved] = next.splice(index, 1);
			next.splice(to, 0, moved);
			return next;
		}

		/** Human labels for the ranking categories, in default order. */
		const CATEGORY_LABELS = {
			operation: ["operation", "resume a paused merge/rebase"],
			unmerged: ["unmerged", "resolve conflict markers"],
			conflict: ["conflict", "a pull request that conflicts with its base"],
			review: ["review", "a review to address, or a review to wait for"],
			sync: ["sync", "pull, or rebase + confirmed force-push"],
			publish: ["publish", "push local commits"],
			merge: ["merge", "a merge-ready pull request"],
			commit: ["commit", "stage and commit working changes"],
			checks: ["checks", "watch failing CI"]
		};

		/**
		 * The settings card's body — Settings → Plugins → Git Badge. Reads the
		 * bound settings scope through the store the registration injects and
		 * writes back one field ("order") via the scope's mutate path. Styled like
		 * this plugin's other surfaces rather than the host's card primitives,
		 * which are not exported to plugins.
		 */
		function GitBadgeOrderCard(props) {
			const state = props.useGitBadgeOrderCard((snapshot) => snapshot);
			const t = props.t;
			// Local expander state, mirroring the host's plugin cards: collapsed by
			// default, and auto-collapsed again once a save settles clean (so the
			// card confirms itself the way its siblings do).
			const [open, setOpen] = react.useState(false);
			const saveStarted = react.useRef(false);
			react.useEffect(() => {
				if (state.saving) {
					saveStarted.current = true;
					return;
				}
				if (!saveStarted.current) return;
				saveStarted.current = false;
				if (!state.dirty && !state.failed) setOpen(false);
			}, [state.dirty, state.failed, state.saving]);
			if (!state.available) return null;
			const rows = state.order.map((cat, index) => {
				const [label, hint] = CATEGORY_LABELS[cat] ?? [cat, ""];
				return react_jsx_runtime.jsxs("div", {
					style: { display: "flex", alignItems: "center", gap: "8px", padding: "2px 0" },
					children: [
						react_jsx_runtime.jsx("span", {
							style: { color: "var(--dsw-alias-label-tertiary, #9ea7ad)", fontFamily: "monospace", minWidth: "16px", textAlign: "right" },
							children: String(index + 1)
						}),
						react_jsx_runtime.jsx("span", { style: { minWidth: "84px" }, children: label }),
						react_jsx_runtime.jsx("span", { style: { color: "var(--dsw-alias-label-tertiary, #9ea7ad)", flex: "1", minWidth: 0 }, children: hint }),
						react_jsx_runtime.jsx("button", {
							type: "button",
							"aria-label": t("moveUp") + " " + label,
							disabled: state.saving || !state.writable || index === 0,
							onClick: () => props.move(index, -1),
							style: CARD_BUTTON,
							children: "\u2191"
						}),
						react_jsx_runtime.jsx("button", {
							type: "button",
							"aria-label": t("moveDown") + " " + label,
							disabled: state.saving || !state.writable || index === state.order.length - 1,
							onClick: () => props.move(index, 1),
							style: CARD_BUTTON,
							children: "\u2193"
						})
					]
				}, cat);
			});
			// The card chrome matches the host's own plugin cards (its CSS module is
			// not exported to plugins, so the values are reproduced inline): an <li>
			// with the bordered card, a header button that expands, and a body that
			// carries the list and the footer actions.
			return react_jsx_runtime.jsxs("li", {
				style: open ? CARD_OPEN : CARD_CLOSED,
				children: [
					react_jsx_runtime.jsxs("button", {
						type: "button",
						"aria-expanded": open,
						"aria-label": t(open ? "collapse" : "expand") + ": " + t("title"),
						onClick: () => setOpen(!open),
						style: CARD_HEADER,
						children: [
							react_jsx_runtime.jsxs("span", {
								style: { display: "flex", flexDirection: "column", flex: "1", gap: "4px", minWidth: 0 },
								children: [
									react_jsx_runtime.jsx("span", { style: CARD_NAME, children: t("title") }),
									react_jsx_runtime.jsx("span", { style: CARD_DESCRIPTION, children: t("description") })
								]
							}),
							react_jsx_runtime.jsx("span", {
								"aria-hidden": true,
								style: open
									? { color: "var(--dsw-alias-label-tertiary, #9ea7ad)", flex: "none", transform: "rotate(180deg)", transition: "transform .16s" }
									: { color: "var(--dsw-alias-label-tertiary, #9ea7ad)", flex: "none", transition: "transform .16s" },
								children: (primitives !== null && primitives.IconChevronDownOutline14 !== void 0
									? react_jsx_runtime.jsx(primitives.IconChevronDownOutline14, {})
									: "\u25BE")
							})
						]
					}),
					open
						? react_jsx_runtime.jsxs("div", {
							style: { borderTop: ".5px solid var(--dsw-alias-border-l2, #e4e8eb)", margin: "0 16px", paddingBottom: "8px" },
							children: [
								react_jsx_runtime.jsx("div", { style: { padding: "10px 0 6px" }, children: t("intro") }),
								react_jsx_runtime.jsx("div", { style: { display: "flex", flexDirection: "column" }, children: rows }),
								react_jsx_runtime.jsxs("div", {
									style: { display: "flex", gap: "8px", alignItems: "center", justifyContent: "flex-end", padding: "12px 0 4px" },
									children: [
										state.failed ? react_jsx_runtime.jsx("span", { style: { color: "var(--dsw-alias-label-error, #d13438)", flex: "1", fontSize: "12px" }, children: t("failed") }) : null,
										state.writable ? null : react_jsx_runtime.jsx("span", { style: { color: "var(--dsw-alias-label-tertiary, #9ea7ad)", flex: "1", fontSize: "12px" }, children: t("readOnly") }),
										react_jsx_runtime.jsx("button", {
											type: "button",
											disabled: !state.dirty || state.saving,
											onClick: props.discard,
											style: CARD_BUTTON,
											children: t("discard")
										}),
										react_jsx_runtime.jsx("button", {
											type: "button",
											disabled: !state.dirty || state.saving || !state.writable,
											onClick: props.save,
											style: CARD_BUTTON,
											children: state.saving ? t("saving") : t("save")
										}),
										react_jsx_runtime.jsx("button", {
											type: "button",
											disabled: state.saving || !state.writable,
											onClick: props.reset,
											style: CARD_BUTTON,
											children: t("reset")
										})
									]
								})
							]
						})
						: null
				]
			});
		}

		const inject = ["slots"];

		/**
		 * Register the badge into upstream's own seats. The slot owner hands each
		 * entry the row owner share as props; the row surfaces destructure
		 * `{ sessionId }` and deliberately ignore the cwd they may also be given.
		 */
		function apply(ctx) {
			// The /gh command contribution (the (+) commands menu): the state-aware
			// entry point to the gh skill. available() gates on the cached git
			// status; options() lists only the sub-actions the checkout justifies;
			// onSelect SENDS the skill invocation ("/gh push") as a conversation
			// message — the agent executes the skill under its own approval flow,
			// and the shell consumes the /gh token afterwards. This is the one
			// blessed route from a menu pick to a git action; it is a SEND, which
			// is why the destructive-step confirmation lives in the skill text.
			// Guarded: a host without commandUi loses the menu entry, never the
			// badges.
			if (typeof ctx.inject === "function") {
				ctx.inject(["commandUi", "sessions"], (scope) => {
					try {
					scope.effect(() => scope.commandUi.register({
						name: "gh",
						// the contract calls description() as a FUNCTION at menu-build
						// time (candidates: contribution.description()) — a string throws
						// TypeError on every candidates pass and kills the whole menu,
						// (+) button included
						description: () => "git/gh actions for this checkout — push, pull, pr, commit, checks",
						available: (session) => {
							// called during the host's menu build — a throw here kills the
							// whole menu, so it degrades to "hidden" instead
							try {
								const query = targetQuery({ kind: "session", id: session?.sessionId }, { pr: true });
								return query !== void 0 && GIT_CACHE.get(query)?.data?.git === true;
							} catch (error) {
								console.error("[dsh-git-badge] /gh available failed:", error);
								return false;
							}
						},
						ui: {
							options: async (session, signal) => {
								try {
									const sessionId = session?.sessionId;
									if (sessionId === void 0) return [];
									const query = targetQuery({ kind: "session", id: sessionId }, { pr: true });
									if (query === void 0) return [];
									// cache-first: the badge's own knowledge opens the picker
									// instantly; a cold session pays one status fetch.
									let info = GIT_CACHE.get(query)?.data;
									if (info === void 0 || info === null) {
										info = await fetch("/api/git-badge?" + query).then((r) => r.json());
									}
									const actions = ghSkillActions(info);
									return actions.map((action) => ({
										label: "/gh " + action.args,
										detail: action.why,
										args: action.args,
										...action.danger === true ? { confirmation: cleanGate() } : {}
									}));
								} catch (error) {
									console.error("[dsh-git-badge] /gh options failed:", error);
									return [];
								}
							},
							onSelect: async (option, session) => {
								// Send the invocation: the message lands in the transcript
								// and the agent executes the gh skill — the approval flow
								// for anything destructive is the agent's, per the skill
								// text. The prompt path is the conversation's own: the
								// sessions service binds a sessionId to { session } and
								// binding.session.prompt(content, "queue") is exactly what
								// the composer's send() calls.
								const sessionId = session?.sessionId;
								const sessions = typeof scope.sessions === "function" ? scope.sessions() : scope.sessions;
								const binding = sessions?.binding?.(sessionId);
								const target = binding?.session;
								if (target?.prompt === void 0) {
									console.error("[dsh-git-badge] /gh: no prompt path (binding missing or session-less)", {
										sessionId,
										hasSessions: sessions !== void 0,
										hasBinding: binding !== void 0
									});
									return;
								}
								const result = await target.prompt([{ type: "text", text: "/gh " + option.args }], "queue");
								if (result !== void 0 && result !== null && result.ok === false) {
									console.error("[dsh-git-badge] /gh submit refused:", result.error);
								}
							}
						}
					}), "dsh-git-badge: /gh contribution");
					} catch (error) {
						// a failed registration must degrade to "no /gh entry", never to
						// a broken commands menu — the (+) button and the / menu are the
						// host's, and this callback runs inside their boot
						console.error("[dsh-git-badge] /gh contribution failed:", error);
					}
				});
			}

			// The settings card (Settings → Plugins → Git Badge): the order lives
			// in this plugin's `git-badge` settings namespace, which the node half
			// registers; this half renders the card that edits it through the bound
			// scope — reads from the scope snapshot, writes one field via mutate.
			// Guarded: a host without settingsScope loses the card, never the
			// badges.
			if (typeof ctx.inject === "function") {
				try {
					ctx.inject(["settingsScope", "slots", "locale"], (scopeCtx) => {
						const NS = "dsh-git-badge";
						scopeCtx.effect(() => scopeCtx.locale.register(NS, {
							en: {
								title: "Git Badge",
								description: "Which action class the badge suggests first.",
								expand: "Expand",
								collapse: "Collapse",
								intro: "The badge suggests one next action; this is the order it considers the classes in.",
								save: "Save",
								discard: "Discard",
								reset: "Reset to default",
								saving: "Saving\u2026",
								failed: "save failed \u2014 try again",
								readOnly: "read-only on this host",
								moveUp: "Move up",
								moveDown: "Move down"
							}
						}), "dsh-git-badge: settings locale");
						const scope = scopeCtx.settingsScope.bind({ namespace: "git-badge" });
						// draft === null means "mirror the stored order"; any reorder
						// stages a copy, and only a confirmed write clears it — a
						// rejected write leaves the draft for a retry rather than
						// pretending it saved.
						let draft = null;
						let saving = false;
						let failed = false;
						const subscribers = new Set();
						let snapshot = null;
						const storedOrder = () => {
							const view = scope.getSnapshot();
							return Array.isArray(view?.value?.order) ? view.value.order : DEFAULT_ORDER;
						};
						const build = () => {
							const view = scope.getSnapshot();
							const stored = storedOrder();
							const order = draft ?? stored;
							return {
								available: view?.status === "ready",
								writable: view?.writable === true,
								order,
								dirty: draft !== null && draft.join() !== stored.join(),
								saving,
								failed
							};
						};
						const publish = () => {
							snapshot = build();
							for (const listener of subscribers) listener();
						};
						scopeCtx.effect(() => {
							const off = scope.subscribe(publish);
							return () => {
								if (typeof off === "function") off();
							};
						}, "dsh-git-badge: settings scope");
						publish();
						const store = {
							getSnapshot: () => snapshot ?? build(),
							subscribe: (listener) => {
								subscribers.add(listener);
								return () => subscribers.delete(listener);
							}
						};
						const save = async () => {
							if (draft === null || saving) return;
							const wanted = [...draft];
							saving = true;
							failed = false;
							publish();
							try {
								await scope.mutate([{ op: "set", path: ["order"], value: wanted }]);
							} catch (error) {
								console.error("[dsh-git-badge] order save failed:", error);
							}
							saving = false;
							if (storedOrder().join() === wanted.join()) draft = null;
							else failed = true;
							publish();
						};
						scopeCtx.slots.inject("settings.plugin.item", function* () {
							yield scopeCtx.slots.register({
								name: "settings.plugin.item",
								key: "git-badge",
								locale: NS,
								inject: () => ({
									hooks: { gitBadgeOrderCard: store },
									move: (index, delta) => {
										draft = moveCategory(draft ?? [...storedOrder()], index, delta);
										failed = false;
										publish();
									},
									save: () => void save(),
									discard: () => {
										draft = null;
										failed = false;
										publish();
									},
									reset: () => {
										draft = [...DEFAULT_ORDER];
										failed = false;
										publish();
									}
								})
							}, GitBadgeOrderCard);
						});
					});
				} catch (error) {
					console.error("[dsh-git-badge] settings card unavailable:", error);
				}
			}

			// The row's token rides upstream's OWN `sidebar.session.row.leading`
			// seat: a 16px cell the workspace browser renders in the row's leading
			// cluster. No patch and no declaration to make.
			ctx.slots.inject("sidebar.session.row.leading", () => ctx.slots.register({
				name: "sidebar.session.row.leading",
				id: "git-badge-row-leading"
			}, LeadingTokenGlyph));
			// The row is ALREADY a HoverCard anchor upstream, so a glyph that opened
			// its own tooltip would nest two cards. This renders the explanation
			// inside that card instead, through the hover seat upstream declares
			// itself (sidebar.session.row.hover) — no request of its own.
			ctx.slots.inject("sidebar.session.row.hover", () => ctx.slots.register({
				name: "sidebar.session.row.hover",
				id: "git-badge-row-detail"
			}, SessionGitDetail));
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
			// No seam, no apply step: the leading seat and the hover seat are both
			// upstream's own. Report the surfaces once, for diagnostics.
			console.info("[dsh-git-badge] surfaces: input chip = on; sidebar row token = on (upstream leading seat).");
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
		exports.__internals = { targetQuery, worktreeDetail, linkedWorktreesDetail, ghSkillActions, cleanGate, moveCategory };
		return module.exports;
	}
});
