# SEAM.md — the `sidebar.workspaces.row` seam

The sidebar row badge needs one small additive slot in the workspace browser; a
second, experimental slot exposes row detail in the hover card (item 4 below).
This file documents what the patch does, how to apply it, and why it is safe.

## What the patch is

`diff seam/pristine-client.js seam/patched-client.js` — +40/−8 lines against
`@deepseek-ai/dsh-client-ui-workspace/lib/client.js`:

1. Declares one child on the existing `sidebar.workspaces` slot registration:

   ```js
   "sidebar.workspaces.row": { kind: "list", scope: "root" }
   ```

   — the same additive pattern as `conversation.composer.dock`.

2. Renders it inside `ProjectRowItem`'s title area via the props-face
   `renderSlot`, passing the row owner share `{ workspaceId, cwd, label }`,
   with the upstream title span as the empty-list fallback.

3. Threads `renderSlot` through `WorkspaceBrowser → SessionTree → ProjectRowItem`.

4. Declares and renders a second additive list slot,
   `sidebar.workspaces.row.detail`, in the workspace hover card, with the same
   `{ workspaceId, cwd, label }` owner shape and the **raw** host path as `cwd`
   (the card abbreviates its own display copy separately). No published plugin
   occupies it yet; the node half's `?detail=1` response (last commits + stash,
   "for the hover card") is the intended consumer. `PR.md` scopes the upstream
   proposal to the row slot only.

With no plugin registered the rows render byte-identically to upstream. The
full write-up for maintainers is in [`PR.md`](PR.md).

## Applying it locally

`seam/apply.sh` patches the installed package in place:

```bash
seam/apply.sh status    # inspect: patched / pristine / upstream-landed / drift
seam/apply.sh apply     # patch + install hints
seam/apply.sh revert    # restore the pristine files from backup
```

`status` mutates nothing and is the first thing to run **after a DSH update**,
because a DSH release rewrites `lib/client.js` and invalidates the hash-guard. It
reports the installed hash, whether it matches the pinned baseline or this repo's
patched artifact, whether a revert backup exists, and whether the seam is
declared — then gives a verdict. It exits `0` for a recognised state (patched /
pristine / upstream-landed) and `1` for drift, so it is usable in a script. On
drift it prints the exact rebuild commands.

Note the tell it encodes: **hashes, not version strings.** The package version is
read from whichever copy is installed and says nothing about which bytes they
are — the same trap that made a dev-install look current when it was not.

Safety rails:

- **Hash-guard**: refuses to patch unless the installed `lib/client.js`
  matches the sha256 pinned in the script (`seam/stamp-hash.sh` re-pins it after a
  rebuild). An upstream update is never blind-overwritten.
- **Seam detection**: once upstream declares the seam itself, `apply` becomes
  a no-op and the plugin keeps working unchanged.
- **Reversible**: `revert` restores the exact pre-patch bytes from the backup
  taken at apply time. The upstream host half is a no-op stub
  (`seam/pristine-index.js`).

`seam/make-patch.sh` regenerates `patched-client.js` from `pristine-client.js`
(anchor-asserted, so upstream drift fails loudly instead of mispatching).

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
`patched-client.js`, it is generated.

If a patch is already applied and you only want to change the patch itself,
`seam/apply.sh revert` **first**: `apply` short-circuits on seam detection
*before* the hash-guard, so it would otherwise leave the old patched file in
place.

## Why it should be upstream

The sidebar has no per-row additive seam today (`sidebar.workspaces` is a
single slot; its only child is a `single`-kind directory flow). A `list`-kind
`sidebar.workspaces.row` mirrors the proven `conversation.composer.dock`
pattern and unlocks row annotations — git badges being the first — as pure
plugins.
