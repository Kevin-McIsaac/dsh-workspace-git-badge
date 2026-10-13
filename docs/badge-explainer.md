# Reading the git badge (for git newbies)

The badge shows an **action icon**, your **branch name**, and sometimes
**small numbers** like `↑2 ↓1 ✎3`. Here's what each piece means.

There is ONE icon system. The node half of the plugin ranks your checkout's
state and picks the single thing it needs — `push`, `merge`, `commit`, `review`
and so on. That appears as a **coloured icon**: at the head of the input chip,
and in a sidebar row's leading cell (`✓`, `✗`, `◆`, …). With nothing to do the
node says `in sync`, so a session is never iconless: a **disc**, green when the
branch is the default branch or its work is merged, amber when commits are not yet
merged. A hover
card explains the icon in words, on both surfaces.

## The action icon — "is there something I need to do?"

The icon summarizes the ONE thing your checkout needs. Its colour is the
**severity**, taken from the app's own state tokens:

| Colour | Severity | Examples | What to do |
|--------|----------|----------|------------|
| 🔴 **Red** | error | a merge conflict, a paused rebase, failing checks | Resolve the conflict, finish the operation, or fix the build first |
| 🟡 **Amber** | warn | a review requested or required | Answer the review |
| 🟢 **Green** | success | the pull request is ready to merge, or `in sync` with nothing outstanding | Merge it, or nothing at all |
| 🔵 **Blue** | business | routine work: push, pull, sync, update, commit | Do it when convenient |

Severity is not identity: several routine actions share the blue, and the WORD on
the hover card says which one. Red never means merely "behind" — that is routine
blue. The `in sync` disc is the idle state: a clean checkout that matches its
remote. It is green when the branch is the default branch or its work is merged,
and amber when commits are still unmerged.

## The numbers — three separate things

```
↑2   ↓1   ✎3
 │    │    └─ pencil: files changed but not committed (this makes the action `commit`)
 │    └─ down arrow: commits on the remote (GitHub) that you don't have yet — you should `git pull`
 └─ up arrow: commits you made that the remote doesn't have yet — you should `git push`
```

- **✎ (pencil) = uncommitted changes.** Files you edited, added, or
  deleted since your last commit. Committing makes this go to zero. Every new
  file counts, including each file inside a brand-new folder — so dropping in a
  folder of 3 files shows `✎3`, not `✎1`.

- **↑ (up) = ahead.** Commits that exist only on your machine.
  Fix: `git push`.

- **↓ (down) = behind.** Commits that exist on the remote but not on
  your machine — usually a teammate pushed, or you merged a pull
  request on GitHub. Fix: `git pull`.

## The ⚔ token — "git is in the middle of something"

Sometimes the badge shows a word with a little sword in front of it, right after
the branch name:

```
✚ main ⚔rebase ↑0 ↓2 ✎3
```

That means git started an operation and has not finished it. The word says
which one: `⚔merge`, `⚔squash`, `⚔cherry-pick`, `⚔revert`, `⚔bisect`,
`⚔rebase`, `⚔sequencer`.

This matters because the **action icon cannot tell you this**. When you pause a
rebase and stage the files you fixed, no conflicts are left, so the icon goes
back to the routine action (`commit`, `push`) — or disappears. The ⚔ word is the
only part of the badge saying git is still mid-operation and waiting for you to
continue or undo it (`git rebase --continue`, `git rebase --abort`, …).

Only the chip in the input box shows the token. A sidebar row shows the one
**action** that conversation needs — `resume`, `resolve`, `sync`, `pull`,
`update`, `push`, `merge`, `commit`, `review`, `fix CI`, or `in sync` when
there is nothing to do. Each word has an icon too:

| Word | Icon | When it appears |
|------|------|-----------------|
| `resume` | ⏵ | a merge, rebase, cherry-pick, revert, squash or bisect is paused |
| `resolve` | ! | unmerged files, or a pull request that conflicts with its base |
| `review` | ◆ | review changes requested, or a review still required |
| `sync` | ⇄ | you are both ahead of and behind the remote |
| `pull` | ↓ | you are behind the remote |
| `update` | ↻ | the pull request is behind its base branch |
| `push` | ↑ | the branch has no upstream yet, or you have commits the remote does not |
| `merge` | merge glyph | GitHub reports the pull request ready to merge |
| `commit` | ✚ | uncommitted work (staged, unstaged or untracked) |
| `fix CI` | ✗ | the pull request's checks are failing |
| `in sync` | ● | clean and matching the remote; green when merged, amber when not |

Six icons are **drawn**, not typed: the four arrows `↑ ↓ ⇄ ↻`, the idle disc, and
the merge glyph. The font's arrows are hairlines, and Unicode has no merge symbol
at all, so the merge icon is Remix Icon's `git-merge-line`, vendored as inline SVG
at 16px: the branch-into-a-trunk shape that GitHub, VS Code, Font Awesome and
Material all use. No icon font is involved.

The row shows the token as its icon in the leading cell, with the word as its
accessible name. Rest the pointer on that row and its usual hover card opens a
label/value list: the action with its reason (`↑ push — no upstream configured`),
the checkout, and the pull request. The input chip leads with the SAME icon, so
the two surfaces agree. When there is nothing to do, the node says `in sync` and
both surfaces show the disc — green when nothing is outstanding, amber when commits
are not yet merged.

## A worked example

`↓ main  ↑0 ↓1` means (the `↓` is the `pull` token):

- Your folder exactly matches your last local commit (the ✎ count is 0).
- ↑0 You have nothing to push.
- ↓1 Someone (or you, from GitHub) added one commit to the remote that
  you haven't pulled yet.

The icon is **blue** (`pull`) — it's reminding you that you're one
commit behind the shared version. It's a perfectly safe state, just a
small nudge: run `git pull` whenever you're ready. The colour turns
red only when a state blocks you — a conflict, a paused operation, or a
failing build.

## Quick cheat sheet

| You see | What it means | What to do |
|---------|--------------|------------|
| 🟢 main | All clean, fully synced | Nothing — the green `in sync` disc |
| 🟡 feat/x | Clean and pushed, commits not merged | Open a pull request when ready — the amber `in sync` disc |
| ↓ main ↓1 | Your files are fine, remote is 1 commit ahead | `git pull` when convenient |
| ✚ main ✎2 | 2 files changed, not committed | `git add` + `git commit` |
| 🟡 main ✎2 ↓1 | Uncommitted edits *and* behind | `git add` + `git commit`, then `git pull` |
| 🔵 main ↑2 ↓1 ✎3 | Unsaved edits, plus unsynced commits both ways | Commit your edits, then `git pull` and `git push` |
| ⏵ main ⚔rebase | A rebase is paused, waiting on you | Finish it (`git rebase --continue`) or undo it (`git rebase --abort`) |
| ! main | Merge conflict in progress | Resolve the conflicted files, then commit |
| main (a linked worktree) | A linked worktree sitting on `main`, clean and synced | Nothing — the card's `worktree` row names it |

(The emoji in these tables stand for the icon's severity colour. The icon itself
is one glyph, and the hover card gives the word behind it.)
