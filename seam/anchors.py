"""The seam patch as anchor pairs — the single definition of the patch.

Every entry is (name, old, new): `old` must occur EXACTLY ONCE in the target
client.js, and is replaced by `new`. apply.sh runs these against the INSTALLED
file in place; make-patch.sh runs them against the pinned pristine snapshot to
regenerate patched-client.js for the upstream-PR diff only.

This replaces the old whole-file hash guard: a DSH update that changes anything
outside these blocks no longer invalidates the patch. Only a change that moves
one of the anchors does — and the failure names the anchor that moved instead
of reporting an opaque hash mismatch.

Tabs matter: the target is a bundled, tab-indented file. The strings below use
\\t escapes so a reader cannot mistake them for spaces.
"""

MARKER = "dsh-git-badge:seam-patch"
# Bumped whenever the anchor set changes shape. An installed file carrying the
# MARKER without this revision is OUR older artifact: apply restores its backup
# and re-patches rather than refusing.
PATCH_REV = "2"
REV_COMMENT = f"{MARKER} rev {PATCH_REV}"

# The seam strings upstream would declare if the patch were merged. Present in
# a file that is NOT ours => upstream landed; the patch is a no-op.
SEAM_STRINGS = (
    '"sidebar.workspaces.sessionRow"',
    '"sidebar.workspaces.sessionRow.detail"',
    '"sidebar.workspaces.row"',  # the pre-session-row seam, also upstream's if landed
)

PATCHES = [
    # --- 1. Session-row seam helper, inserted with the row component's props ---
    (
        "SessionNodeItem header + seam helpers",
        "\t\tfunction SessionNodeItem({ node, currentId, now, onOpen, onRename, onFork, onArchive, onReveal, drag, flat = false, t }) {",
        """\t\t/* dsh-git-badge:seam-patch rev 2 — seam/apply.sh recognises its own artifact by this
\t\t * marker, which upstream would never carry. */
\t\t/**
\t\t* Seam entry boundary. The host wraps each registered ENTRY in its own error
\t\t* boundary, but the outlet a row renders is NOT covered by it, so a throw
\t\t* anywhere in an occupant's render path would propagate into the workspace
\t\t* browser itself — and the shell ABDICATES that browser entry, blanking the
\t\t* whole sidebar. A seam must not be able to do that: this keeps the blast
\t\t* radius at "no badge", and logs what happened instead of swallowing it.
\t\t*/
\t\tclass SeamBoundary extends react.Component {
\t\t\tconstructor(props) {
\t\t\t\tsuper(props);
\t\t\t\tthis.state = { failed: false };
\t\t\t}
\t\t\tstatic getDerivedStateFromError() {
\t\t\t\treturn { failed: true };
\t\t\t}
\t\t\tcomponentDidCatch(error) {
\t\t\t\tconsole.error("[dsh-git-badge] seam entry failed; badge omitted:", error);
\t\t\t}
\t\t\trender() {
\t\t\t\treturn this.state.failed ? null : this.props.children;
\t\t\t}
\t\t}
\t\t/** Seam entry bodies, so the boundary above ENCLOSES the renderSlot call. */
\t\tfunction SessionRowSeam({ renderSlot, sessionId, workspaceId, label }) {
\t\t\treturn renderSlot("sidebar.workspaces.sessionRow", { sessionId, workspaceId, label });
\t\t}
\t\tfunction SessionRowDetailSeam({ renderSlot, sessionId, workspaceId, label }) {
\t\t\treturn renderSlot("sidebar.workspaces.sessionRow.detail", { sessionId, workspaceId, label });
\t\t}
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
\t\t\treturn (0, react_jsx_runtime.jsx)(SeamBoundary, {
\t\t\t\tchildren: (0, react_jsx_runtime.jsx)(SessionRowSeam, { renderSlot, sessionId, workspaceId, label })
\t\t\t});
\t\t}
\t\tfunction SessionNodeItem({ node, currentId, now, onOpen, onRename, onFork, onArchive, onReveal, drag, flat = false, t, renderSlot, workspaceId }) {""",
    ),
    # --- 2. The badge sits with the title, before the schedule/time cluster ---
    (
        "title span + badge render",
        """\t\t\t\t\t\t(0, react_jsx_runtime.jsx)("span", {
\t\t\t\t\t\t\tclassName: Rows_module_css_default.title,
\t\t\t\t\t\t\tchildren: title
\t\t\t\t\t\t}),""",
        """\t\t\t\t\t\t(0, react_jsx_runtime.jsx)("span", {
\t\t\t\t\t\t\tclassName: Rows_module_css_default.title,
\t\t\t\t\t\t\tchildren: title
\t\t\t\t\t\t}),
\t\t\t\t\t\trenderSessionRowSeam(renderSlot, node.id, workspaceId, title),""",
    ),
    # --- 3. The hover card gains the detail seam ---
    (
        "SessionHoverContent call-site props",
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
\t\t\t\t}),""",
    ),
    (
        "SessionHoverContent header",
        "\t\tfunction SessionHoverContent({ node, now, t }) {",
        "\t\tfunction SessionHoverContent({ node, now, t, renderSlot, workspaceId }) {",
    ),
    (
        "hover card detail row",
        """\t\t\t\t\t}, status.label))
\t\t\t\t]
\t\t\t});
\t\t}""",
        """\t\t\t\t\t}, status.label)),
\t\t\t\t\trenderSlot !== void 0 && workspaceId !== void 0 ? (0, react_jsx_runtime.jsx)("div", {
\t\t\t\t\t\tclassName: Rows_module_css_default.hoverStatus,
\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)(SeamBoundary, {
\t\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)(SessionRowDetailSeam, { renderSlot, sessionId: node.id, workspaceId, label: displayTitle(node, t) })
\t\t\t\t\t\t})
\t\t\t\t\t}) : null
\t\t\t\t]
\t\t\t});
\t\t}""",
    ),
    # --- 4. Thread renderSlot: WorkspaceBrowser -> SessionTree ---
    # A bare `renderSlot` at the SessionNodeItem call site resolves in THIS scope. The
    # first cut of this patch threaded it into SessionNodeItem but not into SessionTree,
    # so the row render threw `ReferenceError: renderSlot is not defined` the moment
    # sessions appeared — and the shell abdicated the whole sidebar with it. Any prop a
    # patched call site reads by shorthand must arrive through every intermediate scope.
    (
        "SessionTree header",
        "\t\tfunction SessionTree({ useSessions, useSessionPendingInteraction, startSession, open, forkSession, workspaces, archivedSessionIds, workspaceReady, usePanelInfo, onRenameRequest, onDeleteRequest, onSessionRename, onSessionArchive, insertWorkspaceBefore, insertSessionBefore, orderBy, groupExpansion, setGroupExpanded, sessionOrderByAccount, sessionUpdatedAtByAccount, syncSessionOrderAccount, setSessionOrder, home, t, revealSessionId, onSessionRevealed }) {",
        "\t\tfunction SessionTree({ useSessions, useSessionPendingInteraction, startSession, open, forkSession, workspaces, archivedSessionIds, workspaceReady, usePanelInfo, onRenameRequest, onDeleteRequest, onSessionRename, onSessionArchive, insertWorkspaceBefore, insertSessionBefore, orderBy, groupExpansion, setGroupExpanded, sessionOrderByAccount, sessionUpdatedAtByAccount, syncSessionOrderAccount, setSessionOrder, home, t, renderSlot, revealSessionId, onSessionRevealed }) {",
    ),
    (
        "SessionTree call site",
        "(0, react_jsx_runtime.jsx)(SessionTree, {\n\t\t\t\t\t\t\tusePanelInfo,",
        "(0, react_jsx_runtime.jsx)(SessionTree, {\n\t\t\t\t\t\t\trenderSlot,\n\t\t\t\t\t\t\tusePanelInfo,",
    ),
    # --- 5. Thread renderSlot + the owning workspace id from the TREE call site only ---
    (
        "SessionNodeItem call site",
        """\t\t\t\t\t\t\t\t\t\treturn (0, react_jsx_runtime.jsx)(SessionNodeItem, {
\t\t\t\t\t\t\t\t\t\t\tnode,
\t\t\t\t\t\t\t\t\t\t\tcurrentId: current,""",
        """\t\t\t\t\t\t\t\t\t\treturn (0, react_jsx_runtime.jsx)(SessionNodeItem, {
\t\t\t\t\t\t\t\t\t\t\tnode,
\t\t\t\t\t\t\t\t\t\t\tcurrentId: current,
\t\t\t\t\t\t\t\t\t\t\trenderSlot,
\t\t\t\t\t\t\t\t\t\t\t// only the tree knows which workspace a row belongs to; the
\t\t\t\t\t\t\t\t\t\t\t// flat and search lists pass neither prop, so they stay bare
\t\t\t\t\t\t\t\t\t\t\tworkspaceId: group.workspaceId,""",
    ),
    # --- 6. Declare the two seam children on the sidebar.workspaces registration ---
    (
        "seam children registration",
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
\t\t\t\t} },""",
    ),
]


def anchor_counts(text):
    """{name: occurrence count of `old`} for every patch entry."""
    return {name: text.count(old) for name, old, _ in PATCHES}


def first_failure(text):
    """(name, count) of the first anchor that is not found exactly once, else None."""
    for name, old, _ in PATCHES:
        n = text.count(old)
        if n != 1:
            return (name, n)
    return None


def apply(text):
    """Apply every patch entry; raise ValueError naming the anchor on any drift."""
    for name, old, new in PATCHES:
        n = text.count(old)
        if n != 1:
            raise ValueError(
                f"anchor {name!r} found {n} times (need exactly 1) — upstream drift; nothing was patched"
            )
    for name, old, new in PATCHES:
        text = text.replace(old, new)
    return text


def is_ours(text):
    return MARKER in text


def is_current_rev(text):
    return REV_COMMENT in text


def seam_present(text):
    return any(s in text for s in SEAM_STRINGS)
