# AGENTS.md

Notes for coding agents working in this repo.

## What this repo is

`dsh-git-badge` — a DeepSeek Harness cordis plugin (npm-published) providing
git status badges: an input-row chip (`conversation.input.left`, works
everywhere) and sidebar workspace-row badges via the `sidebar.workspaces.row`
seam (a local 32-line patch in `seam/`, proposed upstream — see `PR.md`).

## Read first

- **Testing any change**: `TESTING.md` — clean-profile boot, seam apply/revert,
  and the gotchas list. Don't rediscover them.
- **Architecture**: `README.md` (user view), `SEAM.md` (patch rails),
  `PR.md` (upstream proposal).
- **Debugging badge values** (curl endpoint vs `git status` ground truth):
  `docs/VERIFICATION.md`.

## Hard rules learned in development

1. Changing the **node half** (`plugin/lib/index.js`) requires restarting the
   user's dsh web process — it ends your session; tell the user to restart
   and report back. Client-half changes usually need only a browser refresh,
   but any patch/bundle-graph change requires a restart before refreshing
   (bundle URLs are rev-pinned at boot).
2. The installed DSH lives at
   `~/.config/nvm/versions/node/v22.23.2/lib/node_modules/@deepseek-ai/dsh`;
   the seam patch targets
   `…/node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js`.
   Re-apply with `seam/apply.sh apply` after any DSH update.
3. The user's instance runs the **patched** setup; a clean-profile customer
   simulation is `TESTING.md` § "Clean-profile test".
4. `plugin/package.json` exports must keep `"./package.json"` — the client
   scanner silently ignores the package without it.
5. When committing: stage explicit paths. Never `git add -A` (test artifacts).
6. The registry allowlist 403s anything that isn't a registered workspace;
   send RAW paths, never display-abbreviated `~/...` strings.

