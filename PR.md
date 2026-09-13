## Summary

Adds per-**session**-row additive slots to the sidebar workspace browser, following [discussion #5092](https://github.com/deepseek-ai/deepseek-harness/discussions/5092) (git status badge on workspace rows) and the review there confirming no per-row seam exists today.

The badge belongs on the session row, not the workspace row: a workspace row cannot know which worktree a conversation is working in — DSH records no session→worktree link, since session cwd is immutable creation metadata and `attachSession` requires it to equal the workspace path — so a per-workspace badge must either guess or report the main checkout while the work happens in a tree. A session row carries a session id, which is the identity anything git-related can actually resolve.

- Declares `'sidebar.workspaces.sessionRow': { kind: 'list'; scope: 'root' }` and `'sidebar.workspaces.sessionRow.detail': { kind: 'list'; scope: 'root' }` as children of the `WorkspaceBrowser` entry, mirroring the `conversation.composer.dock` additive pattern.
- Renders the badge inside `SessionNodeItem`'s children, immediately after the title span, via the props-face `renderSlot`. An **unoccupied** seam renders `null`, so a plugin-less install is byte-identical to upstream.
- Renders the detail slot inside `SessionHoverContent` — the card upstream already opens for a session row. A badge that opened its own tooltip there would nest two cards, so the provenance line goes *into* the existing one.
- Entries receive a row owner share as plain props: `{ sessionId, workspaceId, label }`.
- `renderSlot` and `workspaceId` are threaded into `SessionNodeItem` from the **tree call site only** (`workspaceId: group.workspaceId`). The flat "all sessions" list and the search-result list render the same component without either prop, so the seam helper returns `null` for them: those lists stay bare with no guard of their own, and no plugin has to know they exist.

## Reference implementation

[`dsh-git-badge`](https://github.com/Kevin-McIsaac/dsh-workspace-git-badge) — published npm bundle that renders git status badges through this seam. Each session row shows the status mark (a circle, or a tree for a linked worktree) plus, when the branch has one, the PR/CI token: `🌳 PR#391 ✓`. The row deliberately never names a branch; which checkout the badge describes is the hover card's business, rendered through the detail slot. The input-row chip (`conversation.input.left`, upstream — no patch needed) keeps the full text: branch, worktree name, operation token, sync/dirty counts and the PR token, with a hover card of its own. `PR.md`/`SEAM.md` in that repo document the seam contract from the occupant's perspective, including how it degrades to chip-only on an unpatched install.

## Notes for reviewers

- `SlotOutlet` anchors entries as a `<div style="display:contents">`; the session row is a flex row, and `display:contents` keeps the anchor out of layout, so the markup is additive and the row's existing title/ellipsis behaviour is unaffected.
- The seam sits between the title and the schedule/time cluster, which is where a right-aligned badge costs the title nothing: the title already carries `flex: 1`, so an entry simply takes its place ahead of the time, and the time still hides on hover as it does today.
- No new state, stores, or locale keys; the change is purely additive — two declared list slots, two props threaded through one component, and one extra child in an existing children array and an existing hover-card body.
