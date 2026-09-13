# dsh-git-badge

Git status badges for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):

- **Input-row chip** — `● main ↑0 ↓2 ✎3` next to the access picker, showing the git state of the workspace the current conversation is attached to. Works on every install.
- **Hover card** — rest a pointer on the chip for what won't fit: the file breakdown (`✎3` split into staged / unstaged / untracked), the last three commits, and the stash. Fetched only on hover, so the everyday badge pays nothing for it. Works on every install.
- **PR / CI token** — `● main ↑0 ↓2 PR#142 ✗` when the branch has a GitHub pull request, read through your own `gh` CLI (the plugin never handles a credential). The token **links to the PR** — it opens in a new tab, and underlines when you hover or focus it. Invisible when `gh` cannot answer: not installed, not logged in, no GitHub remote, offline or rate-limited all render the unchanged chip, and a token with no URL to link to stays plain text.
- **Worktree-aware** — a conversation's directory is fixed when it is created, so a conversation that does its work in a linked `git worktree` would otherwise keep reporting the main checkout. When exactly one linked worktree of that repository has an open pull request, the badge describes **that worktree** instead — its branch, counts, tree mark and PR/CI token — and names it: `🌳 chore/global-skills-tiering ↑0 ↓2 PR#391 ✓` rather than `● main`. The hover card adds a `checkout` row with the conversation's own directory, so the main checkout's branch and dirty state stay one hover away. One candidate only — two open PRs across worktrees is a reason to say nothing rather than guess — and a session row always reports the checkout that session is working in.
- **Sidebar session-row badges** — each session row carries the same status mark, plus the PR/CI token when the branch has one (`🌳 PR#391 ✓`). The row never names a branch: hovering it adds a line naming the checkout the badge describes (`checkout: hotfix-tree on feat/x`, and for an inferred worktree, why it was followed). Requires the `sidebar.workspaces.sessionRow` seam; without it the plugin degrades to chip-only and logs what's active to the browser console.
- **Nothing on workspace rows.** A workspace cannot know which worktree its conversations are using, so a per-workspace badge could only guess or report the main checkout. The seam is on the session row for that reason.

The leading **mark** is identical on both surfaces: a circle filled with the status colour, or a **tree** when the workspace is a linked `git worktree`. (`●`/`🌳` stand in for it here — it is a drawn SVG so that it can take the theme's status colours.)

Event-driven freshness: working trees are watched and updates push over SSE — badges flip within ~1s of any commit, stage, or edit, including inside a linked worktree that is only inferred. One `git status --porcelain=v2` per sample, shared by every surface pointing at the same checkout, plus at most one `gh` read per repository-and-branch per ~90s and one repository-wide open-PR list per ~90s. The status API takes **no path**: the caller passes a session id (chip and sidebar rows) or a workspace id, and the server resolves the directory itself.

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
