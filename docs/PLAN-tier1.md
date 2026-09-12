# Tier 1 plan — accurate counts, operation state, node tests, retire OTP publishing

Source: prior-art study of [`Wongzexu/dsh-git-status`](https://github.com/Wongzexu/dsh-git-status)
(cloned locally at `.reference/dsh-git-status/`, gitignored). Background and the
full comparison live in the session; this file is the executable plan.

## Decisions locked

| Question | Decision |
|---|---|
| Untracked undercount | Always `-uall`; on timeout retry collapsed and report which mode was used |
| In-progress operations | Suffix token only — the documented three-state dot contract is unchanged |
| Test coverage | Full node-half port: parser, `gitStatus`, route allowlist, SSE, watcher debounce |
| Dead `detail=1` branch | Annotate now, wire to a surface in a later tier |
| Publishing | Add trusted-publishing workflow, document npm-side setup, bump to 0.6.0; you trigger the release |

## Two defects this fixes

1. **`✎n` under-counts new files.** We sample with the default untracked mode, so
   git collapses a new directory into one `? newdir/` line: a folder of 3 files
   renders `✎1`. Reproduced against a scratch repo.
2. **`?detail=1` is unreachable.** `lib/index.js:202-217` computes
   `lastCommits` + `stashCount`; `useGitStatus(cwd)` takes one parameter
   (`client.js:72`), both call sites pass a second argument that is silently
   dropped (`:175`, `:223`), and the fetch URL never appends `&detail=1` (`:91`).
   The `log -1` doc comment is also stale — the code runs `log -3`.

## 1. Test harness + suite (new; no runtime effect)

```
dsh-git-badge/test/
  helpers/harness.mjs   fakeCtx (effect / workspaceRegistry / captured webServer.register),
                        fakeStream (writeHead / write / end / on / emit, idempotent end),
                        parseFrames, waitFor(deadline poll)
  helpers/repo.mjs      makeRepo(t): mkdtemp + `git init -b main` + user/gpgsign config;
                        commit / branch / checkout / write / rm / stash / head /
                        currentBranch / raw git; t.after cleanup; nested-untracked and
                        file:// remote builders
  status-parse.test.mjs parseStatusV2 table: clean, staged-only, unstaged-only, partially
                        staged (MM counted on both sides), `u` unmerged, untracked,
                        collapsed `dir/` line, renames (`2 ` records), detached HEAD,
                        no upstream, `+ahead -behind` incl. `+0 -0`
  status-git.test.mjs   gitStatus against real repos: clean, dirty counts, nested untracked
                        dir → exact count, forced timeout → collapsed fallback, non-repo →
                        {git:false}, subdirectory → toplevel, detached label, detail=1
                        → lastCommits(3) + stashCount
  routes.test.mjs       apply(fakeCtx) then exercise handlers: missing path → 400,
                        unregistered → 403 (documented body), registered → 200,
                        realpath alias accepted, detail=1 honoured
  events.test.mjs       SSE: connect headers + flush, repo mutation → change frame {path},
                        close → listener + heartbeat removed, plugin disposer ends streams
  watcher.test.mjs      debounce collapses a burst to one notify, unwatch closes + clears
                        timer, missing .git → backoff record, pick up .git when it appears
```

- `dsh-git-badge/package.json`: add `"scripts": { "test": "node --test test/" }`.
  The `files` whitelist already excludes `test/`, so nothing new ships.
- **Test-only hooks in `lib/index.js`** (no behavior change): replace the scattered
  constants with one exported mutable `config` object — `debounceMs` 200,
  `watchRetryMs` 60000, `heartbeatMs` 25000, `statusTimeoutMs` 3000, `fetchTtlMs`
  60000 — plus an additive test-only export block (`config`, `parseStatusV2`,
  `runGit`, `gitStatus`, `watchWorkspace`, `unwatchWorkspace`, `watchers`,
  `changeListeners`). Named exports are additive; cordis loading is unaffected.
- **Determinism notes.** `fs.watch` delivery + the 200 ms debounce means tests poll
  with a deadline (≤3 s), never fixed sleeps. Every test must `unwatchWorkspace` in
  `t.after` or the open watcher/timer hangs the `node:test` run.
- **Attribution.** Harness files carry a header crediting
  `@wongzexu/dsh-git-status` (MIT) as the pattern source.

## 2. Untracked count fix (node half, user-visible)

- Sample with `git --no-optional-locks status --porcelain=v2 --branch --untracked-files=all`.
- On timeout (`config.statusTimeoutMs`) retry once with `-untracked-files=normal`
  and serve collapsed counts; degrade only if that also fails.
- Response gains `untrackedMode: "all" | "collapsed"` so the surface (and tests)
  can tell which number it got — cheap, and it prevents silently lying again.
- Rationale: `-uall` walks untracked trees, so the fallback stops a pathological
  tree (a huge unignored directory) from degrading the whole badge.

## 3. Operation-in-progress token (node + client, user-visible)

- **No extra git call:** widen the existing probe to
  `git rev-parse --show-toplevel --absolute-git-dir`, then `existsSync` the eight
  markers in the git dir — `MERGE_HEAD`, `SQUASH_MSG`, `CHERRY_PICK_HEAD`,
  `REVERT_HEAD`, `BISECT_LOG`, `rebase-merge`, `rebase-apply`, `sequencer`.
- Response gains `operation: "merge" | "squash" | "cherry-pick" | "revert" |
  "bisect" | "rebase" | "sequencer" | null`.
- Chip suffix places the token right after the branch, before sync/dirty:
  `🟡 main ⚔rebase ↑0 ↓2 ✎3`. Chip-only — the sidebar row badge keeps dot + branch.
- The dot contract is untouched, so the README table and the beginner-facing
  explainer stay true.
- Docs: README gains a short "Suffix tokens" note; `docs/badge-explainer.md` gains
  a cheat-sheet row and one beginner sentence, keeping the existing
  "red never means merely behind" note.
- Why it matters: a paused rebase/cherry-pick with conflicts already staged has
  `unmerged = 0`, so today the dot reads yellow/green mid-history-rewrite with no
  signal at all.

## 4. SSE hardening (node half + one client line)

- Add `x-accel-buffering: no` so proxies do not buffer the stream.
- Emit a **named** `event: change` frame (client switches to
  `addEventListener("change", …)`; `onmessage` does not fire for named events, so
  both halves move together — they ship together anyway).
- `res.on("close", cleanup)` in addition to `req.on("close")`, with a
  double-cleanup guard.
- **Unload disposer:** on `ctx.effect` teardown, end all open SSE responses and
  clear their heartbeats. Today only a per-request close cleans up, so a plugin
  reload leaks streams.
- Deliberately **not** copying their initial-state frame: our client already
  fetches on mount, so an initial frame would only add a duplicate request per
  mount. Recorded here so the asymmetry is intentional.
- Optional, recommended: normalise trailing slashes when matching the notified
  `{path}` against the subscribed `cwd`, so a spelling difference cannot silently
  kill freshness.

## 5. Publishing + CI

- **`.github/workflows/publish.yml`** — release-triggered
  (`on: release: types: [published]`), `permissions: { contents: read,
  id-token: write }`, `actions/setup-node@v4` on Node 24 with `registry-url`,
  `working-directory: dsh-git-badge` (our package lives in a subdirectory),
  `npm publish --provenance --access public`, `NODE_AUTH_TOKEN: ""`. No
  `npm install`/build step: zero dependencies, `lib/client.js` is checked in.
- **`.github/workflows/test.yml`** — on push/PR, `cd dsh-git-badge && npm test`
  on Node 22, so the suite is actually enforced.
- **`dsh-git-badge/package.json`** — version 0.5.5 → **0.6.0** (minor: new
  user-visible token and corrected counts), plus the test script from item 1.
- **`TESTING.md`** — add a "Node tests (no DSH needed)" section; replace the
  manual-OTP publish steps with the trusted-publishing flow, keep the 2FA note as
  the fallback, and document the one-time npmjs.com setup (Trusted Publisher →
  GitHub Actions → org `Kevin-McIsaac`, repo `dsh-workspace-git-badge`, workflow
  `publish.yml`).
- **`AGENTS.md`** — add "run `cd dsh-git-badge && npm test` before touching the
  node half" to the read-first/hard-rules section.

## 6. Dead `detail=1` annotation (no behavior change)

- Fix the stale `log -1` comment to match the `log -3` code.
- Remove the two stray second arguments at `client.js:175` / `:223` and annotate
  the node-half branch as "no surface consumes this yet — reserved for the planned
  hover card".
- The route-level `detail=1` test from item 1 pins the contract, so wiring it to a
  surface later is already covered.
- Interpretation note: "make the ignored argument explicit" is implemented as
  *removing* the misleading argument rather than actually requesting `detail=1`,
  because requesting it would add a `log -3` plus a `git stash list` to every chip
  refresh for data nothing renders yet. Say so at approval if you wanted the
  parameter threaded instead.

## Verification

1. `cd dsh-git-badge && npm test` → green, with no DSH running and no restart.
2. Targeted: nested-untracked repo → count equals the real file count and
   `untrackedMode: "all"`; forced tiny timeout → `untrackedMode: "collapsed"`.
3. `node --check` on each modified lib file as a syntax gate.
4. **One restart** (node-half rule): you restart `dsh web` and hard-refresh; the
   console shows the `[dsh-git-badge] surfaces:` line; check the chip on
   (a) a nested untracked directory, (b) a mid-rebase repo, (c) a clean repo
   (unchanged); confirm sidebar rows still render.
5. Ground truth per `docs/VERIFICATION.md`: `curl "…/api/git-badge?path=<registered>"`
   vs `git status --porcelain=v2 -uall` for the same repo.
6. Optional: `./test-profile.sh` for the published-tarball path, only if we cut
   the release in this pass.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| `-uall` expensive on huge untracked trees | Timeout → collapsed fallback + honest `untrackedMode` |
| `fs.watch` tests flaky under CI load | Deadline polling, generous bounds, mandatory unwatch cleanup |
| Named SSE event breaks a stale browser bundle | Client and node ship together; the node-half restart is required anyway, then verify the console line |
| The restart ends this session | All node changes land first; tests run before the single restart |
| Version bump / workflow inert until configured | npm trusted-publisher setup is a one-time manual step, documented in TESTING.md |

## Out of scope (Tier 2/3)

Per-workspace server-side poll fallback when a watcher fails; session-based
workspace resolution; badge-state preview page + `webprobe` assertions; hover card
consuming `detail=1`; write operations; `src/` → build script.

## Deltas as implemented

Three things changed while building it; recorded here so the plan is not read as
a description of the shipped code:

1. **Helpers live in `dsh-git-badge/test-support/`, not `test/helpers/`.** Node's
   default discovery treats every file under a `test/` directory as a test file,
   so helpers inside `test/` made the run report 43 "tests" for 41 assertions.
   Moving them out lets the portable `node --test` (no args, no glob — which
   matters on Node 20, where the test runner has no glob support) discover exactly
   the suite. The npm script is therefore `node --test`.
2. **One timeout knob, not three.** The plan split `statusTimeoutMs` /
   `statusFallbackTimeoutMs` so a test could starve the primary sample. That
   turned out to be both redundant and untestable: with equal defaults it changes
   nothing, and a sub-millisecond budget only races git's own startup, so the test
   failed ~1 run in 3. The shipped design keeps a single `gitTimeoutMs` and adds
   `config.gitRunner` — an injectable invoker, null in production — so the
   collapsed-fallback branch is forced deterministically. The suite is now 41/41
   across 8 consecutive runs.
3. **`detail=1` is annotated, not removed.** "Make the ignored argument explicit"
   was implemented as deleting the two stray second arguments at the call sites
   and documenting the node-half branch as consumer-less, because threading
   `detail=1` would add a `log -3` plus a `git stash list` to every chip refresh
   for data nothing renders yet.

Also added beyond the plan: the events-route unload disposer now releases the
process-wide fs watchers, not just the SSE streams.

