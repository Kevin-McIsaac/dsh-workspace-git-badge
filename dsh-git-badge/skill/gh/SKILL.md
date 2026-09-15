---
name: gh
description: Git and GitHub operations for the current checkout, driven by an invocation argument — /gh push, /gh pr, /gh pull, /gh commit, /gh checks <n>, or bare /gh to do the single highest-priority next action.
whenToUse: When the user picks a git action from the commands menu (/gh push, /gh pr, …) or asks to sync, publish, or open a pull request for the checkout they are working in.
---

# gh — git/GitHub actions for this checkout

You are invoked as `/gh <sub>` (or bare `/gh`). The sub-command chooses the
operation. Anything destructive requires explicit user confirmation before you
run it, every command is reported with its output, and a failure is reported
verbatim rather than retried blind.

## First: establish state

Run one status call and read it before acting (except for `checks`, which acts
on its argument):

```
git --no-optional-locks status --porcelain=v2 --branch
```

Note branch, upstream, ahead/behind, and the dirty breakdown (staged /
unstaged / untracked / unmerged), plus any in-progress operation marker
(MERGE_HEAD, rebase-merge, …).

## Sub-commands

- **`/gh next`** (or bare `/gh`) — do the single highest-priority action, first
  match wins: resume a paused operation (`git merge --continue`,
  `git rebase --continue`, …; a squash merge concludes with `git commit`);
  resolve unmerged files only WITH the user; `git pull --ff-only` when behind;
  `git push -u origin <branch>` when there is no upstream; `git push` when
  ahead; stage and commit when dirty (`git commit` if work is already staged,
  `git add -p && git commit` for unstaged edits, `git add -A && git commit`
  only for untracked-only changes, which `add -p` cannot see); `gh pr checks
  <n> --watch` when CI fails. Clean and synced → say so and stop.

- **`/gh push`** — `git push`. If there is no upstream, `git push -u origin
  <branch>`. If the push is rejected as non-fast-forward, STOP and ask: offer
  `--force-with-lease` as the option, never plain `--force`, and never without
  an explicit yes.

- **`/gh pr`** — create a pull request for the current branch: push first if
  needed, then `gh pr create` with a title from the branch's commits and a body
  summarising them. If a PR already exists, report its state (`gh pr view`)
  instead of creating another.

- **`/gh pull`** — `git pull --ff-only`. On failure, report the divergence and
  ask; do not merge or rebase without the user choosing.

- **`/gh commit`** — commit the current work: `git commit` when work is already
  staged; otherwise `git add -p` interactively is not available to you, so
  stage deliberately (`git add <paths>` named from the status output) and say
  exactly what you staged before committing. Untracked-only changes: `git add
  -A && git commit` after listing what -A will pick up. Write the message from
  the diff, not a template.

- **`/gh checks <n>`** — `gh pr checks <n>` and summarise: what fails, what is
  pending, and the single most useful next step.

- **`/gh sync`** — the branch has diverged (local commits AND upstream
  changes): `git fetch`, then rebase the local commits onto
  `upstream/<branch>`, then `git push --force-with-lease`. The force-push
  ALWAYS needs an explicit user yes first, with a one-line summary of what
  would move.

- **`/gh merge <n>`** — squash-merge pull request `<n>` (`gh pr merge <n>
  --squash`), the repo's stated convention. Confirm with the user before
  merging; afterwards report the merge and offer to update the local main.

- **`/gh order`** — reconfigure which action class the badge ranks first. The
  order is one line of JSON at `~/.dsh/git-badge-next.json`:
  `{ "order": ["operation", "unmerged", "sync", "publish", "merge", "commit",
  "checks"] }` — any subset, any order; unlisted categories rank after in
  default order. Read the file (it may not exist yet), apply the requested
  change, show the resulting order, and never invent categories. Typical
  invocations: "/gh order commit first", "/gh order never suggest checks
  before push".

## Handoff

One verb per invocation is this skill's whole job. Anything multi-step around a
pull request — review, merge, verify it landed, clean up the branch — belongs to
the `gh-pr` skill; hand off rather than improvise a lifecycle.

## Hard rules

- Never `git reset --hard`, `git clean`, `git checkout -- .`, `git push
  --force` (plain), or any history rewrite without an explicit user yes.
- `GIT_TERMINAL_PROMPT=0` on network commands so a missing credential fails
  fast instead of hanging.
- One operation per invocation; report the outcome, then stop.
