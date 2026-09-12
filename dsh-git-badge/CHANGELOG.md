# Changelog

All notable changes to this package are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions before 0.6.0 predate this file; their history is in `git log` and on
npm. 0.6.0 is the first release recorded here.

## [Unreleased]

### Changed

- **The status endpoint no longer accepts a filesystem path.** The caller now says
  *who it is* and the server resolves the workspace itself: `?session=<id>` for the
  input chip, `?workspace=<id>` for a sidebar row. `?path=` is refused with
  `target-required`; unresolvable ids return `session-not-found` or
  `workspace-not-found`. The path was previously caller-chosen (allowlist-bounded
  and read-only, but still chosen by the caller) on a route that answers without
  GUI authentication.
- A session is resolved through the workspace registry first, so a conversation
  that is no longer live still renders a badge. The live session's directory is
  consulted only for the window before a new session is attached to its workspace,
  and the registry still validates it.
- The client half no longer requires the `workspaces` service — declared services
  are now just `["slots"]` — and change notifications carry the workspace id, so
  subscribers match on identity rather than on a path.

### Added

- **A server-side poll fallback for workspaces whose file watcher failed.** A
  workspace whose recursive `fs.watch` could not be established, or which later
  errored, is polled every 5s on a state key (status + refs fingerprint +
  in-progress operation) instead of depending only on the client's 60s fallback.
- `seam/apply.sh status` — reports patched / pristine / upstream-landed / drifted
  by hash, exit 1 on drift with the exact rebuild commands.

### Fixed

- The plugin's `surfaces:` console line reported the boot-time race instead of the
  outcome: it printed `sidebar rows = off (seam absent)` while row badges were
  visibly rendering, because it sampled the seam declaration before the workspace
  browser published it. It now reports from the registration callback, and the
  boot-time line says it is awaiting the seam rather than declaring it missing.

## [0.6.0] - 2026-09-12

### Fixed

- **`✎n` under-counted new files.** Git collapses a new directory into a single
  status entry, so adding a folder of 3 files displayed `✎1`. Untracked files are
  now counted individually. If walking a very large untracked tree exceeds the time
  budget, the badge falls back to the collapsed count and reports which mode
  answered (`untrackedMode`) instead of silently showing a wrong number.

### Added

- **An in-progress operation token.** A paused merge, rebase, cherry-pick, revert,
  bisect or sequencer run now appears after the branch name —
  `🟡 main ⚔rebase ↑0 ↓2 ✎3`. A rebase whose conflicts are already staged has no
  unmerged files, so the three-state dot could not express it. The dot contract
  itself is unchanged, and the token is chip-only.
- **A 41-test node-half suite** (`npm test`) covering the status parser, git
  plumbing against real repositories, request routing, SSE framing and the
  filesystem watcher — runnable without booting DSH.
- **A CI test workflow** running the suite on Node 20/22/24.

### Changed

- Publishing runs through **npm trusted publishing** (OIDC) on a published
  release, gated on the suite, with SLSA provenance — no long-lived token.
- Event stream hardening: `x-accel-buffering: no`, named `change` frames, cleanup
  on disconnect, and an unload disposer that also releases the filesystem watchers.
- `detail=1` is annotated as having no consumer yet (the hover card remains
  pending). Its comment previously claimed `log -1` while the code ran `log -3`.

[Unreleased]: https://github.com/Kevin-McIsaac/dsh-workspace-git-badge/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/Kevin-McIsaac/dsh-workspace-git-badge/releases/tag/v0.6.0
