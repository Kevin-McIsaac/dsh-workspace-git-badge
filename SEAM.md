# SEAM.md — the `sidebar.workspaces.row` seam

The sidebar row badge needs one small additive slot in the workspace browser.
This file documents what the patch does, how to apply it, and why it is safe.

## What the patch is

`diff seam/pristine-client.js seam/patched-client.js` — 32 lines against
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

With no plugin registered the rows render byte-identically to upstream. The
full write-up for maintainers is in [`PR.md`](PR.md).

## Applying it locally

`seam/apply.sh` patches the installed package in place:

```bash
seam/apply.sh apply     # patch + install hints
seam/apply.sh revert    # restore the pristine files from backup
```

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

## Why it should be upstream

The sidebar has no per-row additive seam today (`sidebar.workspaces` is a
single slot; its only child is a `single`-kind directory flow). A `list`-kind
`sidebar.workspaces.row` mirrors the proven `conversation.composer.dock`
pattern and unlocks row annotations — git badges being the first — as pure
plugins.
