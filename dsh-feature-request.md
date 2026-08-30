# Feature request: Git status badge on sidebar workspace rows

## Summary

Show each Workspace's git state directly on its sidebar row, Claude Code
statusline-style:

```
the_paragliding_app  | 🟡 main
paragliding_site_federation  | 🟢 main ↑2
```

Name stays in the row's normal styling; everything after the separator is
muted tertiary text. The emoji is the only colored element — green when the
working tree is clean, yellow when it has uncommitted changes.

## Why

The sidebar is where I decide *which workspace to work in*, but it currently
says nothing about the state of those workspaces. Answering "is anything
uncommitted here?", "which checkout am I on?", or "does this branch need a
push?" requires opening a terminal per workspace. Claude Code's status line
set the expectation: one glance, per project, at branch + dirty + sync state.
For multi-checkout work (main checkout + worktrees), the rows are
indistinguishable today; with the badge they read at a glance.

## Proposed UX

### Row (always visible)

```
the_paragliding_app  | 🟢 main
the_paragliding_app  | 🟡 main ↑1 ↓2
```

- `name | emoji branch` — pipe separator in tertiary; branch in tertiary, 12px.
- Emoji: 🟢 clean, 🟡 dirty (uncommitted changes present).
- `↑n` / `↓n` appended only when nonzero — unpushed / unpulled commit counts.
- Graceful states: name-only while loading, for the Ungrouped bucket, and for
  non-git directories — those rows are otherwise unidentifiable if the badge
  replaced the name.
- Keep the workspace name always (not replaced by git info), so rows stay
  stable when switching between git and non-git workspaces.

### Hover card (detail on demand)

The existing workspace hover card gains a git section:

```
the_paragliding_app
~/Projects/the_paragliding_app
Created 28 Aug, 15:12
──────────────────────────────
🟡 main · 2874788 · ↑1 ↓2
1 uncommitted file · 8 untracked
last commit: 08c58a1 "ui: Claude Code statusline style" · 12 minutes ago
```

- Branch, short commit hash, sync counts on one line.
- Dirty detail split into changed vs untracked file counts — the row can't
  carry this.
- Last commit hash, subject, and relative age.

## Behavior notes (UX-level)

- **Freshness**: status must not freeze at mount time — a row showing 🟡 after
  the user has committed is worse than no badge. Poll on a modest interval
  (a few seconds) with a per-workspace shared cache so row and hover agree.
- **Momentum**: the badge should feel passive — no interaction required, no
  action buttons in v1. Hover carries the detail.
- **Low visual weight**: everything after the pipe is muted; the emoji is the
  single color signal. No brackets, no extra badges.
- **Long names/branches**: the workspace name keeps priority; git part should
  truncate, never push the name out.

## Questions for maintainers

1. Is per-workspace git state something you'd want computed host-side and
   exposed to the client (the browser can't run git), or is this better
   scoped as an extension point (a row annotation slot) that a plugin fills?
2. Any concern with rows becoming a live surface (polling) — and if so, what
   cadence/trigger would you prefer (e.g. refresh on hover or on sidebar
   focus instead of interval)?
3. Would you accept emoji, or would you want a themed dot/icon consistent
   with the existing state aliases?

Happy to test any proposed design against a two-workspace setup (main
checkout + worktrees) — that's where this earns its keep.
