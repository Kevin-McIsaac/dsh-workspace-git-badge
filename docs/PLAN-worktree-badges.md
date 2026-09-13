# PLAN — worktree-aware badges (phase 1: input chip, phase 2: session row)

**Status:** both phases implemented on `feat/worktree-aware-chip` — phase 1 as
PR [#18](https://github.com/Kevin-McIsaac/dsh-workspace-git-badge/pull/18)
(node half, chip, tests, live proof), phase 2 in the same branch (session-row
seam, plugin surface, tests, docs). See `../dsh-git-badge/CHANGELOG.md` for what
actually shipped.

Approved 2026-09-13. Decisions taken with the maintainer are recorded inline as
**(decision)** so the reasoning survives the implementation.

## The problem

A DSH session's directory is fixed at creation and DSH has **no session→worktree
link**: `attachSession` refuses a session whose canonical cwd differs from the
workspace path (`dsh-workspace/lib/index.js:111-129`), session cwd is immutable
creation metadata, and there is no worktree concept anywhere in DSH. So a
conversation started in the main checkout that does its work in a linked worktree
gets a badge about `main` — including "no PR" while the worktree's branch has one.

Verified on the real case: workspace `f9bd67b0…` is
`/home/kmcisaac/Projects/the_paragliding_app` (clean `main`, no PR), while
`.claude/worktrees/global-skills-tiering` is on `chore/global-skills-tiering`
with open PR #391.

## The rule **(decision: PR-candidate only)**

A session-targeted badge follows a linked worktree when:

1. the resolved checkout is the **main** checkout of a repo with ≥1 linked
   worktree, and
2. **exactly one** linked worktree — excluding the checkout itself, detached,
   bare and prunable entries — has a branch with an **open** PR.

Otherwise the badge reports the session's own directory. An ambiguous repo stays
on its own checkout rather than guessing; the exactly-one rule and "open PR only"
are the stale-worktree guard. Deterministic, no mtime heuristics; recency can be
added later behind the same selection seam if the unpushed-worktree case bites.

## Semantics **(decision: the whole chip follows the worktree)**

Selection happens at **resolution**, not in the PR region: the effective status
directory for a session-targeted request becomes the worktree's path, and the
existing pipeline does the rest — branch, dirty counts, ahead/behind,
`isWorktree`, `worktreeName` and the PR all describe the tree. The response keeps
echoing the **workspace** id (`workspace`), because the client matches SSE events
against it; the swap is invisible to that matching.

The build **names** the worktree it used, so the user can always tell:

- `worktreeInferred: true` in the payload when the checkout was chosen by
  inference rather than being the session's own directory;
- the chip shows the worktree name even when it repeats the branch (the existing
  redundancy rule would otherwise hide it in exactly the stutter case:
  `global-skills-tiering` vs `chore/global-skills-tiering`);
- the mark's accessible name says the checkout was inferred from an open PR.

**Consequence, accepted with a mitigation:** with the project-row badge removed
in phase 2, `main`'s own state is no longer displayed anywhere. The chip's hover
card therefore gains a `checkout` row — the session's own directory (branch ·
dirty · ↑↓) — computed only under `detail=1`, i.e. **hover-gated**, so nothing at
rest pays for it.

## Shared design (phase 1 builds all of it; phase 2 is presentation-only)

| Piece | Where | Phase 2 reuses |
|---|---|---|
| `parseWorktreeList` / `listWorktrees` | node, pure + `runGit` | yes |
| `readOpenPrs` (one `gh pr list` per repo, TTL + in-flight + notify) | node | yes |
| `selectSessionWorktree` | node, pure | yes |
| `effectiveTarget` (the swap, session targets only) | node | yes |
| inferred-worktree **watchers** (SSE carries the owning workspace id) | node | yes |
| single-flight status coalescing | node | **essential** for N rows |
| `StatusMark`, `formatWorktreeToken`, hover card | client | yes |

Landing the whole node half in phase 1 is what keeps phase 2 to `client.js` plus
the seam patch — a browser refresh, not a node restart.

## Phase 1 — input chip (`feat/worktree-aware-chip`)

### Node half (`dsh-git-badge/lib/index.js`)

1. `parseWorktreeList(stdout)` — pure parser for `git worktree list --porcelain`
   (blocks of `worktree`/`HEAD`/`branch`/`detached`/`bare`/`locked`/`prunable`),
   adding `name` (basename). Exported for the suite like `parseStatusV2`.
2. `listWorktrees(toplevel)` — through `runGit`; any failure → `[]`.
3. `readOpenPrs(toplevel)` — `originIsGitHub` gate, then ONE
   `gh pr list --state open --limit <prListLimit> --json
   number,headRefName,state,isDraft,reviewDecision,statusCheckRollup,url`
   reduced to `Map<branch, pr>` via the existing `summarizePr`. Own TTL cache +
   in-flight + notify-on-change mirroring `prStatusFor`; every failure → empty
   map (the degradation contract: a missing field, never an error).
4. `selectSessionWorktree(worktrees, openPrs, checkoutPath)` — the rule above.
5. `effectiveTarget(target, bySession, notify)` — the one place the swap happens.
   A repo with ≤1 worktree returns before any forge call, so the common case
   costs nothing.
6. **Watchers.** An inferred worktree may not be a registered workspace, so the
   registry-driven watcher set would leave it unprotected — and freshness would
   silently depend on the main checkout's recursive watch happening to cover it
   (true for `.claude/worktrees` inside the repo, false for a sibling worktree).
   So: `watchWorkspace(worktreePath, worktreePath, owningWorkspaceId)` —
   `notifyChange` looks the workspace id up by watcher key, so events from the
   inferred tree carry the id the chip matched on — reconciled on every session
   request, pruned when selection clears, and kept alive by `syncWatchers`.
7. **Cache-key fix.** `prState` is keyed by toplevel only today, so a checkout
   inside the TTL window serves the previous branch's PR. Key it
   `${toplevel}\0${branch}`.
8. **Status coalescing.** Single-flight per `${dir}\0${detail}\0${pr}` so N
   session rows mounting together run one `git status`. `statusCacheMs` (default
   0) additionally coalesces serial bursts; 0 keeps tests and single-caller reads
   honest, which is why the default is not a window.
9. Route: compute `bySession` from the query, swap via `effectiveTarget`, annotate
   `worktreeInferred`, and under `detail=1` attach the `checkout` summary. The
   `?workspace=` path is never swapped — a project row surveys its own checkout.
10. `gitStatus`'s own signature is unchanged; the swap happens before it.

### Client half (`dsh-git-badge/lib/client.js`)

11. `formatWorktreeToken` — name shown unconditionally when
    `worktreeInferred === true`.
12. `StatusMark` aria-label — states the inference.
13. `HoverCard` — `checkout` row (branch · clean/✎n · ↑a ↓b) when inference is in
    effect. PR token formatting is unchanged: under this design the token is the
    worktree branch's own PR, read in the worktree.

### Tests

- `test/worktree-select.test.mjs` (new): parser; selection (one/two/none,
  detached/current excluded, branch without a PR excluded); `readOpenPrs` parsing
  and failure shapes; TTL + in-flight caching; session swap vs workspace no-swap;
  `worktreeStatus: "off"`; no forge call when a repo has no linked worktrees;
  `prState` branch-keying; single-flight coalescing; watcher union + event
  attribution + prune.
- Additions: `routes.test.mjs` (inferred payload, `checkout` under `detail=1`),
  `watcher.test.mjs` (inferred worktree freshness), `client.test.mjs` /
  `hover-card.test.mjs` (name shown when inferred, aria, `checkout` row),
  `test-support/repo.mjs` (second worktree + fixtures).

### Proof gate (all four before phase 2)

1. `cd dsh-git-badge && npm test` green, with at least one guard shown to fail
   without the fix.
2. Dev profile from the working tree:
   `PLUGIN_SOURCE=<worktree>/dsh-git-badge PROFILE=test PORT=3100 ./test-profile.sh`
   - `?session=<paragliding session>&pr=1` → worktree branch, `isWorktree: true`,
     `worktreeName: global-skills-tiering`, `worktreeInferred: true`, PR 391;
   - control `?workspace=f9bd67b0…&pr=1` → `main`, no `pr`;
   - degradation (no `gh`) → HTTP 200, no `pr`;
   - freshness: a commit in the worktree pushes an SSE frame carrying the owning
     workspace id.
3. GUI on `:3100`: the chip shows the worktree branch with the tree mark and
   `PR#391`; hovering shows the `checkout` row; sidebar rows unchanged.
4. A sidebar-only load spawns no `gh` process.

## Phase 2 — sidebar session row (`feat/session-row-badge`)

Presentation only; the node half is unchanged.

1. Seam: a third additive child on the existing `sidebar.workspaces`
   registration — `sidebar.workspaces.sessionRow` (list, root) — rendered inside
   `SessionNodeItem` with a `null` fallback; `renderSlot` + `workspaceId`
   threaded from `SessionTree`. Because `workspaceId` is passed only from the tree
   call site, the flat and search lists are untouched automatically.
2. `seam/apply.sh`: the current "seam string present → skip" guard treats an
   *extended* patch as "upstream landed" and would never install it. Install when
   the installed hash is the pinned pristine hash or the previous patched hash;
   refuse on drift; upstream-landed only when the seam is present and the file is
   not one of our artifacts.
3. Plugin: register `SessionGitBadge` on the new seam targeting
   `{ kind: "session", id }` with `pr: true` — the same hook, route and
   formatting as phase 1. **Stop** registering on `sidebar.workspaces.row`
   **(decision: remove the project-row badge entirely)**.
4. Row content **(decision: mark + PR token, provenance in hover)**: the status
   mark plus `PR#391 ✓`; worktree/branch facts go in the row's existing hover
   card. No nested `Tooltip` — the row is already a `HoverCard` anchor, so the
   badge contributes through `sidebar.workspaces.sessionRow.detail`, mirroring
   the `.row.detail` pattern already in the patch.
5. Cost: N rows → N requests, collapsed by phase 1's single-flight to ~one
   `git status` per workspace, with PR answers from the per-toplevel TTL caches.
6. Proof: seam status → **restart** → `:3100`: session rows badged (the
   paragliding session shows PR 391), project rows empty, flat/search unaffected.
   Rollback: `seam/apply.sh revert` (downgrade-guarded).

## Rules this follows

No client-supplied paths (AGENTS.md rule 7); degradation is a missing field,
never an error; every CLI call behind `config.gitRunner` / `config.prRunner` so
the suite needs no `gh`; additive list slots with fallbacks so a pristine install
renders byte-identically; feature work on a branch, no merge without approval
(rule 6); explicit paths staged (rule 5).
