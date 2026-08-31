# dsh-git-badge

Git status badges for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) workspaces — Claude Code statusline style:

```
the_paragliding_app           | 🟡 main ↑0 ↓2 ✎3
paragliding-site-federation   | 🟢 main
```

## What you get

- **Sidebar row badges** (requires the `sidebar.workspaces.row` seam — see below): emoji (🟢 clean / 🟡 dirty), branch, `↑n`/`↓n` unpushed/unpulled commit counts, and `✎n` uncommitted files. On a dirty worktree both sync counts show including zeros (`↑0 ↓2 ✎3`) so every number is positionally attributable; clean workspaces stay quiet.
- **Input-row chip** (works on every install): compact `🟢 main` next to the access picker, showing the git state of the workspace the current conversation is attached to.
- **Event-driven freshness**: no polling. Each workspace's working tree is watched (`fs.watch`, recursive, 200 ms debounce) and updates push over SSE — badges flip within ~1 second of any commit, checkout, stage, or file edit. A 60s poll backs the SSE stream up in case it dies silently.
- **Cheap and safe**: one `git --no-optional-locks status --porcelain=v2 --branch` per sample; the API only answers paths that are registered Harness workspaces; a git timeout degrades to keeping the last-known badge rather than flashing it away.

## Install

```bash
dsh plugin --profile web add dsh-git-badge
```

Then restart the web process and refresh the browser.

### Sidebar row badges need the seam

The input chip works everywhere. The sidebar row badge additionally requires
the `sidebar.workspaces.row` slot seam in
`@deepseek-ai/dsh-client-ui-workspace` — a 32-line additive patch proposed
upstream (discussion [#5092](https://github.com/deepseek-ai/deepseek-harness/discussions/5092)).
Until it lands, the plugin detects its absence at boot and logs which
surfaces are active to the browser console:

```
[dsh-git-badge] surfaces: input chip = on; sidebar rows = off (seam absent — sidebar badges need the sidebar.workspaces.row seam)
```

Applying the seam patch is described in [`SEAM.md`](SEAM.md).

## Requirements

- Node.js ≥ 20, `git` on PATH
- DSH with the `web` profile (any install)

## License

[MIT](LICENSE)
