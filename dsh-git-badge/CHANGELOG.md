# Changelog

All notable changes to this package are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions before 0.6.0 predate this file; their history is in `git log` and on
npm. 0.6.0 is the first release recorded here.

## [Unreleased]

## [0.14.0] - 2026-09-15

### Added

- **A "next" row at the top of the chip's hover card.** The node half derives
  the single highest-priority next step from fields the status response already
  carries — a paused operation and its resume command, `git pull --ff-only`
  when behind, `git push -u origin <branch>` when no upstream exists on a dirty
  branch, `git push` when ahead, a conservative commit command when dirty
  (`add -p` for unstaged work, `-A` only for untracked-only changes, which
  `add -p` cannot see), and `gh pr checks <n> --watch` when CI fails. Each
  suggestion carries its reason, and the command is a click-to-copy chip — it
  runs in the user's own terminal, never through dsh. Clean, synced, nothing
  failing → no row. Pure derivation: no extra git invocations, and the ranking
  is unit-tested in the node suite.

## [0.13.0] - 2026-09-15

### Added

- **A visible seam-absent notice on the input chip.** When `allowBuilds` keeps
  the postinstall from patching, a market install lands chip-working but
  sidebar-off with no message anywhere — dshmarket cannot see host files, and
  the old hint was a hover tooltip nobody finds. Now, once the 5-second boot
  grace proves the seam is genuinely absent, the chip shows
  *sidebar badges off — run `npx dsh-git-badge apply`* with a dismiss **×**.
  The notice is always true and self-resolving: apply + restart makes the seam
  declare and it never renders again. The × means *stop asking this boot* —
  dismissal is session-scoped, so a seam that is still absent asks again at the
  next boot, and the long-form explanation stays on the chip's hover tooltip.

## [0.12.0] - 2026-09-15

### Removed

- **The restart notice and one-click Restart button are gone from the input
  chip.** The inline text — *restart dsh web to activate the sidebar badges* —
  and its Restart button (`POST /dsh-market/api/v1/restart`) could outlive the
  restart it asked for when the marker survived a boot, and the nag outweighed
  the convenience. The restart-pending marker pipeline is intact server-side
  (`seam/store.js`, `seamRestartPending` on the status response) for a future
  marketplace-surface notification; the chip simply no longer renders it.

## [0.11.0] - 2026-09-14

### Added

- **A one-click restart for the change the marketplace cannot see.** The
  postinstall/apply patches DSH's own files, which is invisible to dshmarket's
  restart bookkeeping — a market install could complete "restart-free" while
  the running bundles no longer matched the disk. Now: the installer writes a
  `restart-pending` marker (`seam/store.js`); the plugin's status response
  carries it; and while it is pending the input chip shows a one-line
  explanation — *the installer patched DSH, client bundles are composed at
  boot* — plus a **Restart** button calling dshmarket's PUBLIC, documented v1
  restart endpoint (`POST /dsh-market/api/v1/restart`, feature-detected via
  `capabilities`; hosts that delegate restart — desktop/supervised — get the
  manual instruction instead, never a hand-rolled process-control path). The
  button polls until the host is serving again, then reloads into the
  recomposed boot. The marker is cleared by the node half at the next boot, so
  it self-expires exactly when the restart it asks for has happened. Applies
  to `revert` too — removing the patch equally needs a restart to take effect.

## [0.10.1] - 2026-09-14

### Fixed

- **Revert backups now live in a stable, user-level store.** They defaulted to
  the patcher's own directory — which for `npx dsh-git-badge` is a cache entry
  keyed by package version, so a backup written by one `apply` was invisible to
  the next `revert`, which then had to refuse ("patched but no backup exists")
  even though the bytes were on disk somewhere. The default is now
  `$DSH_HOME/git-badge-seam` (else `~/.dsh/git-badge-seam`), shared by npx
  runs, the profile bin, the repo wrapper and the postinstall hook;
  `SEAM_DATA_DIR` still overrides. Backups written by older versions to their
  install directories are not migrated — the no-backup refusal now says so and
  names both remaining routes (the repo wrapper's backup, or reinstalling the
  DSH package).

## [0.10.0] - 2026-09-14

### Added

- **The install flow now tells you about the one manual step, everywhere it can.**
  A market install activates the input chip immediately, but the sidebar
  session-row badges additionally need the seam patch — and nothing said so.
  Now: the market-listing description names the step; the README leads with the
  two-command install order; a guarded `postinstall` applies the seam at
  install time **when pnpm allows it** (opt-in via `allowBuilds` — DSH's plugin
  installer prints that instruction whenever pnpm blocks a build) and only ever
  in the one safe state (pristine upstream, all anchors resolving — anything
  else just prints, and the hook can never fail an install); and when the seam
  is still absent ~5s after boot, every input chip gains a tooltip naming the
  command — the first message visible in the product rather than the console.
  Restart stays manual by design: an install script restarting the host that is
  installing it is not safe to automate.

## [0.9.1] - 2026-09-14

### Fixed

- **The shipped patcher is reachable with npx.** `peerDependencies` named
  `@deepseek-ai/dsh-client-runtime`, a DSH-internal package that is not on the
  npm registry, so every `npx` invocation of the patcher died resolving peers
  (pnpm inside a DSH profile only tolerated it because DSH itself provides the
  runtime). The peers are removed — DSH supplies the runtime through the
  `dsh.client.inject` declaration regardless — and the documented command is
  `npx dsh-git-badge <verb>`: npx runs a package's single bin under the
  package's own name. The boot hint and all docs now say that.

## [0.9.0] - 2026-09-14

### Added

- **The seam patcher ships in the package** as the `dsh-git-badge-seam` bin, so a
  market install can add the sidebar session-row badges without cloning the
  repository: `npx dsh-git-badge apply`, then restart. Pure Node (no
  python3), anchor-based like the repo tooling it replaces, with the same
  refusal semantics: it writes nothing unless every anchor resolves exactly
  once, upgrades its own older artifacts by marker revision, and reverts to the
  bytes as found before patching. When the seam is absent the plugin's boot log
  now says so and names the command.

### Added

- **A session's badge follows the worktree its work is in.** A conversation's
  directory is fixed when it is created, and DSH records no session→worktree link
  at all (`attachSession` requires the stored cwd to equal the workspace path), so
  a conversation started in the main checkout reported `main` — including "no pull
  request" — while its work and its PR lived in a linked worktree.
  Now, when a **session**-targeted badge resolves to a main checkout whose
  repository has exactly one linked worktree whose branch has an **open** pull
  request, the badge describes that worktree instead: its branch, dirty counts,
  ahead/behind, tree-shaped mark, and PR/CI token. The `workspace` id in the
  response is unchanged, so SSE attribution is unaffected.
  The selection is deliberately the only one that cannot be ambiguous — one open
  PR is a candidate, two are a reason to say nothing — the worktree is **named**
  on the chip even when the branch would make the name look redundant, the mark's
  accessible name states that the checkout was inferred, and the hover card gains
  a `checkout` row carrying the conversation's OWN directory (branch · files ·
  sync) so the main checkout's state stays visible. A workspace-targeted sidebar
  row never follows a worktree: a row surveys the checkout the registry owns.
- **An inferred worktree is watched.** Its working tree and git dir get the same
  event-driven treatment as a registered workspace's, and its events carry the
  **owning workspace id**, so the badge refreshes within ~1s of a stage, commit or
  checkout in the tree — including a worktree that is not itself a registered
  workspace, which the main checkout's recursive watch would never see.
- **Identical concurrent status reads are collapsed** into one `git status` per
  directory, which is the shape a burst of badges mounting together produces.
  `statusCacheMs` (default 0) optionally extends that to serial bursts; the 0
  default keeps a read taken after a mutation honest. New config: `worktreeStatus`
  (`"auto"` | `"off"`), `prListLimit`, `statusCacheMs`.
- The repository-wide open-PR read (`gh pr list`) happens at most once per TTL per
  repository, and never at all for a repository with no linked worktree.

### Changed

- **The sidebar session row is an ACTION token, not a status badge.** It shows
  the one thing that conversation needs — `merge`, `fix CI`, `review`, `resolve`,
  `pull`, `push` — and nothing when there is nothing to do. `merge` keys on
  GitHub's own `mergeStateStatus: CLEAN` rather than a verdict assembled here; a
  draft, blocked, behind, unstable or unknown PR stays silent, because waiting is
  not an action. This is deliberately a trade: the row no longer shows local
  status or the worktree's tree shape, and the hover line — which now names the
  pull request as well as the checkout — is where that detail lives. The word floats right so a column of actions lines
  up down the sidebar, sits heavier than the timestamp beside it, and is coloured
  by SEVERITY with the app's own state tokens — error for `resolve` and `fix CI`,
  warn for `review`, success for `merge`, quiet secondary for `pull` and `push` —
  so the loud rows keep meaning something. The chip is unchanged. Revert this
  commit to go back to the mark-plus-token row.
- **The sidebar badge moved from the workspace row to the session row.** A
  workspace row cannot know which worktree its conversations are using, so a
  per-workspace badge could only guess or report the main checkout. Each session
  row now carries the status mark plus the PR/CI token when the branch has one
  (`🌳 PR#391 ✓`), and never a branch — hovering the row adds a line naming the
  checkout that badge describes (`checkout: hotfix-tree on feat/x`, and for an
  inferred worktree, why it was followed). Rows still issue no request of their
  own beyond the badge's: the hover line resolves to the same cache key, so a card
  that mounts for every row cannot multiply git or forge work.
- The `seam/` patch now declares `sidebar.workspaces.sessionRow` and
  `sidebar.workspaces.sessionRow.detail` instead of the old
  `sidebar.workspaces.row` pair, and the row is rendered from the **tree** call
  site only, which keeps the flat and search lists badge-free with no guard of
  their own. `seam/apply.sh` recognises its own older artifacts by a marker
  comment (and the previous hash), so rebuilding the patch installs it instead of
  being skipped as "upstream landed" — and `revert` now restores the upstream
  baseline rather than an older patch.

### Fixed

- **A failing seam occupant could blank the whole sidebar.** The host guards each
  registered *entry* with an error boundary, but not the outlet a row renders
  itself, so a throw in an occupant's render path reached the workspace browser —
  and the shell abdicates that entry, removing the entire sidebar region about a
  second after boot. The seam patch now wraps both session-row renders in its own
  boundary: a broken occupant loses its badge and logs the error instead.
- **The PR cache served the wrong branch.** `prStatusFor` was keyed by toplevel
  only, so a checkout that changed branch inside the TTL window was served the
  previous branch's pull request. It is now keyed by toplevel **and** branch.

## [0.8.0] - 2026-09-12

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
- **The PR token links to the pull request.** When `gh` reports an http(s) URL the
  token is an anchor that opens the PR in a new tab, so this browser tab keeps the
  conversation. It underlines on hover or focus only — the at-rest signal is the
  pointer cursor — and keeps the chip's own colour instead of the browser's link
  blue, so it still reads as one row. Being an anchor, it is also keyboard-reachable
  now, which the text token was not. The protocol is checked on both halves: only
  `http:`/`https:` is carried or rendered, so a payload value can never become a
  `javascript:` href.
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

[Unreleased]: https://github.com/Kevin-McIsaac/dsh-workspace-git-badge/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/Kevin-McIsaac/dsh-workspace-git-badge/releases/tag/v0.8.0
[0.7.0]: https://github.com/Kevin-McIsaac/dsh-workspace-git-badge/releases/tag/v0.7.0
[0.6.0]: https://github.com/Kevin-McIsaac/dsh-workspace-git-badge/releases/tag/v0.6.0
