# SEAM.md — the `sidebar.workspaces.sessionRow` seam

The sidebar badge needs one small additive slot in the workspace browser: the
badge on each **session** row. Its provenance line needs no slot of its own —
upstream declares one. This file documents what the patch does, how to apply it,
and why it is safe.

## Why the session row, not the workspace row

A workspace row cannot know which worktree a conversation is working in — DSH
records no session→worktree link at all (session cwd is immutable creation
metadata, and `attachSession` requires it to equal the workspace path) — so a
per-workspace badge must either guess or report the main checkout while the work
happens in a tree. A **session** row carries a session id, and the plugin's status
route resolves that id to the checkout the conversation is actually working in.
The badge therefore belongs where the identity is.

## What the patch is

The patch is defined once, in [`seam/anchors.js`](seam/anchors.js), as
`(name, old, new)` pairs — each `old` must occur **exactly once** in
`@deepseek-ai/dsh-client-ui-workspace/lib/client.js`, and is replaced by `new`
(+48/−0 lines):

1. Declares one child on the existing `sidebar.workspaces` slot registration:

   ```js
   "sidebar.workspaces.sessionRow": { kind: "list", scope: "root" }
   ```

   — the same additive pattern as `conversation.composer.dock`.

2. Renders the badge inside `SessionNodeItem`'s children, immediately after the
   title span, through the props-face `renderSlot` with the row owner share
   `{ sessionId, label }`. It returns **`null`** — not a fallback element — when
   no plugin occupies the seam, so a pristine install renders exactly as
   upstream.

3. That is the whole change. DSH **0.2.0-rc.2** already threads `renderSlot` into
   `SessionNodeItem` and `SessionHoverContent` itself, and declares
   `sidebar.session.row.hover`, so the badge's provenance line rides that
   upstream seat and needs no patch. Nothing is threaded by hand.

Rev 3 of the patch is this one-seam shape. Rev 2 carried a second patched seam
(`sidebar.workspaces.sessionRow.detail`) and threaded `renderSlot`/`workspaceId`
into `SessionNodeItem` from the tree call site. Both became unnecessary when
upstream shipped its own hover seat and its own `renderSlot` threading.

With no plugin registered the rows render byte-identically to upstream. The
full write-up for maintainers is in [`PR.md`](PR.md).

### What the badge no longer gates on

Rev 2 passed `workspaceId` from the tree call site only, so the badge rendered on
tree rows and not in the flat "In one list" grouping. Upstream no longer passes a
workspace id to `SessionNodeItem`, so rev 3 renders the badge wherever a session
row renders — tree and flat. Search results are unaffected: they use a different
component with no seam. This is deliberate: the badge is seeded by `sessionId`
alone, so it is correct in both groupings.

## Applying it

The patcher **ships in the npm package** (`seam/apply.js`, published as the
`dsh-git-badge-seam` bin), so a market install needs no clone:

```bash
npx dsh-git-badge status    # inspect: patched / out of date / patchable / upstream-landed / drift
npx dsh-git-badge apply     # patch (and upgrade an older patch of ours in place)
npx dsh-git-badge revert    # restore the bytes as found before patching
```

In this repo, `seam/apply.sh` is a wrapper that runs the same shipped tool and
keeps its revert backups in the repo's `seam/`; either entry point works.

The patch is defined ONCE, in `dsh-git-badge/seam/anchors.js` (pure Node — no
python3 prerequisite). `npx` runs it from the installed package; the wrapper
runs it from the working tree, which is how a patch change is tested before
release. `DSH_INSTALL` overrides the DSH root (default: the global npm root's
`@deepseek-ai/dsh`), and `SEAM_DATA_DIR` overrides where revert backups go.

`status` mutates nothing and is the first thing to run **after a DSH update**.
It reports the installed hash, whether the anchors still resolve (and, on drift,
WHICH anchor moved and how often it now occurs), whether the installed file
carries this repo's marker, whether a revert backup exists, and whether the seam
is declared — then gives a verdict. It exits `0` for a recognised state (patched
/ out of date / patchable / upstream-landed) and `1` for drift.

Note the tell it encodes: **hashes, not version strings.** The package version is
read from whichever copy is installed and says nothing about which bytes they
are — the same trap that made a dev-install look current when it was not.

Safety rails:

- **Occupant errors cannot cost the sidebar.** The host wraps each registered
  *entry* in an error boundary, but the outlet a row renders is not covered by it:
  a throw in an occupant's render path propagates into the workspace browser, and
  the shell **abdicates that browser entry** — blanking the whole sidebar. The
  seam render is therefore wrapped in the patch's own boundary, which renders
  `null` and logs `[dsh-git-badge] seam entry failed; badge omitted:`. A broken
  occupant loses its badge, never the region. (Learned the hard way: the first
  session-row patch blanked the sidebar a second after boot, and the revert did
  not say why.)
- **Anchor guard, not a hash guard**: `apply` patches the INSTALLED `client.js`
  in place, proceeding only when every anchor in `dsh-git-badge/seam/anchors.js`
  is found exactly once; anything else is drift and NOTHING is written. A DSH
  update that changes anything outside the anchor blocks no longer invalidates
  the patch — the old whole-file sha256 pin was a rebuild every release, even
  when the seam targets were untouched. The pinned hash (`KNOWN_GOOD_HASH`)
  survives as an advisory: `status` reports whether the installed build is the
  one the anchors were verified against, but `apply` does not require it.
- **Own-artifact vs upstream-landed**: both make the seam string appear in the
  file, so the `dsh-git-badge:seam-patch` marker (with a rev number) is what
  distinguishes them. `apply` upgrades an older artifact of ours in place —
  validating the revert backup's anchors BEFORE overwriting anything — and skips
  only when the seam is present in a file that is **not** ours (a genuine
  upstream landing).
- **Reversible, and downgrade-guarded**: `revert` restores the **bytes as found
  before patching** (`seam/backup-client.js`, taken from the installed file at
  the moment of first patching), so it always puts back exactly what was there.
  It refuses in two cases. First, when the installed file is not our artifact,
  because after a DSH update that would overwrite a newer upstream file with an
  older one. Second, when the **backup itself** is from another upstream
  generation — the current anchors do not resolve against it, so restoring it
  would downgrade the package AND leave a build this patch cannot re-apply. That
  second case is easy to acquire by accident: `apply` patches whichever
  `SEAM_DATA_DIR` it is pointed at, so the shipped default
  (`$DSH_HOME/git-badge-seam`) and this repo's wrapper (`seam/`) each keep their
  own backup, and applying through one leaves the other's behind. `status` flags
  either refusal in advance under `revert: would REFUSE`. The upstream host half
  is a no-op stub (`seam/stub-index.js`), and `backup-*.js` is gitignored, so any
  checkout can apply and revert on its own.

## Rebuilding after a DSH upgrade

A DSH update that changes `lib/client.js` is now usually a non-event: run
`dsh-git-badge-seam status` — if every anchor still resolves, `apply` patches the
new build directly. Only when an anchor actually moved do you need to edit
`dsh-git-badge/seam/anchors.js`, and the drift report names the anchor to fix:

```bash
dsh-git-badge-seam status    # 1. drift? the report names the anchor that moved
#   (only if an anchor moved) update that entry in dsh-git-badge/seam/anchors.js
#   to the new upstream text — never hand-edit anything else
dsh-git-badge-seam apply     # 2. patch the new build in place
```

To re-verify the advisory pin, copy the new upstream `lib/client.js` over
`seam/pristine-client.js`, run `seam/make-patch.sh` (regenerates
`patched-client.js` — PR-diff artifact only), and update `KNOWN_GOOD_HASH` in
`dsh-git-badge/seam/patch.js` to the new file's sha256. The test suite asserts
the regenerated artifact stays byte-identical to the anchors, so a forgotten
`make-patch.sh` fails CI rather than shipping a stale diff.

Upstream refactors can rename props or reorder call sites while the seam
concept is unchanged; that is exactly what the anchor names are for. Changing
the patch itself does **not** require a `revert` first: `apply` upgrades its own
artifacts in place (the old trap — silently skipping rebuilt patches — is what
the marker's rev number exists to prevent).

## Why it should be upstream

The sidebar has no per-row additive seam today (`sidebar.workspaces` is a single
slot; its children are a `single`-kind directory flow and list-kind action seats).
List-kind children on `sidebar.workspaces` mirror the proven
`conversation.composer.dock` pattern and unlock row annotations — git badges
being the first — as pure plugins.

Upstream 0.2.0-rc.2 landed most of this shape already: `renderSlot` now reaches
`SessionNodeItem`, and `sidebar.session.row.hover` is a list seat in the row's
hover card. What is still missing is one seat in the row's text line for an
always-visible annotation. The existing action seat
(`sidebar.workspaces.session.row.action`) is `display:none` until hover, and
`sidebar.session.row.leading` is a 16px cell that renders only while the row is
idle, so neither can host it.
