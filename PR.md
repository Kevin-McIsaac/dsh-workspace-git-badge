## Summary

Adds a per-row additive slot to the sidebar workspace browser, following [discussion #5092](https://github.com/deepseek-ai/deepseek-harness/discussions/5092) (git status badge on workspace rows) and the review there confirming no per-row seam exists today.

- Declares `'sidebar.workspaces.row': { kind: 'list'; scope: 'root' }` as a second child of the `WorkspaceBrowser` entry, mirroring the `conversation.composer.dock` additive pattern.
- Renders it inside `ProjectRowItem`'s title area via the props-face `renderSlot`, with the dispatch `fallback` set to the exact upstream title span — a plugin-less install renders byte-identically, and occupancy swaps fallback → entry reactively (the outlet's `useSyncExternalStore` pairing).
- Entries receive a row owner share as plain props: `{ workspaceId?, cwd?, label }`. **`cwd` is the raw host path** — the hover card's abbreviated `~/...` stays display-only — so occupants can query workspace-scoped services without re-resolving.
- `renderSlot` threads `WorkspaceBrowser → SessionTree → ProjectRowItem` (three props, no new state); the hover card is untouched.

> **Local extension — not part of this proposal.** The reference repo's `seam/` patch additionally declares and renders `'sidebar.workspaces.row.detail': { kind: 'list'; scope: 'root' }` in the workspace hover card, wired to the node half's `?detail=1` response (last commits + stash). It is deliberately kept out of the upstream ask so the row slot can land on its own; the detail slot can be proposed once the hover design settles. Its owner share matches the row slot — `cwd` is the raw host path. Note that the repo no longer *depends* on it: `?detail=1` is now consumed by the input chip's hover card, which uses the shell-seeded `Tooltip` primitive and the upstream `conversation.input.left` slot, so those fields render with no patch at all.

## Reference implementation

[`dsh-git-badge`](https://github.com/Kevin-McIsaac/dsh-workspace-git-badge) — published npm bundle that renders git status badges through this seam (a status mark — a circle, or a tree for a linked worktree — plus branch and counts, e.g. `● main ↑0 ↓2 ✎3`), with graceful degradation to name-only rows when the seam is absent. `PR.md`/`SEAM.md` in that repo document the seam contract from the occupant's perspective.

## Notes for reviewers

- `SlotOutlet` anchors entries as a `<div style="display:contents">` inside `span.projectText` — invalid HTML nesting strictly speaking, but `display:contents` keeps the anchor out of layout and browsers accept it; the flex row is unaffected.
- The ungrouped bucket row also exposes the seam (`workspaceId`/`cwd` undefined, `label` = dictionary copy) — occupants filter on `workspaceId`.
- No new state, stores, or locale keys; the change is purely additive — one declared list slot, one prop threaded through two components, and the title span swapped for the seam with the same span as its empty-list fallback.
