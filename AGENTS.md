# AGENTS.md

Notes for coding agents working in this repo.

## What this repo is

`dsh-git-badge` — a DeepSeek Harness cordis plugin (npm-published) providing
git status badges: an input-row chip (`conversation.input.left`, works
everywhere) and sidebar workspace-row badges via the `sidebar.workspaces.row`
seam (a local +40/−8 patch in `seam/`, proposed upstream — see `PR.md`).

## Read first

- **Testing any change**: `TESTING.md` — run the node suite first
  (`cd dsh-git-badge && npm test`; no DSH, no restart), then clean-profile boot,
  seam apply/revert, and the gotchas list. Don't rediscover them.
- **Architecture**: `README.md` (user view), `SEAM.md` (patch rails),
  `PR.md` (upstream proposal).
- **Debugging badge values** (curl endpoint vs `git status` ground truth):
  `docs/VERIFICATION.md`.

## Hard rules learned in development

1. Run `cd dsh-git-badge && npm test` before and after touching the **node half**
   (`dsh-git-badge/lib/index.js`) — the suite covers the parser, `gitStatus`,
   request→workspace resolution, SSE and the watcher with no DSH boot. Seeing a
   node-half change live still requires restarting the user's dsh web process,
   which ends your session; tell the user to restart and report back. Client-half
   changes usually need only a browser refresh, but any patch/bundle-graph change
   requires a restart before refreshing (bundle URLs are rev-pinned at boot).
2. The installed DSH lives at
   `~/.config/nvm/versions/node/v22.23.2/lib/node_modules/@deepseek-ai/dsh`;
   the seam patch targets
   `…/node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js`.
   After any DSH update run `seam/apply.sh status` first — it reports
   patched/pristine/drift by **hash** (a version string tells you nothing about
   which bytes are installed) and exits 1 on drift, with the rebuild commands.
   Then `seam/apply.sh apply` once the hash-guard would pass.
3. The user's instance runs the **patched** setup; a clean-profile customer
   simulation is `TESTING.md` § "Clean-profile test".
4. `dsh-git-badge/package.json` exports must keep `"./package.json"` — the client
   scanner silently ignores the package without it.
5. When committing: stage explicit paths. Never `git add -A` (test artifacts).
6. The status route takes **no path** — the caller names who it is and the server
   resolves the directory: `?session=<id>` (the input chip) or `?workspace=<id>`
   (a sidebar row; a generated uuid matching the seam's `workspaceId`). A `?path=`
   request is refused with `target-required`; an unresolvable id gives
   `session-not-found` / `workspace-not-found`. Never send a filesystem path, and
   never display-abbreviate one as `~/...`.

