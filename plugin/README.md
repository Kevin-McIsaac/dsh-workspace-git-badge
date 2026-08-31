# dsh-git-badge

Git status badges for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):

- **Input-row chip** — `🟢 main` next to the access picker, showing the git state of the workspace the current conversation is attached to. Works on every install.
- **Sidebar row badges** — full Claude-Code-statusline-style badges (`| 🟡 main ↑0 ↓2 ✎3`) on workspace rows. Requires the `sidebar.workspaces.row` seam; without it the plugin degrades to chip-only and logs what's active to the browser console.

Event-driven freshness: working trees are watched and updates push over SSE — badges flip within ~1s of any commit, stage, or edit. One `git status --porcelain=v2` call per sample; the API only answers registered workspace paths.

## Install

```bash
dsh plugin --profile web add dsh-git-badge
```

Restart the web process, refresh the browser. Requires Node ≥ 20 and `git` on PATH.

Seam details: [github.com/Kevin-McIsaac/dsh-workspace-git-badge](https://github.com/Kevin-McIsaac/dsh-workspace-git-badge) (SEAM.md / PR.md).

## License

MIT
