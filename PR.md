## Summary

Adds a per-row additive slot to the sidebar workspace browser, following [discussion #5092](https://github.com/deepseek-ai/deepseek-harness/discussions/5092) (git status badge on workspace rows) and the review there confirming no per-row seam exists today.

- Declares `'sidebar.workspaces.row': { kind: 'list'; scope: 'root' }` as a second child of the `WorkspaceBrowser` entry, mirroring the `conversation.composer.dock` additive pattern.
- Renders it inside `ProjectRowItem`'s title area via the props-face `renderSlot`, with the dispatch `fallback` set to the exact upstream title span — a plugin-less install renders byte-identically, and occupancy swaps fallback → entry reactively (the outlet's `useSyncExternalStore` pairing).
- Entries receive a row owner share as plain props: `{ workspaceId?, cwd?, label }`. **`cwd` is the raw host path** — the hover card's abbreviated `~/...` stays display-only — so occupants can query workspace-scoped services without re-resolving.
- `renderSlot` threads `WorkspaceBrowser → SessionTree → ProjectRowItem` (three props, no new state); the hover card is untouched.

## Reference implementation

[`dsh-git-badge`](https://github.com/Kevin-McIsaac/dsh-workspace-git-badge) — published npm bundle that renders Claude-Code-statusline-style git badges (`| 🟡 main ↑0 ↓2 ✎3`) through this seam, with graceful degradation to name-only rows when the seam is absent. `PR.md`/`SEAM.md` in that repo document the seam contract from the occupant's perspective.

## Notes for reviewers

- `SlotOutlet` anchors entries as a `<div style="display:contents">` inside `span.projectText` — invalid HTML nesting strictly speaking, but `display:contents` keeps the anchor out of layout and browsers accept it; the flex row is unaffected.
- The ungrouped bucket row also exposes the seam (`workspaceId`/`cwd` undefined, `label` = dictionary copy) — occupants filter on `workspaceId`.
- No new state, stores, or locale keys; the diff is 3 files, +38/−5.
