# Changelog

All notable changes to this package are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions before 0.6.0 predate this file; their history is in `git log` and on
npm. 0.6.0 is the first release recorded here.

## [Unreleased]

### Changed

- **Both surfaces draw the same status mark.** The input chip no longer leads with
  a 🔴/🟡/🟢 emoji dot: it renders the SAME 12px SVG mark as the sidebar row — a
  filled **circle**, or a **tree** for a linked `git worktree` — so the shape says
  *worktree or not* and the fill says *status*, identically wherever the badge
  appears. The `⑂` worktree glyph is gone with the emoji: the tree shape already
  says "worktree". The mark is drawn rather than typed because 🌳 is a **colour
  emoji** — CSS cannot tint its leaves — and the fill comes from the app's own
  `--dsw-alias-state-{success,warn,error}-primary` tokens, so the mark follows
  light/dark and custom themes, which the hardcoded emoji could not. Neither colour
  nor shape is the only channel: the mark carries an accessible name.
- **The sidebar row shows status, not the branch.** The row keeps the workspace
  name on the left and floats the status mark to the right, with a worktree's
  directory name beside it; the `|` separator is gone. The branch, sync counts and
  operation token stay on the input chip, the surface scoped to the current
  conversation.
- **The status endpoint no longer accepts a filesystem path.** The caller now says
  *who it is* and the server resolves the workspace itself: `?session=<id>` for the
  input chip, `?workspace=<id>` for a sidebar row. `?path=` is refused with
  `target-required`; unresolvable ids return `session-not-found` or
  `workspace-not-found`. The path was previously caller-chosen (allowlist-bounded
  and read-only, but still chosen by the caller) on a route that answers without
  GUI authentication.
- A session is resolved through the workspace registry first, so a conversation
  that is no longer live still renders a badge. The live session's directory is
  consulted only for the window before a new session is attached to its workspace,
  and the registry still validates it.
- The client half no longer requires the `workspaces` service — declared services
  are now just `["slots"]` — and change notifications carry the workspace id, so
  subscribers match on identity rather than on a path.

### Added

- **The input chip now says which working tree a conversation is in.** A linked
  `git worktree`'s directory name is appended after the branch —
  `🌳 main hotfix-tree ↑0 ↓2 ✎3` — because several worktrees of one repository
  otherwise render identical chips and the chip carries no other workspace
  identity. The name is dropped when the branch already implies it (`repo-feat-x`
  on `feat-x` shows just the tree), a main checkout appends nothing, and the
  response reports `isWorktree` / `worktreeName` from one stat of the git dir the
  existing `rev-parse` already returned — no extra git invocation. Naming the
  worktree is chip-only, like the operation token. The value is a directory NAME,
  never a path.
- **A server-side poll fallback for workspaces whose file watcher failed.** A
  workspace whose recursive `fs.watch` could not be established, or which later
  errored, is polled every 5s on a state key (status + refs fingerprint +
  in-progress operation) instead of depending only on the client's 60s fallback.
- `seam/apply.sh status` — reports patched / pristine / upstream-landed / drifted
  by hash, exit 1 on drift with the exact rebuild commands.

### Fixed

- **The input chip now refreshes on change events.** Change events identify the
  *workspace*, and the client matched them against its own target id. A sidebar row
  targets by workspace id so rows kept working, but the chip targets by session id,
  which can never equal a workspace id — so its handler never fired and the chip
  only updated when it remounted (switching conversations) or on the 60s fallback
  poll. The status response now echoes the resolved workspace id and the client
  matches on that. This was a regression in the server-side resolution change.
- **A linked worktree's badge only refreshed on a file edit.** The watcher watched
  the workspace root, but a linked worktree's git dir lives OUTSIDE it
  (`<main>/.git/worktrees/<name>`), so `git add`, `git commit` and `git checkout`
  there wrote nothing the root watch could see: the badge stayed stale until a
  worktree file changed or the client's 60s poll fired. The per-worktree git dir
  now gets its own watcher, resolved from the `.git` gitfile (which covers
  submodules too), and either watcher erroring drops both and hands over to the
  degraded poll. A regression test that stages a file written before the watch
  existed fails without the second watcher.
- **The TTL fetch no longer delays the status response.** `ahead`/`behind` are
  read from the local remote-tracking ref, and the fetch that refreshes it was
  awaited before answering, so any request arriving after the 60s TTL had lapsed
  paid a full network fetch first (~3.3s measured) — which is the first request
  after every TTL window, i.e. constantly while editing. Badge updates triggered
  by an edit took seconds for a repo with a remote. The response is now served
  from the refs at hand and the fetch runs out of band; when it succeeds it
  notifies subscribers, which reconverge in ~40ms. Same call, expired TTL: 27ms.
  The trade is that `ahead`/`behind` can lag by up to one fetch — branch, dirty
  state and file counts are never delayed.
- The plugin's `surfaces:` console line reported the boot-time race instead of the
  outcome: it printed `sidebar rows = off (seam absent)` while row badges were
  visibly rendering, because it sampled the seam declaration before the workspace
  browser published it. It now reports from the registration callback, and the
  boot-time line says it is awaiting the seam rather than declaring it missing.

## [0.6.0] - 2026-09-12

### Fixed

- **`✎n` under-counted new files.** Git collapses a new directory into a single
  status entry, so adding a folder of 3 files displayed `✎1`. Untracked files are
  now counted individually. If walking a very large untracked tree exceeds the time
  budget, the badge falls back to the collapsed count and reports which mode
  answered (`untrackedMode`) instead of silently showing a wrong number.

### Added

- **An in-progress operation token.** A paused merge, rebase, cherry-pick, revert,
  bisect or sequencer run now appears after the branch name —
  `🟡 main ⚔rebase ↑0 ↓2 ✎3`. A rebase whose conflicts are already staged has no
  unmerged files, so the three-state dot could not express it. The dot contract
  itself is unchanged, and the token is chip-only.
- **A 41-test node-half suite** (`npm test`) covering the status parser, git
  plumbing against real repositories, request routing, SSE framing and the
  filesystem watcher — runnable without booting DSH.
- **A CI test workflow** running the suite on Node 20/22/24.

### Changed

- Publishing runs through **npm trusted publishing** (OIDC) on a published
  release, gated on the suite, with SLSA provenance — no long-lived token.
- Event stream hardening: `x-accel-buffering: no`, named `change` frames, cleanup
  on disconnect, and an unload disposer that also releases the filesystem watchers.
- `detail=1` is annotated as having no consumer yet (the hover card remains
  pending). Its comment previously claimed `log -1` while the code ran `log -3`.

[Unreleased]: https://github.com/Kevin-McIsaac/dsh-workspace-git-badge/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/Kevin-McIsaac/dsh-workspace-git-badge/releases/tag/v0.6.0
