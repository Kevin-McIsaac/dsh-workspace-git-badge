#!/usr/bin/env bash
# Build patched-client.js from pristine-client.js.
#
# The patch is SEAM-ONLY: it declares and renders two additive list slots on the
# sidebar workspace browser — sidebar.workspaces.sessionRow (the badge) and
# sidebar.workspaces.sessionRow.detail (its hover-card line) — mirroring the
# conversation.composer.dock pattern. All git-badge UI/logic lives in the
# dsh-git-badge plugin; with no plugin registered every row renders exactly as
# upstream (a null fallback, not a placeholder span).
#
# WHY THE SESSION ROW and not the workspace row: a workspace row cannot know which
# worktree a session is working in — DSH records no session→worktree link at all —
# so a per-workspace badge must either guess or stay on the main checkout. A
# session row carries a session id, and the plugin's route resolves that to the
# checkout the session is actually working in.
#
# This file is the exact diff to turn into the upstream PR.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
python3 - "$HERE/pristine-client.js" "$HERE/patched-client.js" <<'PY'
import sys, re

src, dst = sys.argv[1], sys.argv[2]
text = open(src, encoding="utf-8").read()
count = 0

def rep(old, new):
    global text, count
    assert text.count(old) == 1, f"anchor not unique/found: {old[:80]!r} ({text.count(old)})"
    text = text.replace(old, new)
    count += 1

# --- 1. Session-row seam helper, inserted with the row component's props ---
rep(
"""\t\tfunction SessionNodeItem({ node, currentId, now, onOpen, onRename, onFork, onArchive, onReveal, drag, flat = false, t }) {""",
"""\t\t/* dsh-git-badge:seam-patch — seam/apply.sh recognises its own artifact by this
\t\t * marker, which upstream would never carry. */
\t\t/**
\t\t* Session-row seam (sidebar.workspaces.sessionRow): renders the additive
\t\t* list-slot entries for one session row with the row owner share
\t\t* ({ sessionId, workspaceId, label }).
\t\t*
\t\t* Returns null — not a fallback element — when no plugin occupies the seam,
\t\t* so a pristine install renders exactly as upstream. `workspaceId` is only
\t\t* ever passed from the TREE call site: the flat "all sessions" list and the
\t\t* search-result list render this component without it, which is what keeps
\t\t* badges off those lists without either of them needing a guard.
\t\t*/
\t\tfunction renderSessionRowSeam(renderSlot, sessionId, workspaceId, label) {
\t\t\tif (renderSlot === void 0 || workspaceId === void 0) return null;
\t\t\treturn renderSlot("sidebar.workspaces.sessionRow", { sessionId, workspaceId, label });
\t\t}
\t\tfunction SessionNodeItem({ node, currentId, now, onOpen, onRename, onFork, onArchive, onReveal, drag, flat = false, t, renderSlot, workspaceId }) {""")

# --- 2. The badge sits with the title, before the schedule/time cluster ---
rep(
"""\t\t\t\t\t\t(0, react_jsx_runtime.jsx)("span", {
\t\t\t\t\t\t\tclassName: Rows_module_css_default.title,
\t\t\t\t\t\t\tchildren: title
\t\t\t\t\t\t}),""",
"""\t\t\t\t\t\t(0, react_jsx_runtime.jsx)("span", {
\t\t\t\t\t\t\tclassName: Rows_module_css_default.title,
\t\t\t\t\t\t\tchildren: title
\t\t\t\t\t\t}),
\t\t\t\t\t\trenderSessionRowSeam(renderSlot, node.id, workspaceId, title),""")

# --- 3. The hover card gains the detail seam ---
rep(
"""\t\t\t\tcontent: (0, react_jsx_runtime.jsx)(SessionHoverContent, {
\t\t\t\t\tnode,
\t\t\t\t\tnow,
\t\t\t\t\tt
\t\t\t\t}),""",
"""\t\t\t\tcontent: (0, react_jsx_runtime.jsx)(SessionHoverContent, {
\t\t\t\t\tnode,
\t\t\t\t\tnow,
\t\t\t\t\tt,
\t\t\t\t\trenderSlot,
\t\t\t\t\tworkspaceId
\t\t\t\t}),""")
rep(
"\t\tfunction SessionHoverContent({ node, now, t }) {",
"\t\tfunction SessionHoverContent({ node, now, t, renderSlot, workspaceId }) {")
rep(
"""\t\t\t\t\t}, status.label))
\t\t\t\t]
\t\t\t});
\t\t}""",
"""\t\t\t\t\t}, status.label)),
\t\t\t\t\trenderSlot !== void 0 && workspaceId !== void 0 ? (0, react_jsx_runtime.jsx)("div", {
\t\t\t\t\t\tclassName: Rows_module_css_default.hoverStatus,
\t\t\t\t\t\tchildren: renderSlot("sidebar.workspaces.sessionRow.detail", { sessionId: node.id, workspaceId, label: displayTitle(node, t) })
\t\t\t\t\t}) : null
\t\t\t\t]
\t\t\t});
\t\t}""")

# --- 4. Thread renderSlot + the owning workspace id from the TREE call site only ---
rep(
"""\t\t\t\t\t\t\t\t\t\treturn (0, react_jsx_runtime.jsx)(SessionNodeItem, {
\t\t\t\t\t\t\t\t\t\t\tnode,
\t\t\t\t\t\t\t\t\t\t\tcurrentId: current,""",
"""\t\t\t\t\t\t\t\t\t\treturn (0, react_jsx_runtime.jsx)(SessionNodeItem, {
\t\t\t\t\t\t\t\t\t\t\tnode,
\t\t\t\t\t\t\t\t\t\t\tcurrentId: current,
\t\t\t\t\t\t\t\t\t\t\trenderSlot,
\t\t\t\t\t\t\t\t\t\t\t// only the tree knows which workspace a row belongs to; the
\t\t\t\t\t\t\t\t\t\t\t// flat and search lists pass neither prop, so they stay bare
\t\t\t\t\t\t\t\t\t\t\tworkspaceId: group.workspaceId,""")

# --- 5. Declare the two seam children on the sidebar.workspaces registration ---
rep(
"""\t\t\t\tchildren: { "sidebar.workspaces.directoryFlow": {
\t\t\t\t\tkind: "single",
\t\t\t\t\tscope: "root"
\t\t\t\t} },""",
"""\t\t\t\tchildren: { "sidebar.workspaces.directoryFlow": {
\t\t\t\t\tkind: "single",
\t\t\t\t\tscope: "root"
\t\t\t\t}, "sidebar.workspaces.sessionRow": {
\t\t\t\t\tkind: "list",
\t\t\t\t\tscope: "root"
\t\t\t\t}, "sidebar.workspaces.sessionRow.detail": {
\t\t\t\t\tkind: "list",
\t\t\t\t\tscope: "root"
\t\t\t\t} },""")

open(dst, "w", encoding="utf-8").write(text)
print(f"patched-client.js written: {count} anchors replaced")
PY
