# dsh-git-badge

Git status badges for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):

- **Input-row chip** — `✚ main ↑0 ↓2 ✎3` next to the access picker, showing the git state of the workspace the current conversation is attached to. The leading glyph is the action the node half picked; with no action the chip starts at the branch name. Works on every install.
- **Hover card** — rest a pointer on the chip for what won't fit: the file breakdown (`✎3` split into staged / unstaged / untracked), the last ten commits, and the stash. Fetched only on hover, so the everyday badge pays nothing for it. Works on every install.
- **PR / CI token** — `✚ main ↑0 ↓2 PR#142 ✓` when the branch has a GitHub pull request, read through your own `gh` CLI (the plugin never handles a credential). The token **links to the PR** — it opens in a new tab, and underlines when you hover or focus it. Invisible when `gh` cannot answer: not installed, not logged in, no GitHub remote, offline or rate-limited all render the unchanged chip, and a token with no URL to link to stays plain text.
- **Worktree-aware** — a session can enter a linked `git worktree` or another repository. DSH records the session's working directory (`working_directory` commits the change), and the badge describes **that checkout** — its branch, counts and PR/CI token (`chore/global-skills-tiering ↑0 ↓2 PR#391 ✓` rather than `main`). A compact full-colour tree between the branch name and the sync suffix marks a linked worktree; the hover card names the tree in a `worktree` row and adds an `own checkout` row with the workspace's own directory, so the main checkout's branch and dirty state stay one hover away. The projection is a host fact, so no registration file, TTL or worktree guess is involved. A projection change pushes a refresh over SSE, so the chip follows within about one second. A workspace-targeted row always reports the checkout the registry owns.
- **Sidebar session-row action glyph** — each session row shows the ONE thing that conversation needs from you: `resume`, `resolve`, `sync`, `pull`, `update`, `push`, `merge`, `commit`, `review`, `fix CI`, or `in sync` when there is nothing to do. The node half is the single authority: it ranks the rules and attaches a `rowToken` and its `rowSeverity` to every status response, so the chip, the picker and the row cannot drift. It is triage rather than status: `merge` appears only when GitHub itself reports `mergeStateStatus: CLEAN`, and every waiting state (draft, blocked, checks still running) stays silent. The token renders as a single coloured icon, in the row's 16px leading cell and at the head of the input chip: red for a conflict, a paused operation or a failing build, amber for a requested review, green for `merge`, quiet blue for routine sync, and amber for the `in sync` disc when commits are not yet merged. It appears only when the session is **idle** — while a turn is running upstream shows its own status dots there, because the checkout is still moving and a suggestion would describe a state that is about to change. With nothing to do the node emits `in sync`, so a session is never iconless: a disc in both surfaces, green when the branch is the default branch or its work is merged, amber when commits are not yet merged. The same hover card explains it. Hovering the row opens the row's usual hover card, which renders the action as a label/value row — the icon, the word and the reason (`↑ push — no upstream configured`) — beside the checkout and the pull request. **No patch and no install step:** the glyph rides upstream's own `sidebar.session.row.leading` seat, and the explanation rides `sidebar.session.row.hover`, so both work on a pristine install.
- **Nothing on workspace rows.** A workspace cannot know which worktree its conversations are using, so a per-workspace badge could only guess or report the main checkout. The token is on the session row for that reason.

There is no drawn status mark: the leading **icon** is the node half's action token, and its colour is the severity. The same icon leads the input chip and the session row's 16px cell. Four tokens are drawn arrows, the idle verdict is a drawn disc, and the rest are text glyphs. The card's `worktree` row names a linked checkout.

Event-driven freshness: working trees are watched and updates push over SSE — badges flip within ~1s of any commit, stage, or edit, including inside a linked worktree the session entered. One `git status --porcelain=v2` per sample, shared by every surface pointing at the same checkout, plus at most one `gh` read per repository-and-branch per ~20s. The status API takes **no path**: the caller passes a session id (chip and sidebar rows) or a workspace id, and the server resolves the directory itself.

Diagrams, the hover card's full field list and a walkthrough for git newcomers live
in the [repo README](https://github.com/Kevin-McIsaac/dsh-workspace-git-badge) —
this file is the npm-facing summary.

## Install

```bash
dsh plugin --profile web add dsh-git-badge
```

Restart the web process, refresh the browser. Requires Node ≥ 20, DSH 0.2.1 or newer, and `git` on PATH. `gh`, on PATH and authenticated, is optional — it only enables the PR/CI token.

**No seam patch and no CLI.** The badge reads DSH's own `workingDirectory`
projection, so it follows the checkout a session entered without a registration
step. The `/gh` skill is registered at runtime, not copied into your home.

## Sidebar technical details

Both surfaces ride upstream seats: the status icon on
`sidebar.session.row.leading` (a 16px, idle-only cell), the hover card on
`sidebar.session.row.hover`.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT
