# dsh-git-badge

Git status badges for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)

[![tests](https://github.com/Kevin-McIsaac/dsh-workspace-git-badge/actions/workflows/test.yml/badge.svg)](https://github.com/Kevin-McIsaac/dsh-workspace-git-badge/actions/workflows/test.yml)

## Why 

Most agent workflow failures happen quietly: branches drift, uncommitted files are left behind, 
and approved PRs or failed builds sit unnoticed. This plugin brings repository 
awareness directly into your workflow:

1. **At-a-glance session status**: branch, file counts and PR/CI state on the input box. When the session is working in a linked [`git worktree`](#Worktrees), the badge follows that tree rather than the main checkout.

![Dark-mode input chip: the action glyph with the worktree branch feat/worktree-aware-chip and a passing PR#18, above a main checkout showing sync and file counts and a failing check](docs/images/chip.svg)

2. **Actionable session overview**: pinpoints the session requiring attention. The session row status icon is extended to show what git actions are needed, e.g., push, merge. The row's hover card lists this icon, the action and the reason (`↑ push — no upstream configured`). The chip leads with the same icon, and a checkout with nothing to do shows an `in sync` disc — green when nothing is outstanding, amber when commits are not yet merged — so a session is never iconless.

![Dark-mode sidebar session rows: a green tick in the leading cell for a merge-ready pull request, a red cross for failing CI, and an in-sync disc when there is nothing to do](docs/images/session-rows.svg)

Both are updated within seconds of any commit, checkout, stage or file
edit — including inside a linked  [worktree](#Worktrees) for safe isolation of parallel dhs working session.

## Install

Use the plugin market place or install manually:

```bash
dsh plugin --profile web add dsh-git-badge     # marketplace Install does this step
```

Then **restart the web process** and refresh the browser. That is the whole
install: every surface rides an upstream slot, so there is nothing to patch and
no second step.


## Sidebar technical details

The status icon renders using the upstream 
`sidebar.session.row.leading` seat — a 16px cell in the row's leading cluster,
rendered only while the session is idle. The hover-card provenance line rides
upstream's own `sidebar.session.row.hover` seat as well. 


## Testing

See [`TESTING.md`](TESTING.md) — clean-profile boot (customer simulation) and the
gotchas list. `cd dsh-git-badge && npm test`
runs the whole suite (parser, real temp repositories, resolution, SSE, the
watcher, every `gh` degradation path and the rendered surfaces) with no DSH, no
network and no restart.

# Worktrees

A worktree isolates each session to ensure it does not step on another 
sessions work, e.g., change or delete the branch, modify the same file.

### The challenge
A session can enter a worktree that is not its original workspace. Without
the session's current directory, the badge would keep reporting the main
checkout: the wrong branch, the wrong counts, the wrong pull request.

### The solution
DSH records the session's working directory. The `working_directory` tool and
the `create_worktree` tool commit the change, and the badge reads that
projection on every request. When the projection changes, the plugin pushes a
refresh over SSE, so the badge follows within about one second. Enter the
worktree with the tool (or `cd`) and the badge follows it. A monochrome tree
between the branch name and the sync suffix marks a linked worktree. No plugin
registration and no file on disk are involved. A workspace-targeted row still reports the checkout the
registry owns.

## Requirements

- Node.js ≥ 20, `git` on PATH
- DSH 0.2.1 or newer with the `web` profile
- `gh` on PATH, authenticated, for the PR/CI token and the row's `merge`/`review`
  actions — otherwise those are silently absent and everything else still works

## License

[MIT](LICENSE)
