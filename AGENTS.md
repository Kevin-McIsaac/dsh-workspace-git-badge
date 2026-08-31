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

## Verifying the badge against actual git state

Established procedure (2026-09-01, during the branch.ab parser fix):

```bash
# 1. What the badge serves (the web profile's server; curl BEFORE any manual
#    git fetch so you also exercise the node half's TTL auto-fetch + resample):
curl -s "http://127.0.0.1:3080/api/git-badge?path=/home/kmcisaac/Projects/dsh-workspace-git-badge"

# 2. Ground truth:
cd /home/kmcisaac/Projects/dsh-workspace-git-badge && git fetch --quiet
git status --porcelain=v2 --branch | grep '^#'   # branch.ab +ahead -behind
git status -sb | head -1
```

Compare `ahead`/`behind`/`dirty`/file counts field by field. Notes:

- Port **3080** is the user's real GUI (`dsh web`, web profile). A
  `--profile clean --port 3200` test instance may also be running — don't
  confuse the two; the web profile is at `~/.dsh/profiles/web`.
- The plugin is installed in the web profile from npm (`dsh-git-badge@^x.y.z`,
  `~/.dsh/profiles/web/node_modules/dsh-git-badge`); the profile's node half
  runs **in-memory code from boot**, so a stale response may mean the process
  predates an install — check process start time vs install time, or run the
  installed module directly with a stubbed ctx (webServer/workspaceRegistry)
  before trusting any endpoint output.
- `git status --porcelain=v2 --branch` prints `# branch.ab +ahead -behind` —
  when parsing, element 0 of `.slice(12).trim().split(" ")` is `+ahead`,
  element 1 is `-behind` (the v0.5.3 elision-comma bug read one into the
  other; fixed in 14eb107).
- Historical gotcha: `pnpm add <same tarball path>` / `pnpm add <same
  file: dep>` can be a no-op — `rm -rf node_modules/dsh-git-badge &&
  pnpm install` to force-replace.

