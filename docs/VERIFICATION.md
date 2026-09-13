# Verifying the badge against actual git state

Moved here from `AGENTS.md` (verbatim, 2026-09-01) — used when debugging a
badge-value bug, not for ordinary feature/doc work.

Established procedure (2026-09-01, during the branch.ab parser fix; endpoint
contract updated 2026-09 for server-side resolution):

```bash
# 1. What the badge serves. The endpoint takes NO path: the caller names a
#    workspace id or a session id and the server resolves the directory.
#      ?workspace=<uuid>   a sidebar row's workspace (a generated uuid)
#      ?session=<id>       the input chip's conversation
#    Take an id from a plugin SSE notification (its payload is
#    {path, workspace}) or from the GUI's workspaces store.
#
#    For a repo with a remote, the response comes from the LOCAL
#    remote-tracking refs and a TTL-bounded fetch runs out of band — so
#    ahead/behind may lag by up to one fetch. To compare against freshly
#    fetched refs, `git fetch` yourself first, then curl:
curl -s "http://127.0.0.1:3080/api/git-badge?workspace=<workspaceId>"

# Unknown target — the stable error shape that replaced the old path 403:
curl -s "http://127.0.0.1:3080/api/git-badge?session=__no_such_session__"
#   → {"git":false,"error":{"code":"session-not-found","message":"…"}}

# 2. Ground truth:
cd /home/kmcisaac/Projects/dsh-workspace-git-badge && git fetch --quiet
git status --porcelain=v2 --branch | grep '^#'   # branch.ab +ahead -behind
git status -sb | head -1
```

Compare `ahead`/`behind`/`dirty`/file counts field by field. Notes:

- **`?path=` was removed** so a caller cannot aim the route at a directory of
  its choosing, even one inside the registry. `target-required` means you passed
  neither id; a registered path is no longer enough and will not resolve.
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

## Verifying the worktree-aware badge

A **session** target may describe a linked worktree rather than the directory the
conversation is actually in. Two extra fields say so, and only a session target
can carry them:

- `worktreeInferred: true` — the checkout below was chosen by inference (it is the
  repository's one linked worktree whose branch has an open PR), not because the
  conversation lives there.
- `checkout: { branch, dirty, changedFiles, untrackedFiles, ahead, behind }` — the
  conversation's OWN directory, present only with `detail=1` (hover). It exists so
  the main checkout's state is still visible once the chip follows a tree.

```bash
S=<session in this workspace>; W=<the workspace id>
B=http://127.0.0.1:3080/api/git-badge

# precondition — WITHOUT BOTH OF THESE THE SWAP IS CORRECTLY ABSENT:
git -C <repo> worktree list          # a linked worktree, not just the main one
gh pr list --state open              # its branch must have an OPEN PR
# exactly one such worktree is a candidate; two is a reason to say nothing

curl -s "$B?session=$S&pr=1" | python3 -m json.tool     # → the worktree's branch,
#   isWorktree, worktreeName, worktreeInferred, pr
curl -s "$B?workspace=$W&pr=1" | python3 -m json.tool   # → the workspace's own
#   checkout, no `pr`, no `worktreeInferred` — a row never follows a tree
curl -s "$B?session=$S&pr=1&detail=1" | python3 -m json.tool   # adds `checkout`
```

Ground truth for the swap is the worktree list plus `gh pr list`, not the PR alone:
a merged PR (#391 in the session that motivated this) leaves the badge on the main
checkout, which is correct and looks identical to "the feature is broken".

`config.worktreeStatus = "off"` disables the inference; a repository with no linked
worktree never even spawns `gh` for it.
