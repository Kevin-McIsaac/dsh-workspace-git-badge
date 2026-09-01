# Reading the git badge (for git newbies)

The badge shows a **colored dot**, your **branch name**, and sometimes
**small numbers** like `↑2 ↓1 ✎3`. Here's what each piece means.

## The colored dot — "is there something I need to do?"

The dot summarizes your whole git situation in three levels:

| Dot | Meaning | What to do |
|-----|---------|------------|
| 🟢 **Green** | Every file in your folder matches your last commit, **and** you're in sync with the remote (GitHub). Nothing to do. | Nothing |
| 🟡 **Yellow** | Routine work pending: you have uncommitted file changes (✎), or you're ahead (↑) / behind (↓) of the remote. Nothing is wrong. | Commit, push, or pull when convenient |
| 🔴 **Red** | Something needs attention before you keep working: either a **merge conflict** is in progress (git is blocked until you resolve it), or you have **uncommitted edits on top of an outdated base** (dirty *and* behind — commit first, then pull). | Resolve the conflict, or commit your edits then `git pull` |

**Note:** red never means merely "behind". A clean folder that is one commit
behind the remote is a completely normal state between pulls — the dot only
turns red when behind *combines* with unsaved edits.

The rules are checked top-down: red wins over yellow, yellow over green.

## The numbers — three separate things

```
↑2   ↓1   ✎3
 │    │    └─ pencil: files changed but not committed (this makes the dot yellow)
 │    └─ down arrow: commits on the remote (GitHub) that you don't have yet — you should `git pull`
 └─ up arrow: commits you made that the remote doesn't have yet — you should `git push`
```

- **✎ (pencil) = uncommitted changes.** Files you edited, added, or
  deleted since your last commit. Committing makes this go to zero.

- **↑ (up) = ahead.** Commits that exist only on your machine.
  Fix: `git push`.

- **↓ (down) = behind.** Commits that exist on the remote but not on
  your machine — usually a teammate pushed, or you merged a pull
  request on GitHub. Fix: `git pull`.

## A worked example

`🟡 main  ↑0 ↓1` means:

- Your folder exactly matches your last local commit (the ✎ count is 0).
- ↑0 You have nothing to push.
- ↓1 Someone (or you, from GitHub) added one commit to the remote that
  you haven't pulled yet.

The dot is **yellow, not green** — it's reminding you that you're one
commit behind the shared version. It's a perfectly safe state, just a
small nudge: run `git pull` whenever you're ready. The dot only turns
red if you start *editing files* while still behind — that combination
is where beginners get bitten (a commit made on an outdated base needs
an extra merge).

## Quick cheat sheet

| You see | What it means | What to do |
|---------|--------------|------------|
| 🟢 main | All clean, fully synced | Nothing |
| 🟡 main ↓1 | Your files are fine, remote is 1 commit ahead | `git pull` when convenient |
| 🟡 main ✎2 | 2 files changed, not committed | `git add` + `git commit` |
| 🔴 main ✎2 ↓1 | Uncommitted edits *and* behind — commit before pulling | `git add` + `git commit`, then `git pull` |
| 🟡 main ↑2 ↓1 ✎3 | Unsaved edits, plus unsynced commits both ways | Commit your edits, then `git pull` and `git push` |
| 🔴 main | Merge conflict in progress | Resolve the conflicted files, then commit |
