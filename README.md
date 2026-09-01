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
Project 1   | 🟡 main
Project 2   | 🟢 main
```
  </li>
</ul>
Git status is updated within seconds of any commit, checkout, stage, or file edit.

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
