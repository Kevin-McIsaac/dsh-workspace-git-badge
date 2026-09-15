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

**Why use them.** A linked `git worktree` gives each piece of work its own
checkout — its own branch, index and working directory, which no other session or
background job can disturb. For an agent this is the strongest isolation
available locally: it can stage, commit, rebase and even break its tree without
touching the checkout you are reading, and several streams of work can proceed in
the same repository at once without fighting over one index.

**The challenge.** A DSH session records the directory it was created in, and that
value is immutable — it stays the main checkout even after the agent moves into
`.wt/<name>`. The badge resolves every session through that directory, so a
conversation doing all of its work in a linked worktree would keep reporting
`main`: the wrong branch, the wrong counts, the wrong pull request. Nothing in the
host can answer "which worktree is this session using?", and an earlier build
tried to infer it from the branch with an open pull request — a guess that was
invisible to the session it was made for and quietly wrong as soon as two trees
were in play, so it was removed rather than kept as a fallback.

**The solution.** The session tells the badge, once, at the moment the checkout
changes. The `git-worktree` skill runs `npx dsh-git-badge-checkout <path>` right
after `git worktree add` and clears it when the tree is removed; `/gh checkout`
does the same when a switch lands in or out of a tree. The registration is keyed
by session, validated against git's own worktree list, and expires after 24
hours, so a stale entry can only fail to resolve — never point the badge at the
wrong directory. **Create worktrees with the worktree skill** for this to work: a
tree made by hand is never registered, and the badge will keep describing the
session's own checkout until you run that command yourself.

## Requirements

- Node.js ≥ 20, `git` on PATH
- DSH with the `web` profile (any install)
- `gh` on PATH, authenticated, for the PR/CI token and the row's `merge`/`review`
  actions — otherwise those are silently absent and everything else still works

## License

[MIT](LICENSE)
