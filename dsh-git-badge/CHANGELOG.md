# Changelog

All notable changes to this package are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions before 0.6.0 predate this file; their history is in `git log` and on
npm. 0.6.0 is the first release recorded here.

## [Unreleased]

### Added

- **A hover card on the input chip.** Resting a pointer on the chip now shows what
  the chip has no room for: the file breakdown (`✎3` split into staged / unstaged
  / unmerged / untracked, so *ready to commit* is distinguishable from *not staged
  yet*), the last three commits with their ages, and the stash count. When the
  untracked walk fell back to git's collapsed count the card says `(collapsed)`
  rather than presenting an under-count as exact.
  The card consumes the `detail=1` payload the node half has carried unused since
  0.6.0, and it is **lazy**: the extra fields cost a `log -3` plus a stash list, so
  they are fetched only once a pointer rests on the chip and then kept fresh over
  the same SSE path. A badge refresh fires on every file edit, and the everyday
  chip still pays for none of it. It uses the shell's own seeded `Tooltip`
  primitive — no new dependency, no seam patch — and if that primitive is ever
  absent the chip renders uncarded rather than not at all. The boot log reports
  which path was taken (`[dsh-git-badge] hover card = on (shell Tooltip
  primitive).`), because the guard that keeps the badge working would otherwise
  make a missing seed look like a missing feature.
- **A PR / CI token on the input chip.** When the branch has a GitHub pull
  request the chip carries `PR#142` with the rollup state (`✓` passing, `…`
  running, `✗` failing) and a `draft` marker. It reads the PR through the user's
  own `gh` CLI, so the plugin never handles a credential. The rollup is reduced to
  one worst-case state (a single failure outweighs any number of successes), the
  token carries an accessible name naming the state, and the hover card spells out
  the check state, draft and review decision.
- `?pr=1` on the status route. PR/CI is asked for by the **chip only**, so a
  sidebar that surveys twenty workspaces never spawns twenty `gh` processes. The
  read is TTL-bounded (~90s per repository), refreshed out of band exactly like
  the existing fetch, and notifies subscribers only when the state actually
  changes.
- **PR/CI degrades to an absent field, never an error.** No `gh`, a logged-out
  `gh`, a non-GitHub remote, an offline network, a rate limit, unparseable output
  and a timed-out call all render the unchanged chip: a caller cannot tell "no PR"
  from "no `gh`", because neither changes what should be displayed.
- A `runCli` helper the git and `gh` invocations now share, so `gh` inherits the
  same timeout / missing-binary / exit-code semantics (and `GIT_TERMINAL_PROMPT`'s
  analogue, `GH_PROMPT_DISABLED`, keeps an auth prompt from hanging a refresh).

### Changed

- The `detail=1` payload has a consumer at last. Its annotation said "no surface
  consumes this yet"; the input chip's hover card is that surface, so the
  branch/last-commits/stash fields are no longer speculative.
- `config` gains `prStatus` (`"auto"` / `"off"`), `prTtlMs`, `prTimeoutMs` and a
  `prRunner` test seam mirroring `gitRunner`.

## [0.7.0] - 2026-09-12

### Changed

- **Both surfaces draw the same status mark.** The input chip no longer leads with
  a 🔴/🟡/🟢 emoji dot: it renders the SAME SVG mark as the sidebar row — a
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

- **A client-half test suite, plus submodule coverage.** `test/client.test.mjs`
  loads the real `lib/client.js` behind a stub module loader and renders both
  registered surfaces, so the mark's shape/colour rules, the row's "never show the
  branch" rule, the right-float and the worktree-name suppression are asserted in
  CI rather than eyeballed. The node half gains a real-submodule fixture: a
  submodule is asserted **not** to be a worktree (its gitfile alone must not decide
  it — worktree-ness is the `commondir` marker) while its out-of-tree git dir is
  still watched, like a linked worktree's.
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

[Unreleased]: https://github.com/Kevin-McIsaac/dsh-workspace-git-badge/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/Kevin-McIsaac/dsh-workspace-git-badge/releases/tag/v0.7.0
[0.6.0]: https://github.com/Kevin-McIsaac/dsh-workspace-git-badge/releases/tag/v0.6.0
