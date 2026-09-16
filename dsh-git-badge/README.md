# dsh-git-badge

Git status badges for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):

- **Input-row chip** — `● main ↑0 ↓2 ✎3` next to the access picker, showing the git state of the workspace the current conversation is attached to. Works on every install.
- **Hover card** — rest a pointer on the chip for what won't fit: the file breakdown (`✎3` split into staged / unstaged / untracked), the last ten commits, and the stash. Fetched only on hover, so the everyday badge pays nothing for it. Works on every install.
- **PR / CI token** — `● main ↑0 ↓2 PR#142 ✗` when the branch has a GitHub pull request, read through your own `gh` CLI (the plugin never handles a credential). The token **links to the PR** — it opens in a new tab, and underlines when you hover or focus it. Invisible when `gh` cannot answer: not installed, not logged in, no GitHub remote, offline or rate-limited all render the unchanged chip, and a token with no URL to link to stays plain text.
- **Worktree-aware** — a conversation's directory is fixed when it is created, so a conversation that does its work in a linked `git worktree` would otherwise keep reporting the main checkout. The session registers its checkout (`npx dsh-git-badge-checkout <path>`, run by the git-worktree and `/gh checkout` paths), and the badge describes **that worktree** instead — its branch, counts, tree mark and PR/CI token (`🌳 chore/global-skills-tiering ↑0 ↓2 PR#391 ✓` rather than `● main`). The hover card names the tree in a `worktree` row and adds a `checkout` row with the conversation's own directory, so the main checkout's branch and dirty state stay one hover away. Registrations are advisory: git's own worktree list validates the path, entries expire after 24h, and a workspace-targeted row always reports the checkout the registry owns.
- **Sidebar session-row action token** — each session row shows the ONE thing that conversation needs from you, or nothing at all: `merge`, `fix CI`, `review`, `resolve`, `pull`, `push`. It is triage rather than status: `merge` appears only when GitHub itself reports `mergeStateStatus: CLEAN`, and every waiting state (draft, blocked, behind, checks still running) stays silent. Hovering the row adds a line naming the checkout and the pull request the action refers to. The token floats to the right of the row, is set heavier than the timestamp beside it, and is coloured by how much it needs you — red for a conflict or a failing build, amber for a requested review, green for `merge`, quiet grey for routine sync. It appears only when the session is **idle** — while a turn is running the row stays quiet, because the checkout is still moving and a suggestion would describe a state that is about to change. Requires the `sidebar.workspaces.sessionRow` seam; without it the plugin degrades to chip-only and logs what's active to the browser console.
- **Nothing on workspace rows.** A workspace cannot know which worktree its conversations are using, so a per-workspace badge could only guess or report the main checkout. The seam is on the session row for that reason.

The leading **mark** belongs to the input chip: a circle filled with the status colour, or a **tree** when the checkout is a linked `git worktree`. The sidebar row deliberately carries no mark — see the row bullet above, where one word does the job a colour cannot. (`●`/`🌳` stand in for it here — it is a drawn SVG so that it can take the theme's status colours.)

Event-driven freshness: working trees are watched and updates push over SSE — badges flip within ~1s of any commit, stage, or edit, including inside a linked worktree the session registered. One `git status --porcelain=v2` per sample, shared by every surface pointing at the same checkout, plus at most one `gh` read per repository-and-branch per ~20s. The status API takes **no path**: the caller passes a session id (chip and sidebar rows) or a workspace id, and the server resolves the directory itself.

Diagrams, the hover card's full field list and a walkthrough for git newcomers live
in the [repo README](https://github.com/Kevin-McIsaac/dsh-workspace-git-badge) —
this file is the npm-facing summary.

## Install

```bash
dsh plugin --profile web add dsh-git-badge
```

Restart the web process, refresh the browser. Requires Node ≥ 20 and `git` on PATH. `gh`, on PATH and authenticated, is optional — it only enables the PR/CI token.

Seam details: [github.com/Kevin-McIsaac/dsh-workspace-git-badge](https://github.com/Kevin-McIsaac/dsh-workspace-git-badge) (SEAM.md / PR.md).

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT
