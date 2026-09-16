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
dsh plugin --profile web add dsh-git-badge     # marketplace Install does this step
npx dsh-git-badge apply                        # sidebar badges need this one manual step
```

Then **restart the web process** and refresh the browser:

- without the `apply`, the **input chip** works but the sidebar session rows stay off — hover the chip for a reminder;
- `apply` patches the installed DSH package in place (anchor-guarded — it refuses to write anything unless every anchor block matches exactly once). `npx dsh-git-badge status` always tells you which state you are in.
- **Make it automatic**: the package's `postinstall` runs the same guarded apply at install time — but pnpm blocks dependency scripts until you allow them (that boundary belongs to you, not the package). To default it to yes on a machine, allow the package once in the profile:

  ```bash
  cd ~/.dsh/profiles/web && pnpm approve-builds   # pick dsh-git-badge
  # or add to pnpm-workspace.yaml:  allowBuilds: { "dsh-git-badge": true }
  ```

  After that, every later install/upgrade of the plugin applies the seam itself; only the restart stays manual.

Sidebar session-row tokens need a seam the workspace browser does not declare
upstream yet (discussion
[#5092](https://github.com/deepseek-ai/deepseek-harness/discussions/5092)). The
patcher **ships inside the package** — no clone needed:

```bash
npx dsh-git-badge apply     # patch the installed DSH in place, then restart dsh web
npx dsh-git-badge status    # patched / out of date / patchable / upstream-landed / drift
npx dsh-git-badge revert    # restore the bytes as found before patching
```

(If you have this repo cloned, `seam/apply.sh` runs the same tool.)

Notes:

- The patch lives in `node_modules`, so a DSH reinstall/update reverts it —
  re-run the patcher afterwards.
- The patch is **anchor-based** (`seam/anchors.js`): it patches the installed
  file in place and **refuses to write anything** unless every anchor block is
  found exactly once — it never blind-overwrites an update. A DSH release only
  needs work from you if it moved one of the anchored code blocks; `status`
  names the anchor that moved.
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

## Worktrees

A worktree isolates each session to ensure it does not step on another 
sessions work, e.g., change or delete the branch, modify the same file.

### The challenge
A DSH session remembers the directory it was created in and that
value can't be changed. After moving a session to a worktree there is no native method 
for the status badge to identify which worktree the session maps to. This
means the status badge reports the wrong branch, the wrong counts, 
the wrong pull request. 

### The solution
When we switch to a worktree, we create an entry in the register, that
is stored on disk. To ensure this is done properly we use the included
worktree skill

## Requirements

- Node.js ≥ 20, `git` on PATH
- DSH with the `web` profile (any install)
- `gh` on PATH, authenticated, for the PR/CI token and the row's `merge`/`review`
  actions — otherwise those are silently absent and everything else still works

## License

[MIT](LICENSE)
