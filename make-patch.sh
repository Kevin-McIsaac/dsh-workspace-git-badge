#!/usr/bin/env bash
# Build patched-client.js from pristine-client.js.
#
# The patch is SEAM-ONLY: it declares and renders two additive list slots
# (sidebar.workspaces.row, sidebar.workspaces.row.detail) inside the workspace
# browser rows/hover card, mirroring the conversation.composer.dock pattern.
# All git-badge UI/logic lives in the dsh-git-badge plugin; with no plugin
# registered the rows render exactly as upstream (fallback spans).
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

# --- 1. Row-title seam helper, inserted before the ProjectRowItem docblock ---
rep(
"""\t\t/**
\t\t* Project (workspace) header row:""",
"""\t\t/**
\t\t* Row-title seam (sidebar.workspaces.row): renders the additive list-slot
\t\t* entries for this workspace row with the row owner share
\t\t* ({ workspaceId, cwd, label }). Falls back to the plain title span when no
\t\t* plugin occupies the seam, so a pristine install is visually unchanged.
\t\t*/
\t\tfunction renderWorkspaceRowSeam(renderSlot, row, label) {
\t\t\tconst fallback = (0, react_jsx_runtime.jsx)("span", {
\t\t\t\tclassName: Rows_module_css_default.title,
\t\t\t\tchildren: label
\t\t\t});
\t\t\tif (renderSlot === void 0) return fallback;
\t\t\t// SlotOutlet anchors seam entries as a <div style="display:contents">
\t\t\t// inside this span: invalid HTML nesting strictly speaking, but
\t\t\t// display:contents keeps the anchor out of layout, so flex/grid
\t\t\t// parents only see the seam's own children. Accepted by browsers.
\t\t\treturn renderSlot("sidebar.workspaces.row", { workspaceId: row.workspaceId, cwd: row.cwd, label }, { fallback });
\t\t}
\t\t/**
\t\t* Project (workspace) header row:""")

# --- 2. ProjectRowItem receives the props-face renderSlot (threaded from WorkspaceBrowser) ---
rep(
"function ProjectRowItem({ group, onToggle, onCreate, actions, drag, home, t }) {",
"function ProjectRowItem({ group, onToggle, onCreate, actions, drag, home, t, renderSlot }) {")

# --- 3. Row title area becomes the seam (fallback keeps the upstream title span) ---
rep(
"""\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)("span", {
\t\t\t\t\t\t\tclassName: Rows_module_css_default.title,
\t\t\t\t\t\t\tchildren: label
\t\t\t\t\t\t})""",
"\t\t\t\t\t\tchildren: renderWorkspaceRowSeam(renderSlot, row, label)")

# --- 4. Hover card: intentionally untouched (detail seam removed) ---

# (hover call site left untouched)
rep(
"""\t\t\t\tcontent: (0, react_jsx_runtime.jsx)(WorkspaceHoverContent, {
\t\t\t\t\tlabel: row.label,""",
"""\t\t\t\tcontent: (0, react_jsx_runtime.jsx)(WorkspaceHoverContent, {
\t\t\t\t\tlabel: row.label,""")

# --- 5. Thread renderSlot: WorkspaceBrowser -> SessionTree -> ProjectRowItem ---
rep(
"function SessionTree({ useSessions, startSession, open, forkSession, workspaces, archivedSessionIds, onRenameRequest, onDeleteRequest, onSessionRename, onSessionArchive, insertWorkspaceBefore, insertSessionBefore, orderBy, groupExpansion, setGroupExpanded, sessionOrderByAccount, sessionUpdatedAtByAccount, syncSessionOrderAccount, setSessionOrder, home, t }) {",
"function SessionTree({ useSessions, startSession, open, forkSession, workspaces, archivedSessionIds, onRenameRequest, onDeleteRequest, onSessionRename, onSessionArchive, insertWorkspaceBefore, insertSessionBefore, orderBy, groupExpansion, setGroupExpanded, sessionOrderByAccount, sessionUpdatedAtByAccount, syncSessionOrderAccount, setSessionOrder, home, t, renderSlot }) {")
rep(
"""(0, react_jsx_runtime.jsx)(ProjectRowItem, {
\t\t\t\t\t\t\t\t\t\tgroup,""",
"""(0, react_jsx_runtime.jsx)(ProjectRowItem, {
\t\t\t\t\t\t\t\t\t\tgroup,
\t\t\t\t\t\t\t\t\t\trenderSlot,""")
rep(
"""(0, react_jsx_runtime.jsx)(SessionTree, {
\t\t\t\t\t\t\tuseSessions,""",
"""(0, react_jsx_runtime.jsx)(SessionTree, {
\t\t\t\t\t\t\trenderSlot,
\t\t\t\t\t\t\tuseSessions,""")

# --- 6. Declare the two seam children on the sidebar.workspaces slot registration ---
rep(
"""name: "sidebar.workspaces",
\t\t\t\tchildren: { "sidebar.workspaces.directoryFlow": {
\t\t\t\t\tkind: "single",
\t\t\t\t\tscope: "root"
\t\t\t\t} },""",
"""name: "sidebar.workspaces",
\t\t\t\tchildren: { "sidebar.workspaces.directoryFlow": {
\t\t\t\t\tkind: "single",
\t\t\t\t\tscope: "root"
\t\t\t\t}, "sidebar.workspaces.row": {
\t\t\t\t\tkind: "list",
\t\t\t\t\tscope: "root"
\t\t\t\t} },""")

open(dst, "w", encoding="utf-8").write(text)
print(f"patched-client.js written: {count} anchors replaced")
PY
