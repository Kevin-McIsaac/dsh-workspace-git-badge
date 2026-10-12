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
 * ONE seam, not two (rev 3). Upstream 0.2.0-rc.2 threads `renderSlot` into
 * SessionNodeItem and SessionHoverContent itself and declares its own
 * `sidebar.session.row.hover` hover-card seat, so the badge's provenance line
 * rides that upstream seat and needs no patch. The seat upstream still lacks is
 * the always-visible row token after the title: these three anchors add it.
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
export const PATCH_REV = "3";
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
		"\t\tfunction SessionNodeItem({ node, currentId, now, onOpen, onRenameRequest, renderSlot, onReveal, drag, t }) {",
		"\t\t/* dsh-git-badge:seam-patch rev 3 — seam/apply.sh recognises its own artifact by this\n\t\t * marker, which upstream would never carry. */\n\t\t/**\n\t\t* Seam entry boundary. The host wraps each registered ENTRY in its own error\n\t\t* boundary, but the outlet a row renders is NOT covered by it, so a throw\n\t\t* anywhere in an occupant's render path would propagate into the workspace\n\t\t* browser itself — and the shell ABDICATES that browser entry, blanking the\n\t\t* whole sidebar. A seam must not be able to do that: this keeps the blast\n\t\t* radius at \"no badge\", and logs what happened instead of swallowing it.\n\t\t*/\n\t\tclass SeamBoundary extends react.Component {\n\t\t\tconstructor(props) {\n\t\t\t\tsuper(props);\n\t\t\t\tthis.state = { failed: false };\n\t\t\t}\n\t\t\tstatic getDerivedStateFromError() {\n\t\t\t\treturn { failed: true };\n\t\t\t}\n\t\t\tcomponentDidCatch(error) {\n\t\t\t\tconsole.error(\"[dsh-git-badge] seam entry failed; badge omitted:\", error);\n\t\t\t}\n\t\t\trender() {\n\t\t\t\treturn this.state.failed ? null : this.props.children;\n\t\t\t}\n\t\t}\n\t\t/** Seam entry body, so the boundary above ENCLOSES the renderSlot call. */\n\t\tfunction SessionRowSeam({ renderSlot, sessionId, label }) {\n\t\t\treturn renderSlot(\"sidebar.workspaces.sessionRow\", { sessionId, label });\n\t\t}\n\t\t/**\n\t\t* Session-row seam (sidebar.workspaces.sessionRow): renders the additive\n\t\t* list-slot entries for one session row with the row owner share\n\t\t* ({ sessionId, label }).\n\t\t*\n\t\t* Returns null — not a fallback element — when no plugin occupies the seam,\n\t\t* so a pristine install renders exactly as upstream.\n\t\t*/\n\t\tfunction renderSessionRowSeam(renderSlot, sessionId, label) {\n\t\t\tif (renderSlot === void 0) return null;\n\t\t\treturn (0, react_jsx_runtime.jsx)(SeamBoundary, {\n\t\t\t\tchildren: (0, react_jsx_runtime.jsx)(SessionRowSeam, { renderSlot, sessionId, label })\n\t\t\t});\n\t\t}\n\t\tfunction SessionNodeItem({ node, currentId, now, onOpen, onRenameRequest, renderSlot, onReveal, drag, t }) {"
	],
	// --- 2. The token sits with the title, before the time cluster ---
	[
		"title span + badge render",
		"\t\t\t\t\t\t(0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\tref: titleRef,\n\t\t\t\t\t\t\tclassName: Rows_module_css_default.title,\n\t\t\t\t\t\t\tonDoubleClick: row.blank ? void 0 : (e) => {\n\t\t\t\t\t\t\t\te.stopPropagation();\n\t\t\t\t\t\t\t\tonRenameRequest(node.id, row.title);\n\t\t\t\t\t\t\t},\n\t\t\t\t\t\t\tchildren: title\n\t\t\t\t\t\t}),",
		"\t\t\t\t\t\t(0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\t\tref: titleRef,\n\t\t\t\t\t\t\tclassName: Rows_module_css_default.title,\n\t\t\t\t\t\t\tonDoubleClick: row.blank ? void 0 : (e) => {\n\t\t\t\t\t\t\t\te.stopPropagation();\n\t\t\t\t\t\t\t\tonRenameRequest(node.id, row.title);\n\t\t\t\t\t\t\t},\n\t\t\t\t\t\t\tchildren: title\n\t\t\t\t\t\t}),\n\t\t\t\t\t\trenderSessionRowSeam(renderSlot, node.id, title),"
	],
	// --- 3. Declare the one seam child on the sidebar.workspaces registration ---
	[
		"seam children registration",
		"\t\t\t\t\t\"sidebar.workspaces.directoryFlow\": {\n\t\t\t\t\t\tkind: \"single\",\n\t\t\t\t\t\tscope: \"root\"\n\t\t\t\t\t},",
		"\t\t\t\t\t\"sidebar.workspaces.directoryFlow\": {\n\t\t\t\t\t\tkind: \"single\",\n\t\t\t\t\t\tscope: \"root\"\n\t\t\t\t\t},\n\t\t\t\t\t\"sidebar.workspaces.sessionRow\": {\n\t\t\t\t\t\tkind: \"list\",\n\t\t\t\t\t\tscope: \"root\"\n\t\t\t\t\t},"
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
