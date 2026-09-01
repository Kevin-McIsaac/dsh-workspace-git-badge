# Verifying the badge against actual git state

Moved here from `AGENTS.md` (verbatim, 2026-09-01) — used when debugging a
badge-value bug, not for ordinary feature/doc work.

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
