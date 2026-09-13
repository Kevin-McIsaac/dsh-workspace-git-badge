# SEAM.md — the `sidebar.workspaces.sessionRow` seam

The sidebar badge needs two small additive slots in the workspace browser: one on
each **session** row (the badge) and one in that row's existing hover card (the
badge's provenance line). This file documents what the patch does, how to apply
it, and why it is safe.

## Why the session row, not the workspace row

A workspace row cannot know which worktree a conversation is working in — DSH
records no session→worktree link at all (session cwd is immutable creation
metadata, and `attachSession` requires it to equal the workspace path) — so a
per-workspace badge must either guess or report the main checkout while the work
happens in a tree. A **session** row carries a session id, and the plugin's status
route resolves that id to the checkout the conversation is actually working in.
The badge therefore belongs where the identity is.

## What the patch is

`diff seam/pristine-client.js seam/patched-client.js` — +39/−3 lines against
`@deepseek-ai/dsh-client-ui-workspace/lib/client.js`:

1. Declares two children on the existing `sidebar.workspaces` slot registration:

   ```js
   "sidebar.workspaces.sessionRow":        { kind: "list", scope: "root" },
   "sidebar.workspaces.sessionRow.detail": { kind: "list", scope: "root" }
   ```

   — the same additive pattern as `conversation.composer.dock`.

2. Renders the badge inside `SessionNodeItem`'s children, immediately after the
   title span, through the props-face `renderSlot` with the row owner share
   `{ sessionId, workspaceId, label }`. It returns **`null`** — not a fallback
   element — when no plugin occupies the seam, so a pristine install renders
   exactly as upstream.

3. Renders the detail slot inside `SessionHoverContent`, the card upstream already
   opens for a session row. A badge that opened its own tooltip there would nest
   two cards, so the provenance line goes *into* the existing one.

4. Threads `renderSlot` and `workspaceId` into `SessionNodeItem` from the **tree
   call site only** (`workspaceId: group.workspaceId`). The flat "all sessions"
   list and the search-result list render the same component without either prop,
   so `renderSessionRowSeam` returns `null` for them and those lists stay bare
   without needing a guard of their own.

With no plugin registered the rows render byte-identically to upstream. The
full write-up for maintainers is in [`PR.md`](PR.md).

## Applying it locally

`seam/apply.sh` patches the installed package in place:

```bash
seam/apply.sh status    # inspect: patched / out of date / pristine / upstream-landed / drift
seam/apply.sh apply     # patch (and upgrade an older patch of ours in place)
seam/apply.sh revert    # restore the upstream files from backup
```

`status` mutates nothing and is the first thing to run **after a DSH update**,
because a DSH release rewrites `lib/client.js` and invalidates the hash-guard. It
reports the installed hash, whether it matches the pinned baseline, this repo's
current patched artifact, or an older artifact of ours, whether a revert backup
exists, and whether the seam is declared — then gives a verdict. It exits `0` for
a recognised state (patched / out of date / pristine / upstream-landed) and `1`
for drift, so it is usable in a script. On drift it prints the rebuild commands.

Note the tell it encodes: **hashes, not version strings.** The package version is
read from whichever copy is installed and says nothing about which bytes they
are — the same trap that made a dev-install look current when it was not.

Safety rails:

- **Occupant errors cannot cost the sidebar.** The host wraps each registered
  *entry* in an error boundary, but the outlet a row renders is not covered by it:
  a throw in an occupant's render path propagates into the workspace browser, and
  the shell **abdicates that browser entry** — blanking the whole sidebar. Both
  seam renders are therefore wrapped in the patch's own boundary, which renders
  `null` and logs `[dsh-git-badge] seam entry failed; badge omitted:`. A broken
  occupant loses its badge, never the region. (Learned the hard way: the first
  session-row patch blanked the sidebar a second after boot, and the revert did
  not say why.)
- **Hash-guard**: `apply` proceeds only when the installed `lib/client.js` is the
  sha256 pinned in the script (`seam/stamp-hash.sh` re-pins it after a rebuild),
  **or** an artifact this repo built (`PREVIOUS_PATCHED_HASHES`, plus the marker
  comment every generated artifact carries). An upstream update is never
  blind-overwritten.
- **Own-artifact vs upstream-landed**: the two used to be indistinguishable,
  because both make the seam string appear in the file — and the old
  "seam present → skip" test therefore silently refused to install every *rebuilt*
  patch. Now `apply` upgrades an older artifact of ours in place, and skips only
  when the seam is present in a file that is **not** ours (a genuine upstream
  landing), which is what the `dsh-git-badge:seam-patch` marker is for.
- **Reversible, but downgrade-guarded**: `revert` restores the **upstream**
  baseline — taken from `pristine-client.js`, not from the bytes being replaced,
  so reverting from a stale patch of ours lands on upstream rather than on the
  older seam. It refuses when the installed file is neither an artifact of ours
  nor the backup, because after a DSH update that would overwrite a newer upstream
  file with an older one. `status` flags that in advance under `revert: would
  REFUSE`. The upstream host half is a no-op stub (`seam/pristine-index.js`), and
  `backup-*.js` is gitignored, so any checkout can apply and revert on its own.

`seam/make-patch.sh` regenerates `patched-client.js` from `pristine-client.js`
(anchor-asserted, so upstream drift fails loudly instead of mispatching).

Migrating from the old workspace-row patch needs nothing special: the previous
artifact's hash is listed in `apply.sh`, so `apply` recognises it as ours, backs
up upstream, and installs the session-row seams in its place.

## Rebuilding after a DSH upgrade

A DSH update that touches `lib/client.js` fails the hash-guard by design. The
rebuild is:

```bash
PKG="$HOME/.config/nvm/versions/node/v22.23.2/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-workspace"
cp "$PKG/lib/client.js" seam/pristine-client.js   # 1. new upstream baseline
cp "$PKG/lib/index.js"  seam/pristine-index.js
seam/make-patch.sh                                # 2. regenerate (fix anchors if it fails)
seam/stamp-hash.sh                                # 3. re-pin PRISTINE_HASH
seam/apply.sh apply                               # 4. patch the installed package
```

Upstream refactors can rename props or reorder call sites while the seam
concept is unchanged. `make-patch.sh` stops on the first anchor it cannot find;
edit the anchor string there to match the new upstream text — never hand-edit
`patched-client.js`, it is generated. Changing the patch itself does **not**
require a `revert` first: `apply` upgrades its own artifacts in place (that was
the old behaviour's trap, and the marker exists to keep it fixed).

## Why it should be upstream

The sidebar has no per-row additive seam today (`sidebar.workspaces` is a single
slot; its only child is a `single`-kind directory flow). List-kind children on
`sidebar.workspaces` mirror the proven `conversation.composer.dock` pattern and
unlock row annotations — git badges being the first — as pure plugins. The
session row is the one that matters for anything git-related, because a session
is the unit that knows which checkout it is using.
