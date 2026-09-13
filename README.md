# dsh-git-badge

Git status badges for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)

[![tests](https://github.com/Kevin-McIsaac/dsh-workspace-git-badge/actions/workflows/test.yml/badge.svg)](https://github.com/Kevin-McIsaac/dsh-workspace-git-badge/actions/workflows/test.yml)

## Why 

Most agent workflow failures happen quietly: branches drift, uncommitted files are left behind, 
and approved PRs or failed builds sit unnoticed. This plugin brings repository 
awareness directly into your workflow:

1. **At-a-glance session status**: branch, file counts and PR/CI state on the input box. When the session is working in a linked `git worktree`, the badge follows that tree rather than the main checkout.

![Dark-mode input chip: a tree mark with the worktree branch feat/worktree-aware-chip and a passing PR#18, above a main checkout showing sync and file counts and a failing check](docs/images/chip.svg)

2. **Actionable session overview**: pinpoints the session requiring attention (`merge`, `fix CI`, `resolve`) without a context switch.

![Dark-mode sidebar session rows: one asking you to merge in green, one asking you to fix CI in red, and one with nothing to do showing no token](docs/images/session-rows.svg)

Both are updated within seconds of any commit, checkout, stage or file
edit — including inside a linked worktree.


## Install

```bash
dsh plugin --profile web add dsh-git-badge
```

Then restart the web process and refresh the browser. This activates the input
chip on any install.

Sidebar session-row tokens need a seam the workspace browser does not declare
upstream yet (discussion
[#5092](https://github.com/deepseek-ai/deepseek-harness/discussions/5092)). From a
clone of this repo:

```bash
seam/apply.sh apply     # patch the installed DSH (hash-guarded), then restart dsh web
seam/apply.sh revert    # restore pristine at any time
```

Notes:

- The patch lives in `node_modules`, so a DSH reinstall/update reverts it —
  re-run `seam/apply.sh apply` afterwards.
- The hash-guard **refuses** to patch if the installed file doesn't match the
  pinned upstream build (it never blind-overwrites an update). Rebuild the patch
  with `seam/make-patch.sh` + `seam/stamp-hash.sh` after a DSH release changes the
  file.
- Once upstream ships the seam itself, `apply` becomes a no-op and the
  npm-installed plugin picks it up with no changes on your side.

Details, safety rails and the upstream proposal are in [`SEAM.md`](SEAM.md) /
[`PR.md`](PR.md).

## Testing

See [`TESTING.md`](TESTING.md) — clean-profile boot (customer simulation), the
seam apply/revert procedure, and the gotchas list. `cd dsh-git-badge && npm test`
runs the whole suite (parser, real temp repositories, resolution, SSE, the
watcher, every `gh` degradation path and the rendered surfaces) with no DSH, no
network and no restart.

## Requirements

- Node.js ≥ 20, `git` on PATH
- DSH with the `web` profile (any install)
- `gh` on PATH, authenticated, for the PR/CI token and the row's `merge`/`review`
  actions — otherwise those are silently absent and everything else still works

## License

[MIT](LICENSE)
