# Tier 2 plan — resolution trust model, watcher fallback, cleanups

Follows [`PLAN-tier1.md`](PLAN-tier1.md) (shipped as 0.6.0). The Tier 2/3 list in
that file's "Out of scope" section is the origin; this file narrows it to what
was approved.

## Decisions locked

| Question | Decision |
|---|---|
| Resolution | Session for the chip + `workspaceId` for the row; **drop `?path=`** |
| Watcher fallback | 5s server-side state-key poll, only where the watcher failed |
| Preview page | **Skipped** — `test-profile.sh PLUGIN_SOURCE` covers live iteration |
| Cleanups | `seam/apply.sh status` + `CHANGELOG.md` (in-repo only) |
| Release | Merge the PR only — no version bump, no release |

Consequence of the last row: `package.json` stays at `0.6.0` (already published),
so `main` carries unreleased changes. That is the normal dev state; the next
release decides its own version. `CHANGELOG.md` gets an `Unreleased` section.

## Item 1 — Workspace resolution (node + client)

**Goal: the node half never accepts a client-supplied filesystem path.**

Current surface is `GET /api/git-badge?path=<raw path>`, validated against the
registry allowlist plus `realpath`. It is read-only and allowlist-bounded, but
the path is attacker-chosen within that set, and the route answers **without GUI
authentication** (confirmed live: `/` was 401 while `/api/git-badge` answered).

New surface — the caller says *who it is*, not *where to look*:

| Caller | Query | Server resolution |
|---|---|---|
| Input chip | `?session=<sessionId>` | `ctx.sessions.get(id)?.header?.cwd` |
| Sidebar row | `?workspace=<workspaceId>` | registry entity by id → `record.path` |
| — | `?path=` | **removed** (rejected) |

- `inject` gains `"sessions"` (verified available: several DSH packages declare it).
- Stable error codes: `session-required` / `session-not-found` /
  `workspace-not-found`, alongside the existing `{git:false}` non-repo shape.
- `detail=1` is unchanged and stays unconsumed.

### Step 0 — confirmed (done)

Verified against the installed DSH types
(`dsh-workspace/lib/types/{types,entity}.d.ts`), not inferred:

- **`Workspace.id` is a generated uuid** — the doc comment is explicit: *"Identifies
  one workspace record. A generated uuid, never the path."* The API controller
  builds the client's `workspaceId` as `workspace.id`, so the seam's `workspaceId`
  **is** the registry entity id. `?workspace=` resolves with no fallback needed.
- **`Workspace.path` is public** (canonical `fs.realpath`, never rewritten).
  `record` is **private** — our current `entity?.record?.path ?? entity?.path`
  reaches into it. Switch to the public `entity.path` everywhere.
- **`sessionIds` is header-validated and durable** ("missing headers, invalid cwd
  values, and canonical cwd mismatches are never returned"). That makes the chip
  resolvable through the registry alone — no dependency on a *live* session
  object, so viewing an older conversation still resolves.
- `ctx.sessions.get(id)` exists (confirmed by `dsh-workspace`'s own
  `sessionKnown`), and the registry exposes public `resolveByPath(path)`.

Revised resolution order, better than the plan's original:

1. `?session=<id>` → scan the registry for the entity whose `sessionIds` includes
   it → `entity.path`. Registry-only, durable, works for non-live sessions.
2. else → live session cwd (`ctx.sessions.get(id)?.header?.cwd`) →
   `workspaceRegistry.resolveByPath(cwd)`. Covers the transient window where a
   brand-new session is not yet attached to its workspace; the path is still
   validated by the registry, so the trust model is unchanged.
3. else → 404 `session-not-found`.

`workspaceRegistry` is required; `sessions` is only needed for step 2, so the
plugin degrades gracefully if it is absent.

### Client

- Chip: request by `sessionId` directly. `useSessionWorkspaceCwd` disappears from
  the request path — the chip then needs no `workspaces` service lookup at all,
  and renders on `git: true` rather than on a resolved cwd.
- Row: request by the `workspaceId` the seam already hands it. Rows without a
  `workspaceId` (the ungrouped bucket) correctly render no badge.
- SSE: notifications keep carrying the filesystem `{path}` the watcher knows.
  Add the resolved workspace path (`root`) to the status response so the client
  can match events against it; until the first response arrives, treat any event
  as a reason to refetch. `samePath` stays — it still normalises trailing slashes.

### Tests (extend the existing harness)

- session resolution: known session → 200; unknown → 404 `session-not-found`;
  neither param → 400 `session-required`.
- workspace resolution: known id → 200; unknown id → 404 `workspace-not-found`;
  entity shaped `{id, record:{path}}`.
- **regression guard:** `?path=` is rejected — the old surface must not quietly
  survive.
- SSE payload shape unchanged.

## Item 2 — 5s state-key poll fallback (node)

Today a workspace whose watcher cannot be established falls back only to the
client's 60s poll. Give the server its own fallback.

- Trigger **only** when `.git` exists but the watcher failed — a `watch()` throw
  or a later `watcher.on("error")`. A workspace with no `.git` is not polled; the
  existing `watchRetryMs` backoff keeps re-checking it, and polling a non-repo
  would be pure waste.
- One `setInterval(config.pollFallbackMs)` **per failed workspace**, not per SSE
  subscriber. Cleared by `unwatchWorkspace` and by the plugin-unload disposer.
- State key per tick: `status --porcelain=v2 --branch` (default untracked mode —
  the `-uall` walk is the expensive one) + a `rev-parse --absolute-git-dir`
  marker check + a `for-each-ref refs/remotes` fingerprint. Push
  `notifyChange(key)` only when the key differs.
- Recovery is bidirectional: the watcher retry loop stays active, so a workspace
  that recovers stops polling; a workspace that later errors starts.
- **Known blind spot, to document:** with collapsed untracked mode, adding a file
  inside an *already untracked* directory does not change the key, so it is not
  noticed until the client's 60s poll refetches. Acceptable for a degraded path;
  do not paper over it with a 5s `-uall` walk.
- `config.pollFallbackMs` is injectable (same seam as `debounceMs` etc.) so tests
  run at ~150ms instead of waiting 5s.
- Tests: forced watcher failure → a repo mutation produces a notification within
  the interval; `unwatchWorkspace` clears the interval; a healthy watcher creates
  none; the unload disposer clears them.

## Item 3 — `seam/apply.sh status`

`apply.sh` currently prints `usage: apply.sh apply|revert`. Add `status`, which
reports:

- installed file **patched** (seam present) vs **pristine**,
- whether its sha256 matches the pinned `PRISTINE_HASH` (upstream = the baseline
  we patched against) or the generated patched artifact, or is **unknown** —
  i.e. upstream drifted and the patch needs `make-patch.sh` + `stamp-hash.sh`,
- whether **upstream now declares the seam itself**, in which case the patch is
  obsolete and `apply` correctly no-ops.

Exit codes: `0` for a recognised state, `1` for drift/unknown, so it is usable in
a script — this is the first command you want after a DSH update. Document in
`SEAM.md` (the section that currently documents apply/revert only).

## Item 4 — `CHANGELOG.md`

Keep-a-Changelog format, newest first: an `Unreleased` section for this work,
`0.6.0` written out in full, and a brief backfill for 0.5.x from the release
notes and `git log`. Add it to the package `files` list and link it from the
package README so npm consumers get it — without that it stays repo-only, since
`files` whitelists exactly six paths.

## Branch, commits, verification

Branch: `feat/tier2-resolution-and-watcher-fallback`. One commit per item, each
verified before the next:

1. resolution (node + client + tests, after Step 0 confirms the id space)
2. watcher poll fallback (+ tests)
3. `apply.sh status` (+ `SEAM.md`)
4. `CHANGELOG.md`

Verification, in order:

1. `cd dsh-git-badge && npm test` — green, including the new resolution and
   fallback tests.
2. `PROFILE=tier2 PORT=3124 PLUGIN_SOURCE=$PWD/dsh-git-badge ./test-profile.sh` —
   clean-profile boot, client bundle served, allowlist check. (Note: the
   allowlist check probes a path that is no longer part of the API; update the
   script's probe to the new error contract in the same commit.)
3. `seam/apply.sh status` exercised in both states.
4. One restart of `dsh web` (node half changed) + live probes: chip and sidebar
   rows both render, SSE still delivers, `?path=` is refused.
5. Docs touched: `docs/VERIFICATION.md` (its curl examples are path-based and
   would break), `TESTING.md` (new knob, fallback behaviour), `SEAM.md`,
   `README.md` if any user-visible behaviour shifts.

## Risks

| Risk | Mitigation |
|---|---|
| `entity.id` ≠ client `workspaceId` | Step 0 verifies first; documented fallbacks, no silent downgrade |
| Dropping `?path=` breaks ad-hoc curls | `docs/VERIFICATION.md` updated in the same commit |
| Ungrouped-bucket rows lose their badge | Correct — they have no workspace; called out in the docs |
| 5s polling on a failed watcher costs git calls | Failure-only, per workspace, non-`-uall`, injectable interval |
| Poll misses untracked-dir additions | Documented; 60s client poll is the backstop |

## Deltas as implemented

1. **`CHANGELOG.md` lives in `dsh-git-badge/`, not the repo root.** The plan said
   root *and* add it to package `files` — mutually exclusive, because npm's `files`
   cannot reach outside the package directory. Shipping it (the stated intent)
   forced the package directory. It is in `files` now, and the package README
   links it.
2. **`0.5.x` history is not reconstructed.** The plan said "brief backfill from the
   release notes and `git log`", but the history does not map onto published
   versions — `d294ea3` landed after the 0.5.5 bump commit yet shipped in 0.6.0.
   Guessing per-version entries would have manufactured a record, so the file says
   plainly that earlier versions predate it.
3. **The poll's first tick fires immediately.** The plan did not mention baseline
   timing. The first test draft wrote a file before the initial tick, so the change
   became part of the baseline and was never announced — a real behaviour bug, not
   just a test artifact. `startFallbackPoll` now baselines at once.
4. **A live-verification finding, fixed here:** the client's `surfaces:` console
   line reported `sidebar rows = off (seam absent)` while five row badges were
   visibly rendering. It sampled `slots.spec()` at `apply()` time, before the
   workspace browser declares the seam — a boot race printed as a verdict.
   `AGENTS.md` and `TESTING.md` both send debuggers to that line, so it was fixed
   rather than documented around.
5. **Four stale references the resolution change invalidated**, all corrected:
   `test-profile.sh`'s 403 probe, `TESTING.md`'s curl examples, `AGENTS.md` rules 1
   and 6 (the "allowlist" the suite covers, and the 403 contract that no longer
   exists), and the package README's "only answers registered workspace paths".

### Found during this work, and fixed on request

`seam/apply.sh revert` restored `backup-client.js` unconditionally. The backup is
the *previous* upstream build, so after a DSH update replaced `lib/client.js`,
`revert` would have **downgraded** the installed file. It now refuses unless the
installed file is this repo's patched artifact or already the backup — changing
nothing and exiting 1 — and `status` flags the condition in advance under
`revert: would REFUSE`. All four cases (patched / drifted / already-reverted / no
backup) are exercised against a fake install via `DSH_INSTALL`.

### Also fixed: the TTL fetch was on the request path

Found by a user report that a file edit took several seconds to show. The
TTL-bounded fetch that refreshes the remote-tracking ref was **awaited** before
responding, so the first request after every 60s window paid a full network fetch
(~3.3s measured here). It now runs out of band and notifies subscribers on
success: same call with an expired TTL went 3.47s → 27ms. `ahead`/`behind` can lag
by up to one fetch; branch, dirty state and counts never do. Regression test
added and proven to fail with the blocking version restored.

### Verification status

Item 1 was verified **live**, not just by tests: the node contract (`?session` →
404 `session-not-found`, `?path` → 400 `target-required`, `?workspace=<uuid>` →
200), the served client bundle (new markers present, old absent), and the rendered
UI — confirmed over CDP against the real GUI at 1680×1050, where 5 row separators
and 6 dots appeared across two different branches. An earlier 800×600 probe showed
no rows at all; that was a window-size artifact, not a breakage.

Items 2–4 are verified by suite (51/51, stable over four runs) and clean-profile
boot, but need a restart to be seen live.

## Out of scope

Static preview page (skipped by decision), hover card consuming `detail=1`, write
operations, `src/` → build script, and the two out-of-repo nits (web-profile
`minimumReleaseAgeExclude` chain, `forecast-dev` duplicated line). The upstream
sidebar-seam proposal (`PR.md`) remains the highest-leverage open item and is not
code.
