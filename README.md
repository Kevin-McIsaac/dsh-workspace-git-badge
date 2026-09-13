# dsh-git-badge

Git status badges for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)

[![tests](https://github.com/Kevin-McIsaac/dsh-workspace-git-badge/actions/workflows/test.yml/badge.svg)](https://github.com/Kevin-McIsaac/dsh-workspace-git-badge/actions/workflows/test.yml)

`● main ↑0 ↓2 ✎3 PR#142 ✗`

Two surfaces, two jobs: the **input chip** tells you *where you are and what the
state is*; each **sidebar session row** tells you *whether that conversation needs
you*. The leading **mark** — a filled circle, or a **tree** when the checkout is a
linked `git worktree` — belongs to the chip. `●` and `🌳` stand in for it in these
examples; it is drawn as an SVG so it can take the theme's status colours.

## What you get

**The input chip**, in the input box after the access picker — the branch, the
sync and dirty counts, an operation token when git is mid-something, and the
PR/CI token when the branch has a pull request:

<img alt="The git badge chip in the DSH input box, showing a clean main branch with sync counts and a failing pull request" src="https://github.com/user-attachments/assets/a5a9a405-a515-491f-a21a-e53d7e52eca1" />

**A sidebar session row** — the one action that conversation needs, or nothing at
all. The token floats right, sits heavier than the timestamp, and is coloured by
how much it needs you; hovering the row names the checkout and the pull request
it refers to:

![Sidebar session rows: one asking you to fix CI in red, one asking you to merge in green, and one with nothing to do showing no token at all](docs/images/session-rows.svg)

Both surfaces are updated within seconds of any commit, checkout, stage or file
edit — including inside a linked worktree.

## The mark (input chip)

One three-state summary, checked top-down, first match wins:

| Colour | When | What to do |
|--------|------|------------|
| 🔴 red | Unmerged files (merge/rebase conflict in progress), **or** a dirty tree that is also behind upstream | Resolve conflicts, or commit your edits before pulling |
| 🟡 yellow | Dirty files, or any ahead/behind (sync pending) | Commit (✎), push (↑), or pull (↓) when convenient |
| 🟢 green | Clean and in sync with the upstream | Nothing |

The shape carries a second, independent fact: a **circle** for the main checkout,
a **tree** for a linked `git worktree`. Shape says *worktree*, fill says *status*,
so the two never compete for one channel:

![The input chip in three states: a clean main checkout with a failing pull request, a linked worktree with a passing one, and how shape and colour split the two facts](docs/images/chip.svg)

Red never means merely "behind" — a clean tree one commit behind is a normal
between-pulls state. See [`docs/badge-explainer.md`](docs/badge-explainer.md) for a
beginner-friendly walkthrough.

## The action token (sidebar session rows)

A session row answers one question — *does this conversation need me?* — with one
word, and says nothing when the answer is no. First match wins:

| Action | Shown when | Colour |
|--------|-----------|--------|
| `resolve` | unmerged files | red |
| `fix CI` | the PR's check rollup is failing | red |
| `review` | changes were requested | amber |
| `merge` | GitHub itself reports `mergeStateStatus: CLEAN` | green |
| `pull` | behind upstream (diverged counts as behind) | quiet grey |
| `push` | ahead of upstream | quiet grey |

Colour means **severity**, not identity: the loud rows only mean something
because routine sync stays quiet. The word is still the channel — colour only
reinforces it.

`merge` is the forge's verdict, not a judgement made here. Whether a pull request
is mergeable depends on branch protection and required reviews, so the plugin
passes through GitHub's own `mergeStateStatus` and shows nothing for `DRAFT`,
`BLOCKED`, `BEHIND`, `UNSTABLE` or `UNKNOWN` — waiting is not an action, and a
wrong imperative is worse than silence. Uncommitted work is likewise a *state*
rather than a chore: a dirty tree on its own shows no token (the chip's amber is
where that lives).

Hovering a row adds the line the token cannot carry — which checkout, and which
pull request:

```
checkout: worktree-aware-chip on feat/worktree-aware-chip · its branch has the open pull request · pull request #18 · checks passing
```

A workspace row carries no badge at all: a workspace cannot know which worktree
its conversations are using, which is why the seam sits on the session row.

## Suffix tokens (input chip)

The chip carries an operation token after the branch name when git is
mid-operation:

```
● main ⚔rebase ↑0 ↓2 ✎3
```

`⚔merge`, `⚔squash`, `⚔cherry-pick`, `⚔revert`, `⚔bisect`, `⚔rebase`,
`⚔sequencer` — naming what git is waiting on. It is independent of the mark: a
paused rebase whose conflicts are all already staged has **no unmerged files**, so
the mark can be green while `⚔rebase` is showing. The token is the only signal
that history is mid-rewrite, and it appears on the input chip only.

## Hover card (input chip)

The chip is deliberately terse — `↑0 ↓2 ✎3` is three numbers for four different
things. Hover it for the breakdown the chip has no room for:

```
branch        chore/global-skills-tiering
upstream      origin/chore/global-skills-tiering
sync          ↑0 ↓2
files         2 staged · 1 unstaged · 3 untracked
operation     rebase
pull request  #391 · checks passing · approved
worktree      global-skills-tiering (inferred from its open pull request)
checkout      main · clean
commits       abc1234 fix the thing · 2 hours ago
              def5678 add another thing · yesterday
stash         2 stashed
```

Four details worth knowing:

- **`✎n` split apart.** "3 files" cannot tell *ready to commit* from *not staged
  yet*; the card names staged, unstaged, unmerged and untracked separately.
- **A count it cannot trust says so.** When a huge untracked tree blows the walk's
  time budget the node half falls back to git's collapsed count; the card marks
  that `(collapsed)` rather than presenting an under-count as exact.
- **`worktree` and `checkout`.** When the badge is describing a worktree the
  conversation is not in, these two rows say which tree it is, why it was
  followed, and what the conversation's own directory looks like.
- **Fetched only on hover** — the extra `log`/`stash` reads happen once a pointer
  actually rests on the chip, so the everyday badge pays for none of them. The
  session row reuses the chip's own cached read for its hover line rather than
  issuing a second one.

## Pull requests and CI

When the branch has a GitHub pull request, the chip carries its number and CI
state:

```
● main ↑0 ↓2 ✎3 PR#142 ✗
```

The glyph is `✓` passing, `…` running, `✗` failing (and nothing when the PR has
no checks); a draft PR is marked `draft`. The token also carries an accessible
name naming the state, so the glyph is not the only channel, and it **links to the
PR** — opening in a new tab, underlining on hover or focus. The hover card spells
out the rest: check state, draft, review decision.

This reads the current branch's PR through **your own `gh` CLI**, so the plugin
never handles a credential: `gh` owns the token. A GitHub remote is required
(`origin`), and the read is rate-limited to once per ~90s per repository and never
delays the badge.

**Nothing appears when `gh` cannot answer** — not installed, not logged in, no
GitHub remote, offline, rate-limited, or a timed-out call all render exactly the
unchanged chip, and the row simply shows no PR-derived action. If you have no
`gh`, you lose nothing and see nothing.

## Worktrees

A conversation's directory is fixed when it is created, so a conversation that
does its work in a linked `git worktree` would otherwise keep reporting the main
checkout — including "no pull request" while its own pull request was open.

So a badge that was asked about a **session** follows the repository's worktree
when it can be identified without guessing: the session's checkout is the **main**
checkout, and **exactly one** linked worktree of that repository has a branch with
an **open** pull request. Then the chip describes *that* tree — its branch, counts,
tree mark and PR token:

```
🌳 chore/global-skills-tiering ↑0 ↓2 ✎3 PR#391 ✓
```

One candidate only: a second open PR across worktrees is a reason to say nothing
rather than pick one, and a session already inside a worktree is never moved
sideways onto a sibling. The `worktree` row in the hover card names the tree and
says it was inferred; the `checkout` row keeps the conversation's own directory
one hover away. A **workspace** row never follows a worktree.

## Freshness and cost

- Working trees are watched and changes push over SSE: a badge flips within ~1s of
  a commit, stage, checkout or edit — including inside a worktree that is only
  inferred, whose working tree and git dir both get a watcher.
- One `git status --porcelain=v2` per sample, shared by every surface pointing at
  the same checkout (concurrent identical reads collapse into one).
- At most one `gh` read per repository-and-branch per ~90s, plus one
  repository-wide open-PR list per ~90s — and a repository with no linked worktree
  never pays for the latter at all.
- Ahead/behind come from local remote-tracking refs, refreshed by a TTL-bounded
  fetch **out of band**, so the counts can lag by up to one fetch while branch,
  dirty state and file counts never wait on the network.
- The status API takes **no path**: the caller passes a session id (the chip and
  every sidebar row) or a workspace id, and the server resolves the directory
  itself.

## Install

```bash
dsh plugin --profile web add dsh-git-badge
```

Then restart the web process and refresh the browser. This activates the input
chip on any install.

Sidebar session-row tokens need a seam the workspace browser does not declare
upstream yet (discussion
[#5092](https://github.com/deepseek-ai/deepseek-harness/discussions/5092)). From a
clone of this repo:

```bash
seam/apply.sh apply     # patch the installed DSH (hash-guarded), then restart dsh web
seam/apply.sh revert    # restore pristine at any time
```

Notes:

- The patch lives in `node_modules`, so a DSH reinstall/update reverts it —
  re-run `seam/apply.sh apply` afterwards.
- The hash-guard **refuses** to patch if the installed file doesn't match the
  pinned upstream build (it never blind-overwrites an update). Rebuild the patch
  with `seam/make-patch.sh` + `seam/stamp-hash.sh` after a DSH release changes the
  file.
- Once upstream ships the seam itself, `apply` becomes a no-op and the
  npm-installed plugin picks it up with no changes on your side.

Details, safety rails and the upstream proposal are in [`SEAM.md`](SEAM.md) /
[`PR.md`](PR.md).

## Testing

See [`TESTING.md`](TESTING.md) — clean-profile boot (customer simulation), the
seam apply/revert procedure, and the gotchas list. `cd dsh-git-badge && npm test`
runs the whole suite (parser, real temp repositories, resolution, SSE, the
watcher, every `gh` degradation path and the rendered surfaces) with no DSH, no
network and no restart.

The images above are hand-built mockups, not screenshots — see
[`docs/images/README.md`](docs/images/README.md) for how to swap in real captures
and what each one should show.

## Requirements

- Node.js ≥ 20, `git` on PATH
- DSH with the `web` profile (any install)
- `gh` on PATH, authenticated, for the PR/CI token and the row's `merge`/`review`
  actions — otherwise those are silently absent and everything else still works

## License

[MIT](LICENSE)
