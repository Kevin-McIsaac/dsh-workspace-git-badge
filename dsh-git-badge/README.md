# dsh-git-badge

Git status badges for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):

- **Input-row chip** — `● main ↑0 ↓2 ✎3` next to the access picker, showing the git state of the workspace the current conversation is attached to. Works on every install.
- **Hover card** — rest a pointer on the chip for what won't fit: the file breakdown (`✎3` split into staged / unstaged / untracked), the last three commits, and the stash. Fetched only on hover, so the everyday badge pays nothing for it. Works on every install.
- **PR / CI token** — `● main ↑0 ↓2 PR#142 ✗` when the branch has a GitHub pull request, read through your own `gh` CLI (the plugin never handles a credential). The token **links to the PR** — it opens in a new tab, and underlines when you hover or focus it. Invisible when `gh` cannot answer: not installed, not logged in, no GitHub remote, offline or rate-limited all render the unchanged chip, and a token with no URL to link to stays plain text.
- **Sidebar row badges** — the same status mark floated to the right of each workspace row (`Project 1   ●`), with a linked worktree's name beside it (`Project 2   hotfix-tree 🌳`). Requires the `sidebar.workspaces.row` seam; without it the plugin degrades to chip-only and logs what's active to the browser console. The hover card and PR token are chip-only, so they never need the seam.

The leading **mark** is identical on both surfaces: a circle filled with the status colour, or a **tree** when the workspace is a linked `git worktree`. (`●`/`🌳` stand in for it here — it is a drawn SVG so that it can take the theme's status colours.)

Event-driven freshness: working trees are watched and updates push over SSE — badges flip within ~1s of any commit, stage, or edit. One `git status --porcelain=v2` call per sample (plus optionally one `gh` call per ~90s, chip only). The status API takes **no path**: the caller passes a session id (chip) or workspace id (row) and the server resolves the directory itself.

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
