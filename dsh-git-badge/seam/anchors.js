/**
 * The seam patch as anchor pairs — the single definition of the patch.
 *
 * Every entry is [name, old, new]: `old` must occur EXACTLY ONCE in the target
 * client.js, and is replaced by `new`. apply.js runs these against the INSTALLED
 * file in place; the repo's seam/make-patch.sh runs them against the pinned
 * pristine snapshot to regenerate patched-client.js for the upstream-PR diff
 * only.
 *
 * This replaces the old whole-file hash guard: a DSH update that changes
 * anything outside these blocks no longer invalidates the patch. Only a change
 * that moves one of the anchors does — and the failure names the anchor that
 * moved instead of reporting an opaque hash mismatch.
 *
 * Tabs matter: the target is a bundled, tab-indented file. The strings below
 * use \t escapes so a reader cannot mistake them for spaces. When upstream
 * moves an anchor, edit that entry's `old` (and `new`, if the insertion point
 * changed) to the new upstream text — the drift report names which one.
 */

export const MARKER = "dsh-git-badge:seam-patch";
// Bumped whenever the anchor set changes shape. An installed file carrying the
// MARKER without this revision is OUR older artifact: apply restores its backup
// and re-patches rather than refusing.
export const PATCH_REV = "2";
export const REV_COMMENT = `${MARKER} rev ${PATCH_REV}`;

// The seam strings upstream would declare if the patch were merged. Present in
// a file that is NOT ours => upstream landed; the patch is a no-op.
export const SEAM_STRINGS = [
	'"sidebar.workspaces.sessionRow"',
	'"sidebar.workspaces.sessionRow.detail"',
	'"sidebar.workspaces.row"', // the pre-session-row seam, also upstream's if landed
];

export const PATCHES = [
	// --- 1. Session-row seam helper, inserted with the row component's props ---
	[
		"SessionNodeItem header + seam helpers",
		"\t\tfunction SessionNodeItem({ node, currentId, now, onOpen, onRename, onFork, onArchive, onReveal, drag, flat = false, t }) {",
		"\t\t/* dsh-git-badge:seam-patch rev 2 — seam/apply.sh recognises its own artifact by this\n\t\t * marker, which upstream would never carry. */\n\t\t/**\n\t\t* Seam entry boundary. The host wraps each registered ENTRY in its own error\n\t\t* boundary, but the outlet a row renders is NOT covered by it, so a throw\n\t\t* anywhere in an occupant's render path would propagate into the workspace\n\t\t* browser itself — and the shell ABDICATES that browser entry, blanking the\n\t\t* whole sidebar. A seam must not be able to do that: this keeps the blast\n\t\t* radius at \"no badge\", and logs what happened instead of swallowing it.\n\t\t*/\n\t\tclass SeamBoundary extends react.Component {\n\t\t\tconstructor(props) {\n\t\t\t\tsuper(props);\n\t\t\t\tthis.state = { failed: false };\n\t\t\t}\n\t\t\tstatic getDerivedStateFromError() {\n\t\t\t\treturn { failed: true };\n\t\t\t}\n\t\t\tcomponentDidCatch(error) {\n\t\t\t\tconsole.error(\"[dsh-git-badge] seam entry failed; badge omitted:\", error);\n\t\t\t}\n\t\t\trender() {\n\t\t\t\treturn this.state.failed ? null : this.props.children;\n\t\t\t}\n\t\t}\n\t\t/** Seam entry bodies, so the boundary above ENCLOSES the renderSlot call. */\n\t\tfunction SessionRowSeam({ renderSlot, sessionId, workspaceId, label }) {\n\t\t\treturn renderSlot(\"sidebar.workspaces.sessionRow\", { sessionId, workspaceId, label });\n\t\t}\n\t\tfunction SessionRowDetailSeam({ renderSlot, sessionId, workspaceId, label }) {\n\t\t\treturn renderSlot(\"sidebar.workspaces.sessionRow.detail\", { sessionId, workspaceId, label });\n\t\t}\n\t\t/**\n\t\t* Session-row seam (sidebar.workspaces.sessionRow): renders the additive\n\t\t* list-slot entries for one session row with the row owner share\n\t\t* ({ sessionId, workspaceId, label }).\n\t\t*\n\t\t* Returns null — not a fallback element — when no plugin occupies the seam,\n\t\t* so a pristine install renders exactly as upstream. `workspaceId` is only\n\t\t* ever passed from the TREE call site: the flat \"all sessions\" list and the\n\t\t* search-result list render this component without it, which is what keeps\n\t\t* badges off those lists without either of them needing a guard.\n\t\t*/\n\t\tfunction renderSessionRowSeam(renderSlot, sessionId, workspaceId, label) {\n\t\t\tif (renderSlot === void 0 || workspaceId === void 0) return null;\n\t\t\treturn (0, react_jsx_runtime.jsx)(SeamBoundary, {\n\t\t\t\tchildren: (0, react_jsx_runtime.jsx)(SessionRowSeam, { renderSlot, sessionId, workspaceId, label })\n\t\t\t});\n\t\t}\n\t\tfunction SessionNodeItem({ node, currentId, now, onOpen, onRename, onFork, onArchive, onReveal, drag, flat = false, t, renderSlot, workspaceId }) {",
	],
	// --- 2. The badge sits with the title, before the schedule/time cluster ---
	[
		"title span + badge render",
		'\t\t\t\t\t\t(0, react_jsx_runtime.jsx)("span", {\n\t\t\t\t\t\t\tclassName: Rows_module_css_default.title,\n\t\t\t\t\t\t\tchildren: title\n\t\t\t\t\t\t}),',
		'\t\t\t\t\t\t(0, react_jsx_runtime.jsx)("span", {\n\t\t\t\t\t\t\tclassName: Rows_module_css_default.title,\n\t\t\t\t\t\t\tchildren: title\n\t\t\t\t\t\t}),\n\t\t\t\t\t\trenderSessionRowSeam(renderSlot, node.id, workspaceId, title),',
	],
	// --- 3. The hover card gains the detail seam ---
	[
		"SessionHoverContent call-site props",
		'\t\t\t\tcontent: (0, react_jsx_runtime.jsx)(SessionHoverContent, {\n\t\t\t\t\tnode,\n\t\t\t\t\tnow,\n\t\t\t\t\tt\n\t\t\t\t}),',
		'\t\t\t\tcontent: (0, react_jsx_runtime.jsx)(SessionHoverContent, {\n\t\t\t\t\tnode,\n\t\t\t\t\tnow,\n\t\t\t\t\tt,\n\t\t\t\t\trenderSlot,\n\t\t\t\t\tworkspaceId\n\t\t\t\t}),',
	],
	[
		"SessionHoverContent header",
		"\t\tfunction SessionHoverContent({ node, now, t }) {",
		"\t\tfunction SessionHoverContent({ node, now, t, renderSlot, workspaceId }) {",
	],
	[
		"hover card detail row",
		"\t\t\t\t\t}, status.label))\n\t\t\t\t]\n\t\t\t});\n\t\t}",
		'\t\t\t\t\t}, status.label)),\n\t\t\t\t\trenderSlot !== void 0 && workspaceId !== void 0 ? (0, react_jsx_runtime.jsx)("div", {\n\t\t\t\t\t\tclassName: Rows_module_css_default.hoverStatus,\n\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)(SeamBoundary, {\n\t\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)(SessionRowDetailSeam, { renderSlot, sessionId: node.id, workspaceId, label: displayTitle(node, t) })\n\t\t\t\t\t\t})\n\t\t\t\t\t}) : null\n\t\t\t\t]\n\t\t\t});\n\t\t}',
	],
	// --- 4. Thread renderSlot: WorkspaceBrowser -> SessionTree ---
	// A bare `renderSlot` at the SessionNodeItem call site resolves in THIS scope.
	// The first cut of this patch threaded it into SessionNodeItem but not into
	// SessionTree, so the row render threw `ReferenceError: renderSlot is not
	// defined` the moment sessions appeared — and the shell abdicated the whole
	// sidebar with it. Any prop a patched call site reads by shorthand must arrive
	// through every intermediate scope.
	[
		"SessionTree header",
		"\t\tfunction SessionTree({ useSessions, useSessionPendingInteraction, startSession, open, forkSession, workspaces, archivedSessionIds, workspaceReady, usePanelInfo, onRenameRequest, onDeleteRequest, onSessionRename, onSessionArchive, insertWorkspaceBefore, insertSessionBefore, orderBy, groupExpansion, setGroupExpanded, sessionOrderByAccount, sessionUpdatedAtByAccount, syncSessionOrderAccount, setSessionOrder, home, t, revealSessionId, onSessionRevealed }) {",
		"\t\tfunction SessionTree({ useSessions, useSessionPendingInteraction, startSession, open, forkSession, workspaces, archivedSessionIds, workspaceReady, usePanelInfo, onRenameRequest, onDeleteRequest, onSessionRename, onSessionArchive, insertWorkspaceBefore, insertSessionBefore, orderBy, groupExpansion, setGroupExpanded, sessionOrderByAccount, sessionUpdatedAtByAccount, syncSessionOrderAccount, setSessionOrder, home, t, renderSlot, revealSessionId, onSessionRevealed }) {",
	],
	[
		"SessionTree call site",
		"(0, react_jsx_runtime.jsx)(SessionTree, {\n\t\t\t\t\t\t\tusePanelInfo,",
		"(0, react_jsx_runtime.jsx)(SessionTree, {\n\t\t\t\t\t\t\trenderSlot,\n\t\t\t\t\t\t\tusePanelInfo,",
	],
	// --- 5. Thread renderSlot + the owning workspace id from the TREE call site only ---
	[
		"SessionNodeItem call site",
		"\t\t\t\t\t\t\t\t\t\treturn (0, react_jsx_runtime.jsx)(SessionNodeItem, {\n\t\t\t\t\t\t\t\t\t\t\tnode,\n\t\t\t\t\t\t\t\t\t\t\tcurrentId: current,",
		"\t\t\t\t\t\t\t\t\t\treturn (0, react_jsx_runtime.jsx)(SessionNodeItem, {\n\t\t\t\t\t\t\t\t\t\t\tnode,\n\t\t\t\t\t\t\t\t\t\t\tcurrentId: current,\n\t\t\t\t\t\t\t\t\t\t\trenderSlot,\n\t\t\t\t\t\t\t\t\t\t\t// only the tree knows which workspace a row belongs to; the\n\t\t\t\t\t\t\t\t\t\t\t// flat and search lists pass neither prop, so they stay bare\n\t\t\t\t\t\t\t\t\t\t\tworkspaceId: group.workspaceId,",
	],
	// --- 6. Declare the two seam children on the sidebar.workspaces registration ---
	[
		"seam children registration",
		'\t\t\t\tchildren: { "sidebar.workspaces.directoryFlow": {\n\t\t\t\t\tkind: "single",\n\t\t\t\t\tscope: "root"\n\t\t\t\t} },',
		'\t\t\t\tchildren: { "sidebar.workspaces.directoryFlow": {\n\t\t\t\t\tkind: "single",\n\t\t\t\t\tscope: "root"\n\t\t\t\t}, "sidebar.workspaces.sessionRow": {\n\t\t\t\t\tkind: "list",\n\t\t\t\t\tscope: "root"\n\t\t\t\t}, "sidebar.workspaces.sessionRow.detail": {\n\t\t\t\t\tkind: "list",\n\t\t\t\t\tscope: "root"\n\t\t\t\t} },',
	],
];

export function anchorCounts(text) {
	return Object.fromEntries(PATCHES.map(([name, old]) => [name, text.split(old).length - 1]));
}

export function firstFailure(text) {
	for (const [name, old] of PATCHES) {
		const n = text.split(old).length - 1;
		if (n !== 1) return { name, count: n };
	}
	return null;
}

export function applyPatch(text) {
	for (const [name, old] of PATCHES) {
		const n = text.split(old).length - 1;
		if (n !== 1) {
			throw new Error(
				`anchor ${JSON.stringify(name)} found ${n} times (need exactly 1) — upstream drift; nothing was patched`
			);
		}
	}
	for (const [, old, replacement] of PATCHES) text = text.replace(old, replacement);
	return text;
}

export function isOurs(text) {
	return text.includes(MARKER);
}

export function isCurrentRev(text) {
	return text.includes(REV_COMMENT);
}

export function seamPresent(text) {
	return SEAM_STRINGS.some((s) => text.includes(s));
}

/** A patched file's applied signature (the `old` anchor forms are gone — that is the point). */
export function appliedSignature(text) {
	return (
		seamPresent(text) && text.includes("function renderSessionRowSeam") && text.includes("class SeamBoundary")
	);
}
