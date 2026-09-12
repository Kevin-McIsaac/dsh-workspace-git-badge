# dsh-git-badge

Git status badges for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)

`🟡 main ↑0 ↓2 ✎3`

## What you get

The Git status badge for a project in the: 
<ul>
  <li>
  input box after the access picker.

  <img  alt="image" src="https://github.com/user-attachments/assets/a5a9a405-a515-491f-a21a-e53d7e52eca1" />
  </li>

<li>
  workspace after each project name. (May require the seam patch to enable)

```
Project 1   | 🌳
Project 2   | 🌳 ⑂hotfix-tree
```

  The row shows a **status tree** (the crown is filled with the status colour)
  and, for a linked worktree, the worktree's name. The branch is deliberately not
  repeated here — the input chip is the surface that names it.
  </li>
</ul>
Git status is updated within seconds of any commit, checkout, stage, or file edit — including inside a linked worktree.

## Status colours

One three-state summary drives both the chip's dot and the sidebar row's tree
crown (checked top-down, first match wins). The tree is drawn as an SVG rather
than typed as an emoji precisely so its crown can take these theme colours —
🌳 is a colour emoji and cannot be tinted.

| Colour | When | What to do |
|--------|------|------------|
| 🔴 red | Unmerged files (merge/rebase conflict in progress), **or** a dirty tree that is also behind upstream | Resolve conflicts, or commit your edits before pulling |
| 🟡 yellow | Dirty files, or any ahead/behind (sync pending) | Commit (✎), push (↑), or pull (↓) when convenient |
| 🟢 green | Clean and in sync with the upstream | Nothing |

Red never means merely "behind" — a clean tree one commit behind is a normal
between-pulls state. See [`docs/badge-explainer.md`](docs/badge-explainer.md)
for a beginner-friendly walkthrough.

## Suffix tokens

The input chip can carry an operation token after the branch name when git is
mid-operation:

```
🟡 main ⚔rebase ↑0 ↓2 ✎3
```

The token names what git is waiting on: `⚔merge`, `⚔squash`, `⚔cherry-pick`,
`⚔revert`, `⚔bisect`, `⚔rebase`, `⚔sequencer`.

It is independent of the dot. A paused rebase whose conflicts are all already
staged has **no unmerged files**, so the dot can be green while `⚔rebase` is
showing — the token is the only signal that history is mid-rewrite. Tokens
appear on the input chip only.

## Worktrees

When the workspace is a linked `git worktree`, the chip says which checkout the
conversation is in — several worktrees of one repository otherwise all render the
same `🟡 main`:

```
🟡 main ⑂hotfix-tree ↑0 ↓2 ✎3
```

`⑂` marks a linked worktree and the name after it is the checkout's directory
name. The name is dropped when the branch already implies it (a `repo-feat-x`
directory on branch `feat-x` shows a bare `⑂`), and a main checkout carries no
token at all — so the everyday chip is unchanged. Like the operation token, this
is chip-only; a sidebar row instead names the worktree after its status tree
(`🌳 ⑂hotfix-tree`) and shows no branch.

## Install

```bash
dsh plugin --profile web add dsh-git-badge
```

Then restart the web process and refresh the browser. This will activate the input status chip. 

Sidebar row badges need the proposed new workspace seam. If this is not available apply the patch 
(discussion [#5092](https://github.com/deepseek-ai/deepseek-harness/discussions/5092)).

From a clone of this repo:

```bash
seam/apply.sh apply     # patch the installed DSH (hash-guarded), then restart dsh web
seam/apply.sh revert    # restore pristine at any time
```

Notes:

- The patch lives in `node_modules`, so a DSH reinstall/update reverts it —
  re-run `seam/apply.sh apply` afterwards.
- The hash-guard **refuses** to patch if the installed file doesn't match the
  pinned upstream build (it never blind-overwrites an update). Rebuild the
  patch with `seam/make-patch.sh` + `seam/stamp-hash.sh` after a DSH release changes
  the file.
- Once upstream ships the seam itself, `apply` becomes a no-op and the
  npm-installed plugin picks it up with no changes on your side.

Details, safety rails, and the upstream proposal are in
[`SEAM.md`](SEAM.md) / [`PR.md`](PR.md).

## Testing

See [`TESTING.md`](TESTING.md) — clean-profile boot (customer simulation),
seam apply/revert procedure, and the gotchas list.

## Requirements

- Node.js ≥ 20, `git` on PATH
- DSH with the `web` profile (any install)

## License

[MIT](LICENSE)
