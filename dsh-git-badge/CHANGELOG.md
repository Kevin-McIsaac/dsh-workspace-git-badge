# Changelog

All notable changes to this package are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions before 0.6.0 predate this file; their history is in `git log` and on
npm. 0.6.0 is the first release recorded here.

## [Unreleased]

### Fixed

- **The documented patcher command finally runs.** Every prompt the product
  shows — the input-chip tooltip, the postinstall hint, the README — says
  `npx dsh-git-badge apply`, and every one of them failed with
  "could not determine executable to run": npm's npx auto-runs a bin only when
  the bin's name matches the package name, and the package shipped two bins
  (`dsh-git-badge-seam`, `dsh-git-badge-checkout`) that did not match. The
  0.9.1 note below claimed npx runs a package's single bin under its own name —
  wrong npm behavior, shipped untested; `npx dsh-git-badge-seam` fared no
  better (404 — no *package* carries that name; npx resolves package names,
  then looks up a bin inside them). The fix is the alias the prompts always
  assumed: bin `"dsh-git-badge": "seam/apply.js"`. The alias also multiplexes
  the checkout bin (`npx dsh-git-badge checkout <path|--clear>` dispatches to
  `seam/checkout.js`), because npx cannot reach a package's second bin by
  name at all — so the gh skill, the README and checkout's own usage text now
  name the working form everywhere the old `dsh-git-badge-checkout` spelling
  appeared. The legacy bins stay for direct invocation.

## [0.17.3] - 2026-09-17

### Fixed

- **The default branch is now detected when `refs/remotes/origin/HEAD` is
  missing.** `defaultBranchFor` read only that symref, so in a repo that has
  none — `git clone --branch <x>`, a pruned ref, or any repo that was only ever
  pushed to — it answered "no default branch" forever. Every default-branch rule
  was therefore silently inert: the 0.17.2 merge row on `main` still said
  `no pull request`, and the node half still suggested opening a pull request
  FROM the default branch. The lookup now falls back, network-free, to the base
  branch this module already probes (`origin/main`, then `origin/master`); a
  repo whose default is neither still answers `undefined`, exactly as before.

## [0.17.2] - 2026-09-17

### Fixed

- **The default branch's branch hover no longer says `no pull request`.** The
  always-render merge row (0.17.0) only ever made sense on a feature branch:
  `main` is the base pull requests merge INTO, and none is ever opened FROM it,
  so `no pull request` there read as a nag for something that cannot exist. When
  the node half flags the branch as the default one (`defaultBranch: true`, the
  same flag the action rules use to suppress "open a pull request" on `main`),
  the row now reads `base branch · pull requests merge into this`. Its
  base-relative counts are suppressed there too — `N ahead, M behind main` while
  ON `main` is self-referential, and that divergence is already the chip's own
  `↑a ↓b` token. Feature branches are unchanged: still `no pull request`, still
  the counts when they are known.

## [0.17.1] - 2026-09-17

### Fixed

- **The branch, file-count and PR hovers open on the FIRST hover.** Those three
  surfaces were only wrapped in the shell's `Tooltip` once the lazy `detail=1`
  payload arrived. That primitive is uncontrolled — it has no `open` prop and
  opens from a `mouseenter` it attaches to its child — so a wrapper mounted after
  the pointer had already arrived could never open for that visit: the first hover
  did nothing, and worked only after leaving and returning (or after hovering the
  status mark had already warmed the cache). All four surfaces are now wrapped
  from the first render, and a label whose detail is still in flight degrades to
  the base response instead of claiming an empty list — the count restates the
  file breakdown, the PR token names the PR. The branch's hover child also stays a
  `span`, so the compare link appearing underneath a resting pointer cannot
  remount it. The status mark's own card was never affected.

### Changed

- **Internal simplification pass, no user-facing change** (#52): one
  `singleFlight` now backs the status cache and its in-flight coalescing, one
  patch engine (`seam/patch.js`) backs both `seam/apply.js` and
  `seam/postinstall.js`, and the server returns one `nextActions` shape
  (`{actions, next}`) for the row's action list.

## [0.17.0] - 2026-09-16

### Added

- **The PR token has its own hover: the commits in that pull request.** `PR#47 ✓`
  now shows the commits on the branch that are not on the base
  (`git log <base>..HEAD`, capped at 10 with "… and k more"), in the same line
  format as the branch hover's list — hash, subject, compressed age, full-width
  with ellipsis. Nothing else rides it: the token already states the number and
  CI state, so the one question left is what is in it. Hover-gated with the rest
  of `detail=1`, and the total reuses the ahead count already computed.
- **`/gh clean [<path>...]` appears in the `/gh` menu behind a risk gate.** The
  menu is built from status, not from this skill's prose, so the verb is offered
  there whenever untracked files exist — always last, never as the badge's
  suggested action, and carrying the host's own `RiskConfirmation`: Confirm
  stays disabled until "I understand untracked files cannot be recovered" is
  ticked. That gate names the risk; the agent then names the files
  (`git clean -n`, quoted back) and asks again before `git clean -f`.
- **A `/gh clean [<path>...]` verb, confirm-first by construction.** Removing
  untracked files is the one operation with no reflog and no stash entry, so the
  verb's first step is always `git clean -n -- <paths>` with the output quoted
  back verbatim (the user approves the list, not the idea), then an explicit yes,
  then `git clean -f -- <paths>` on named paths only. `-x`, `-d` and bare
  `git clean -f` are forbidden — ignored files are often credentials and `-d`
  turns one path into a tree. It stays out of the badge's ranked suggestions: a
  destructive action the agent cannot infer intent for is never suggested, only
  available on request.

### Changed

- **The session row's action token only appears when the session is idle.** A turn
  in flight is exactly when a git suggestion is noise: the checkout is still
  moving and the agent has not finished. The row reads its run state from the
  shell's standard kit — `useSessions`, the same selector hook the workspace UI
  itself uses — and renders nothing while that session is `running`. The filter is
  on render, not on the fetch, so the row's hover line is unaffected. On a shell
  that seeds no such hook the row behaves as before, and the console says which of
  the two it got.
- **The PR/CI token stops lagging behind the forge.** The forge read is
  TTL-bounded and its refresh is request-driven, while an idle chip only asks
  every 60s — so the old 90s `prTtlMs` silently suppressed every other poll, and
  a pull request that appeared on GitHub with no local git event to announce it
  could take ~2.5 minutes to show up. At 20s the TTL no longer outlives the
  client's poll, so the first refresh after the forge changes picks it up and the
  worst case falls to roughly the poll interval. Cost: up to one `gh pr view` per
  open chip per minute, where it was one per ~2 minutes.
- **The branch hover shows only the merge axis.** `upstream` and `sync` are gone
  — they stated the same divergence against the branch's own remote, in arrows,
  when `merge` already states it against the base branch in words. The `merge`
  row now ALWAYS renders: `ready to merge`, `blocked: draft | review required |
  checks failing`, `no pull request`, each joined with `N ahead, M behind main`
  when those counts are known. A row that can be absent is a row the reader has
  to reconstruct.
- The commit cells lost their trailing colon (a later change had reintroduced it
  after the earlier removal), so both hovers read `abc1234  subject · 2h ago`.
- **One action list, built by the server.** Both halves used to derive the
  pull/push/commit/pr conditions, and the copies drifted: the card once promoted
  a client-only extra into its action row, and `/gh pr` was offered on the
  default branch. The node half now publishes `actions` — the ranked rules in the
  configured order with the top entry flagged `primary` (also served as `next`,
  on every response), then the standing options (`pr view <n>`, `pr`, and the
  flagged `clean`). `merge <n>` becomes a standing entry whenever the PR is
  mergeable, so it now appears alongside a primary `push`/`pull` instead of only
  when it wins the ranking. The client renders the list verbatim and keeps only
  presentation — labels and the clean risk gate; `actions` rides the `pr=1`
  payload only, so sidebar rows stay lean. Net: ~65 lines of duplicated client
  rules deleted, and the conditions are unit-tested where the data lives.
- **The upstream sync numbers ride the branch's hover and link.** `↑a ↓b` were
  rendered inside the file count's names tooltip and outside the branch's compare
  link, though they are the branch's standing against its upstream — so they now
  sit with the branch name: same lineage hover, same compare-view link, and the
  link's accessible name says "N ahead and M behind upstream". `✎n` keeps its own
  names tooltip. Visible side effect: the arrows render before a paused-operation
  token rather than after it.

### Fixed

- **The PR token's hover lines its commits up like the branch hover.** Both lists
  now come from one renderer: a fixed-width monospace hash cell, so every
  description starts on the same column and the list reads as a table. The PR
  list had reused the card's label style, whose `minWidth` and `flex` only apply
  inside a flex row — on a plain inline span they did nothing, so the hash sat
  flush against its description with the columns ragged.
- **The PR token's hover is reachable by hovering the token itself.** The commits
  it lists are detail-only, and only the status mark and the branch name enabled
  the `detail=1` fetch — so a pointer that went straight to `PR#47 ✓` had rested
  on nothing that fetches, and its hover could not open until the mark had been
  hovered first. The token is now its own detail gate, in both its linked and
  plain forms.
- **No more "open a pull request" on `main`, and the hover card shows only the
  server's verdict.** Two layers disagreed: the node half correctly returned
  nothing to do for a clean, synced default branch, while the client's extras
  still offered `/gh pr` — and the card promoted that extra into its `action:`
  row, so a checkout with nothing to do displayed a suggestion. The node half now
  resolves the repository's default branch (`refs/remotes/origin/HEAD`,
  TTL-cached and refreshed out of band like the fetch, so the hot path pays
  nothing) and flags it on the response; the `pr` extra is suppressed when the
  branch IS that default; and the card's action row reads the server's `next`
  directly, leaving the extras to the `/gh` picker where they belong.
- **The seam suite no longer writes into your real `~/.dsh/git-badge-seam`.**
  One block spawned the postinstall hook without `SEAM_DATA_DIR`, so the hook
  resolved its store to the machine's actual data directory: a test run
  overwrote the real `backup-client.js`/`backup-index.js` and left a
  `restart-pending.json` behind. It passed on CI only because the runner's
  `$HOME` is writable — under a read-only `$HOME` it failed with EROFS. The
  block now takes a throwaway data dir like the rest of the file.

## [0.16.1] - 2026-09-16

### Fixed

- **Typos in the repository README.** Corrected `.e.,` to `e.g.,`, `can't be
  change` to `can't be changed`, and removed a stray blank line before the
  `## Worktrees` heading.

## [0.16.0] - 2026-09-16

### Added

- **A session now tells the badge which checkout it is working in.** dsh cannot
  supply that fact — a session's `cwd` is immutable creation metadata and always
  the main checkout — so the agent registers it explicitly:
  `npx dsh-git-badge-checkout <path>` (shipped bin), run by the `git-worktree`
  skill after `git worktree add` and by `/gh checkout` when a switch lands in or
  out of a linked worktree. The node half prefers the registration, and
  validates it: git's own worktree list must know the path, the entry expires
  after 24h, and the name/branch come from git, never from the file. The
  registration is self-clearing — removing it (or letting it expire) retires the
  extra watcher and the badge returns to the session's own directory.

- **A settings card for the ranking order: Settings → Plugins → Git Badge.**
  The order now lives in this plugin's own `git-badge` settings namespace —
  declared with a schema, validated and stored by the host, observed live — and
  the card reorders the seven categories with up/down controls, Save/Discard,
  and Reset to default. No file polling, no restart: a change applies to the
  next status read. A pre-existing `~/.dsh/git-badge-next.json` seeds the
  namespace as its base (and remains the fallback on hosts without the settings
  stack), so an order configured before the card existed survives the upgrade.
  `/gh order` still works for agent-driven changes.

### Changed

- **The ranking card sits in an expander, like the host's other plugin cards.**
  Collapsed by default with the title and a one-line description; the list,
  reorder controls, and Save/Discard/Reset live in the body, which auto-collapses
  once a save settles clean. The card chrome reproduces the host's plugin-card
  values inline (its CSS module is not exported to plugins), so it reads as one
  of the set rather than loose content between it.

- **PR inference is gone.** The badge no longer guesses a worktree from the
  branch with an open pull request. The guess was invisible to the session that
  made it and silently wrong whenever two trees were in play; a `worktreeInferred`
  marker, the repository-wide `gh pr list` read that powered it, and the
  inference wording in the hover all go with it. A session follows its
  registration or stays on its own checkout — nothing else.

## [0.15.0] - 2026-09-15

### Changed

- **Internal polish, no behaviour change:** the `detail=1` hover reads run in
  one parallel batch (hover latency is the longest call, not the sum of seven
  serial git spawns), the path-shortening and remote-URL conversion moved into
  named helpers, and the three hover bodies share one row builder.

### Added

- **Merge-blocker phrasing in the branch hover.** A `BLOCKED` verdict says why
  — `blocked: review required`, `blocked: checks failing`, `blocked: draft` —
  combined with the ahead/behind-main counts when both apply, so a dead-end
  word names the next action. CLEAN stays silent: the action row already
  offers `/gh merge`.

- **Staged names in the count's hover.** The stacked column gains a `staged:`
  section above `unstaged` and `untracked`, completing the ✎n story — and
  pairing with `/gh commit` when work is already staged.

- **Two new `gh` verbs:** `/gh stash pop` (shows the top stash's subject,
  confirms, and on conflict reports that the stash was NOT dropped) and
  `/gh checkout <branch>` (states what is dirty and confirms when work would
  carry over).

### Added

- **Unstaged names join the count's hover.** The ✎n tooltip stacks one column
  with two sub-headers — `unstaged` (tracked, edited files; valid regardless of
  the collapsed-untracked retry) above `untracked` — each capped at 20 with the
  same last-two-segments shortening and "… and k more" arithmetic. The picker
  question "what are these?" now answers for both halves of the count.

- **The branch hover gains a merge-state row.** `main: N ahead, M behind`
  against `origin/main` — in words, deliberately distinct from the upstream
  sync arrows: "3 ahead, 0 behind" reads as "this is the PR's content";
  "0 ahead, 5 behind" as "stale, rebase first". Absent entirely when in sync.

- **The branch hover's commit list is signed and base-relative.** One mixed
  list from `main...HEAD`: entries marked `+` are only on this branch (the
  PR's content), `\u2212` only on main (what a rebase/merge brings in) — git's
  own left-right verdict mapped onto the diff convention, sign before the
  hash. Capped at 10 with the total from the same base; without a default
  branch it degrades to the plain last 10, unsigned.

- **A commits hover on the branch name.** Hovering the branch lists the
  COMMITS THIS BRANCH ADDS (`log <upstream>..HEAD`) — hash + subject + age,
  capped at 10 with the total from one `rev-list --count` so "… and k more" is
  arithmetic — not the card's last-three-overall list. Hover-gated with the
  rest of `detail=1`; absent when the branch adds nothing (no tooltip rather
  than an empty one) and when there is no upstream (the publish suggestion
  covers that case).

### Changed

- **The hover surfaces have one information architecture.** The branch name's
  hover is the branch's LINEAGE and always renders: `upstream`, `sync` (in
  words, "in sync with upstream" when clean), the commits this branch adds,
  and the pull request when one exists. The status card loses its branch,
  upstream, sync and pull-request rows — the branch name is the chip's own
  text, and lineage facts belong beside the lineage surface — keeping action,
  files, operation, worktree, checkout and stash.

- **The status card no longer repeats what the other hovers own.** Its commits
  row and untracked-names row are gone — commit listings live on the branch
  name's hover, untracked names on the count's hover, and the server stopped
  fetching the unused last-three-commits on every detail read. The card keeps
  action, branch, upstream, sync, files, operation, PR, worktree, checkout,
  stash.

### Added

- **A names-only hover on the ✎n count.** The count gets its own tooltip —
  just the untracked list (one name per line, "… and k more"), no action row —
  while the full card stays on the status mark. It shares the mark's lazy
  detail fetch (resting on either triggers it once) and degrades to a plain
  count without the Tooltip primitive or when nothing is untracked.

### Added

- **Untracked file names in the hover card.** The `✎n` count becomes
  answerable — "what did I create here?" — with a `untracked:` row listing the
  names, hover-gated with the rest of `detail=1` (computed when the card opens,
  refreshed by the existing SSE invalidation; no per-edit cost). Posture: the
  plugin's never-display-a-path rule is relaxed by an inch, not a mile —
  RELATIVE names only, truncated to the last two path segments, capped at 20
  with the total carried separately so "… and k more" is arithmetic, not a
  guess. Collapsed-count payloads (huge untracked trees) omit the field
  entirely rather than under-report with directory names.

### Changed

- **A smarter next-action state machine.** `nextStep` now ranks rule
  candidates by category instead of first-match, and two new rules join the
  table: a **diverged** branch (ahead AND behind) suggests `/gh sync` —
  rebase-then-push, with the force-push confirmed by you — instead of a plain
  pull that would discard the local-commit context; and a **merge-ready** PR
  (GitHub's own `mergeState: CLEAN`, or checks passing + review approved)
  suggests `/gh merge <n>` — the endgame action the old table could never see.
- **Configurable ranking via `/gh order`.** The category order is one line of
  JSON at `~/.dsh/git-badge-next.json`
  (`{"order": ["operation","unmerged","sync","publish","merge","commit","checks"]}`);
  any subset in any order, unlisted categories rank after in default order.
  The `gh` skill gains the `sync`, `merge <n>` and `order` verbs — say
  "/gh order commit first" and the agent edits the file. The server's ranked
  `next` now carries the skill `args` directly, so the hover card and the (+)
  picker lead with exactly what the server decided and only add secondary
  actions around it.

## [0.14.1] - 2026-09-15

### Changed

- **Skill alignment:** the `gh` skill gains an explicit handoff — one verb per
  invocation is its whole job; the multi-step PR lifecycle (review, merge,
  verify, cleanup) belongs to the `gh-pr` skill. The `gh-pr` skill states the
  mirror scope: one-shot verbs are `gh`'s, lifecycle is its own. The catalog
  stays global-only; repo conventions stay in `AGENTS.md`.
- **The hover card is 33% wider** (360px → 480px) and its `action:` row now
  carries a trailing what-comment in git-comment convention — e.g.
  `action: /gh push  # push local commits to the remote` — so the row says
  what the invocation does, not just which invocation it is. The picker in the
  (+) menu shares the same descriptions.
- **The chip's hover card top line is now an `action:` row** — the gh skill
  invocation the checkout justifies (e.g. `/gh push`), in the card's ordinary
  label/value layout, replacing the next-step line's why-plus-copy-chip. The
  actionable surface remains the (+) menu's `/gh` picker; the card row is its
  read-only pointer.
- **The branch pull-down is removed from the chip.** The (+) menu's `/gh`
  picker supersedes it as the actionable surface, and the chip returns to
  mark + branch + PR token + notice.

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

[Unreleased]: https://github.com/Kevin-McIsaac/dsh-workspace-git-badge/compare/v0.17.3...HEAD
[0.17.3]: https://github.com/Kevin-McIsaac/dsh-workspace-git-badge/releases/tag/v0.17.3
[0.17.2]: https://github.com/Kevin-McIsaac/dsh-workspace-git-badge/releases/tag/v0.17.2
[0.17.1]: https://github.com/Kevin-McIsaac/dsh-workspace-git-badge/releases/tag/v0.17.1
[0.17.0]: https://github.com/Kevin-McIsaac/dsh-workspace-git-badge/releases/tag/v0.17.0
[0.16.1]: https://github.com/Kevin-McIsaac/dsh-workspace-git-badge/releases/tag/v0.16.1
[0.16.0]: https://github.com/Kevin-McIsaac/dsh-workspace-git-badge/releases/tag/v0.16.0
[0.15.0]: https://github.com/Kevin-McIsaac/dsh-workspace-git-badge/releases/tag/v0.15.0
[0.14.1]: https://github.com/Kevin-McIsaac/dsh-workspace-git-badge/releases/tag/v0.14.1
[0.14.0]: https://github.com/Kevin-McIsaac/dsh-workspace-git-badge/releases/tag/v0.14.0
[0.13.0]: https://github.com/Kevin-McIsaac/dsh-workspace-git-badge/releases/tag/v0.13.0
[0.12.0]: https://github.com/Kevin-McIsaac/dsh-workspace-git-badge/releases/tag/v0.12.0
[0.11.0]: https://github.com/Kevin-McIsaac/dsh-workspace-git-badge/releases/tag/v0.11.0
[0.10.1]: https://github.com/Kevin-McIsaac/dsh-workspace-git-badge/releases/tag/v0.10.1
[0.10.0]: https://github.com/Kevin-McIsaac/dsh-workspace-git-badge/releases/tag/v0.10.0
[0.9.1]: https://github.com/Kevin-McIsaac/dsh-workspace-git-badge/releases/tag/v0.9.1
[0.9.0]: https://github.com/Kevin-McIsaac/dsh-workspace-git-badge/releases/tag/v0.9.0
[0.8.0]: https://github.com/Kevin-McIsaac/dsh-workspace-git-badge/releases/tag/v0.8.0
[0.7.0]: https://github.com/Kevin-McIsaac/dsh-workspace-git-badge/releases/tag/v0.7.0
[0.6.0]: https://github.com/Kevin-McIsaac/dsh-workspace-git-badge/releases/tag/v0.6.0
