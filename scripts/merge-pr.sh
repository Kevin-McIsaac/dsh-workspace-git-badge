#!/usr/bin/env bash
#
# merge-pr.sh — merge a pull request and leave local `main` ACTUALLY in sync.
#
# Usage:
#   ./scripts/merge-pr.sh <pr-number>
#
# Why this exists — the exact bug it prevents.
#
# `gh pr merge` fetches, then fast-forwards local `main` itself. Both of those are
# compare-and-swap updates to `refs/remotes/origin/main`, and this plugin runs its
# own `git fetch --quiet --no-tags --prune` on a ~60s TTL in any open workspace
# that has an upstream — including this repo. When the plugin's fetch lands
# between gh's read and gh's write, gh's update fails:
#
#   error: cannot lock ref 'refs/remotes/origin/main': is at <new> but expected <old>
#   ! warning: not possible to fast-forward to: "main"
#
# The merge SUCCEEDS on GitHub, but local `main` is left behind, and gh reports it
# as a warning rather than a failure. That is the dangerous part: under a `link:`
# install the running plugin is served straight from this working tree, so a
# lagging `main` is not a stale checkout — it is the live plugin silently losing
# whatever the merge added. That happened on PR #14 (see the reflog for
# origin/main: the winning write was `fetch --quiet --no-tags --prune`).
#
# So this script removes one of the two writers and verifies the outcome:
#   1. merge through the API, which never touches local refs;
#   2. fetch and fast-forward EXPLICITLY;
#   3. assert local `main` == `origin/main`, and fail loudly if it is not.
#
# Robustness:
#  - Idempotent: re-running after a successful merge just re-syncs and verifies,
#    so it is safe to run "again" to check whether anything was left behind.
#  - Refuses to sync from a non-`main` branch or a dirty tree, so the fast-forward
#    target is never ambiguous and nothing local can be clobbered.
#  - Every failure exits non-zero with a clear message. AGENTS.md rule 1: do not
#    ask for a restart until step 3 has passed.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="main"
# This repo merges with true merge commits (see past `Merge pull request #N`),
# not squash or rebase. Change only if that convention changes.
MERGE_METHOD="merge"

PR="${1:-}"
if [ -z "$PR" ]; then
	echo "usage: scripts/merge-pr.sh <pr-number>" >&2
	exit 2
fi
case "$PR" in
	''|*[!0-9]*) echo "ERROR: PR number must be numeric (got: '$PR')" >&2; exit 2 ;;
esac

cd "$REPO_DIR"
say() { echo "==> $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

command -v gh >/dev/null || die "gh not found in PATH"

# ---- preflight: the sync target must be unambiguous -------------------------
CURRENT_BRANCH="$(git branch --show-current)"
[ "$CURRENT_BRANCH" = "$BRANCH" ] || die "not on '$BRANCH' (on '$CURRENT_BRANCH'). Switch first: git checkout $BRANCH"
# --untracked-files=no on purpose: a fast-forward cannot clobber an untracked file
# (git refuses outright if it would overwrite one), so an untracked scratch file
# must not block the sync. Only uncommitted changes to TRACKED files can be lost.
[ -z "$(git status --porcelain --untracked-files=no)" ] || die "working tree has uncommitted changes to tracked files. Commit or stash first — this script only fast-forwards."

# ---- read the PR ------------------------------------------------------------
say "Reading PR #$PR"
PR_JSON="$(gh pr view "$PR" --json state,headRefName,title,mergeCommit 2>/dev/null)" \
	|| die "cannot read PR #$PR (wrong number, or gh cannot reach the remote)"
STATE="$(printf '%s' "$PR_JSON" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).state")"
HEAD_REF="$(printf '%s' "$PR_JSON" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).headRefName")"
TITLE="$(printf '%s' "$PR_JSON" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).title")"
say "#$PR \"$TITLE\" is $STATE (branch: $HEAD_REF)"

# ---- 1. merge through the API (never touches local refs) --------------------
if [ "$STATE" = "MERGED" ]; then
	say "Already merged — skipping the merge call (idempotent re-run)."
else
	say "Merging via the API with method '$MERGE_METHOD'"
	# A 405 (not mergeable), 409 (head moved) or 403 (protection) surfaces here and
	# is the answer worth reporting; gh prints the API's own message.
	gh api -X PUT "repos/{owner}/{repo}/pulls/$PR/merge" -f merge_method="$MERGE_METHOD" >/dev/null \
		|| die "the merge API refused PR #$PR — read the API message above (not mergeable, head moved, or blocked)"
	STATE="$(gh pr view "$PR" --json state -q .state)"
	[ "$STATE" = "MERGED" ] || die "merge reported no error but PR #$PR is '$STATE' — refusing to continue"
	say "Merged on the remote."
fi

# ---- 2. delete the remote head branch --------------------------------------
# Guard the default branch: deleting `main` would be catastrophic and this runs
# unattended. A branch already gone (a re-run, or `deleteBranchOnMerge`) is fine.
if [ "$HEAD_REF" = "$BRANCH" ]; then
	say "Head branch IS '$BRANCH' — not deleting it."
elif gh api -X DELETE "repos/{owner}/{repo}/git/refs/heads/$HEAD_REF" >/dev/null 2>&1; then
	say "Deleted remote branch '$HEAD_REF'."
else
	say "Remote branch '$HEAD_REF' already gone (or protected) — continuing."
fi

# ---- 3. fetch, fast-forward, and PROVE local main caught up ----------------
say "Fetching and fast-forwarding local '$BRANCH'"
git fetch --quiet --prune origin
git merge --ff-only "origin/$BRANCH" >/dev/null || die "cannot fast-forward '$BRANCH' to origin/$BRANCH — local commits or a divergence need a human"

LOCAL_SHA="$(git rev-parse "$BRANCH")"
REMOTE_SHA="$(git rev-parse "origin/$BRANCH")"
if [ "$LOCAL_SHA" != "$REMOTE_SHA" ]; then
	die "$BRANCH is STILL behind origin/$BRANCH ($LOCAL_SHA != $REMOTE_SHA). Do NOT restart dsh web — a link: install would serve stale code."
fi

say "OK — $BRANCH == origin/$BRANCH at $LOCAL_SHA"
say "Safe to restart dsh web now."
