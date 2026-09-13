# dsh-git-badge

Git status badges for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)

`● main ↑0 ↓2 ✎3`

The leading **mark** is a filled circle carrying the status colour, or a **tree**
(🌳) when the workspace is a linked `git worktree`. `●` and `🌳` stand in for it in
these examples — it is drawn as an SVG so it can take the theme's status colours.

## What you get

The Git status badge for a project in the: 
<ul>
  <li>
  input box after the access picker.

  <img  alt="image" src="https://github.com/user-attachments/assets/a5a9a405-a515-491f-a21a-e53d7e52eca1" />
  </li>

<li>
  workspace after each project name. (May require the seam patch to enable)

```
Project 1                                    merge
Project 2
```

  The row keeps the workspace name on the left and, when the conversation needs
  something from you, floats the **one action** to the right — `merge`, `fix CI`,
  `review`, `resolve`, `pull`, `push`. Nothing shown means nothing to do; hovering
  names the checkout and the pull request the action refers to. It is coloured by
  urgency — red for a conflict or a failing build, amber for a review, green for
  `merge`, quiet grey for routine sync. The branch is never
  shown here — the input chip names it, and the chip is where the shared status
  mark lives.
  </li>
</ul>
Git status is updated within seconds of any commit, checkout, stage, or file edit — including inside a linked worktree.

## Status colours

One three-state summary drives the status mark on **both** surfaces — the input
chip and each sidebar row — and the mark is identical in both: same
circle-or-tree shape, same fill (checked top-down, first match wins). It is drawn
as an SVG rather than typed as an emoji precisely so it can take these theme
colours — 🌳 is a colour emoji and cannot be tinted.

| Colour | When | What to do |
|--------|------|------------|
| 🔴 red | Unmerged files (merge/rebase conflict in progress), **or** a dirty tree that is also behind upstream | Resolve conflicts, or commit your edits before pulling |
| 🟡 yellow | Dirty files, or any ahead/behind (sync pending) | Commit (✎), push (↑), or pull (↓) when convenient |
| 🟢 green | Clean and in sync with the upstream | Nothing |

Red never means merely "behind" — a clean tree one commit behind is a normal
between-pulls state. See [`docs/badge-explainer.md`](docs/badge-explainer.md)
for a beginner-friendly walkthrough.

## Suffix tokens

The input chip can carry an operation token after the branch name when git is
mid-operation:

```
● main ⚔rebase ↑0 ↓2 ✎3
```

The token names what git is waiting on: `⚔merge`, `⚔squash`, `⚔cherry-pick`,
`⚔revert`, `⚔bisect`, `⚔rebase`, `⚔sequencer`.

It is independent of the mark. A paused rebase whose conflicts are all already
staged has **no unmerged files**, so the mark can be green while `⚔rebase` is
showing — the token is the only signal that history is mid-rewrite. Tokens
appear on the input chip only.

## Hover card

The chip is deliberately terse — `↑0 ↓2 ✎3` is three numbers for four different
things. Hover it for the breakdown the chip has no room for: what the dirty
count is actually made of, the last three commits, and the stash.

```
branch        main
upstream      origin/main
sync          ↑1 ↓2
files         2 staged · 1 unstaged · 3 untracked
operation     rebase
commits       abc1234 fix the thing · 2 hours ago
              def5678 add another thing · yesterday
stash         2 stashed
```

Two details worth knowing:

- **`✎n` split apart.** "3 files" cannot tell *ready to commit* from *not staged
  yet*; the card names staged, unstaged, unmerged and untracked separately.
- **A count it cannot trust says so.** When a huge untracked tree blows the
  walk's time budget the node half falls back to git's collapsed count; the card
  marks that `(collapsed)` rather than presenting an under-count as exact.

The card is fetched only when a pointer rests on the chip, so the everyday badge
never pays for it. It lives on the input chip only — the sidebar row stays status
and identity, and asks for none of it.

## Pull requests and CI

When the branch has a GitHub pull request, the chip carries its number and CI
state:

```
● main ↑0 ↓2 ✎3 PR#142 ✗
```

The glyph is `✓` passing, `…` running, `✗` failing (and nothing when the PR has
no checks); a draft PR is marked `draft`. The token also carries an accessible
name naming the state, so the glyph is not the only channel. The hover card
spells out the rest — check state, draft, review decision.

This reads the current branch's PR through **your own `gh` CLI**, so the plugin
never handles a credential: `gh` owns the token. A GitHub remote is required
(`origin`), and the check is rate-limited to once per ~90s per repository and
never delays the badge.

**Nothing appears when `gh` cannot answer** — not installed, not logged in, no
GitHub remote, offline, rate-limited, or a timed-out call all render exactly the
unchanged chip. If you have no `gh`, you lose nothing and see nothing.

## Worktrees

When the conversation's checkout is a linked `git worktree`, the **mark becomes a
tree** — the shape says *worktree* while the fill still says *status*, so the two
facts never compete for one channel:

```
🌳 feat/hotfix ↑0 ↓2 ✎3
```

The name is the checkout's directory name, shown in the chip's hover card rather
than on the chip itself, so the everyday chip stays uncluttered. A sidebar row
shows the action word for that conversation instead — no name, no branch, no mark.

## Install

```bash
dsh plugin --profile web add dsh-git-badge
```

Then restart the web process and refresh the browser. This will activate the input status chip. 

Sidebar session-row badges need the proposed new sidebar seam. If this is not available apply the patch
(discussion [#5092](https://github.com/deepseek-ai/deepseek-harness/discussions/5092)).

From a clone of this repo:

```bash
seam/apply.sh apply     # patch the installed DSH (hash-guarded), then restart dsh web
seam/apply.sh revert    # restore pristine at any time
```

Notes:

- The patch lives in `node_modules`, so a DSH reinstall/update reverts it —
  re-run `seam/apply.sh apply` afterwards.
- The hash-guard **refuses** to patch if the installed file doesn't match the
  pinned upstream build (it never blind-overwrites an update). Rebuild the
  patch with `seam/make-patch.sh` + `seam/stamp-hash.sh` after a DSH release changes
  the file.
- Once upstream ships the seam itself, `apply` becomes a no-op and the
  npm-installed plugin picks it up with no changes on your side.

Details, safety rails, and the upstream proposal are in
[`SEAM.md`](SEAM.md) / [`PR.md`](PR.md).

## Testing

See [`TESTING.md`](TESTING.md) — clean-profile boot (customer simulation),
seam apply/revert procedure, and the gotchas list.

## Requirements

- Node.js ≥ 20, `git` on PATH
- DSH with the `web` profile (any install)

## License

[MIT](LICENSE)
