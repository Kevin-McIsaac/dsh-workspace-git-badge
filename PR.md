# PR: `sidebar.workspaces.row` — a per-row additive slot for the workspace browser

Proposal following [discussion #5092](https://github.com/deepseek-ai/deepseek-harness/discussions/5092)
(git status badge on sidebar workspace rows) and the review confirming there
is no per-row seam today.

## Summary

Adds one `list`-kind child to the existing `sidebar.workspaces` slot
registration and renders it inside `ProjectRowItem`'s title area. Mirrors the
`conversation.composer.dock` additive pattern exactly: declarative child,
props-face `renderSlot`, empty-list fallback.

```js
children: { "sidebar.workspaces.directoryFlow": { kind: "single", scope: "root" },
            "sidebar.workspaces.row":            { kind: "list",   scope: "root" } }
```

Entries receive a row owner share as plain props:

```ts
{ workspaceId: string | undefined, cwd: string | undefined, label: string }
```

- `cwd` is the **raw** workspace path (the hover card's abbreviated display
  path stays display-only) — entries need the real path to query
  workspace-scoped services.
- Rendering falls back to the exact upstream title span when the slot has no
  entries, so a plugin-less install is visually unchanged, and late
  registration swaps fallback → entry reactively (the outlet's
  `useSyncExternalStore` pairing).

## Why a seam

The composer already proved the pattern: `conversation.composer.dock` is an
open additive list slot, which is why composer-adjacent contributions (todo
dock, goal entry, git chips) ship as independent plugins. The sidebar has no
equivalent: `sidebar.workspaces` is `kind: "single"`, occupied by the browser
itself, so a second plugin registering there shadows the whole session tree.
A per-row list slot is the minimal additive opening for row annotations — git
status being the motivating case ([reference implementation](https://github.com/Kevin-McIsaac/dsh-workspace-git-badge):
`dsh-git-badge`, which renders branch/emoji/sync badges through this seam and
degrades to name-only rows without it).

## Scope notes for reviewers

- `renderSlot` is threaded `WorkspaceBrowser → SessionTree → ProjectRowItem`
  (three props, no new state).
- `SlotOutlet` anchors entries as a `<div style="display:contents">` inside
  `span.projectText` — invalid HTML nesting strictly speaking, but
  `display:contents` keeps the anchor out of layout; browsers accept it and
  the flex row is unaffected.
- No hover-card changes; a detail slot can follow the same pattern later if
  wanted.

## Diff

32 lines against `packages/client/ui-workspace` — see
`pristine-client.js → patched-client.js` in the reference repo, or the
`make-patch.sh` builder that asserts every anchor.
