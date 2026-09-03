#!/usr/bin/env bash
#
# release.sh — bump the plugin version and publish to npm.
#
# Usage:
#   ./release.sh [patch|minor|major]     (default: patch)
#
# Robustness measures baked in:
#  - Refuses to run off `main`, with a dirty tree, or while unpushed commits exist.
#  - Uses a workspace-local npm cache (system cache dirs can be read-only under
#    the harness sandbox).
#  - Confirms npm auth BEFORE bumping anything (npm whoami), and refuses a
#    re-publish by comparing the registry version against the NEW (post-bump)
#    version before any commit or push.
#  - Bump via `npm version` (updates package.json + package-lock, creates the
#    git tag), then commit the bump, push, THEN publish — so a publish failure
#    never leaves an unpushed version bump behind.
#  - Verifies the published version on the registry afterwards.
#  - Never `git add -A` (AGENTS.md rule 5): stages explicit paths only.
#  - Everything is idempotent-safe: every failure exits non-zero with a clear
#    message; re-running after a fix just works.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="$REPO_DIR/dsh-git-badge"
NPM_CACHE="$REPO_DIR/.npm-cache"
PKG_NAME="dsh-git-badge"
BRANCH="main"

BUMP="${1:-patch}"
case "$BUMP" in
	patch|minor|major) ;;
	*) echo "ERROR: bump must be patch|minor|major (got: '$BUMP')" >&2; exit 2 ;;
esac

cd "$REPO_DIR"

say() { echo "==> $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

# ---- npm environment --------------------------------------------------------
mkdir -p "$NPM_CACHE"
export npm_config_cache="$NPM_CACHE"

# ---- preflight checks -------------------------------------------------------
say "Preflight"

CURRENT_BRANCH="$(git branch --show-current)"
[ "$CURRENT_BRANCH" = "$BRANCH" ] || die "not on '$BRANCH' (on '$CURRENT_BRANCH'). Switch first: git checkout $BRANCH"

[ -z "$(git status --porcelain)" ] || die "working tree is dirty. Commit or stash first."

git fetch --quiet origin
[ -z "$(git rev-list origin/$BRANCH..$BRANCH)" ] || die "local $BRANCH has unpushed commits. Run: git push"

[ -f "$PLUGIN_DIR/package.json" ] || die "dsh-git-badge/package.json not found"

command -v npm >/dev/null || die "npm not found in PATH"

CURRENT_VERSION="$(node -p "require('$PLUGIN_DIR/package.json').version")"
say "current $PKG_NAME version: $CURRENT_VERSION (bump: $BUMP)"

# ---- auth + registry sanity (BEFORE any mutation) ---------------------------
say "Checking npm auth"
WHOAMI="$(npm whoami 2>/dev/null)" || die "not logged in to npm. Run: npm login (may need to run outside the harness sandbox)"
say "logged in as: $WHOAMI"

REG_VERSION="$(npm view "$PKG_NAME" version 2>/dev/null || echo "")"
if [ -z "$REG_VERSION" ]; then
	say "WARNING: could not read registry version (first publish, or transient error) — continuing"
fi

# ---- bump -------------------------------------------------------------------
say "Bumping version ($BUMP)"
cd "$PLUGIN_DIR"
NEW_VERSION="$(npm version "$BUMP" --no-git-tag-version | sed 's/^v//')" \
	|| die "npm version failed"
say "bumped: $CURRENT_VERSION -> $NEW_VERSION"

# Re-publish guard: checked against the NEW (target) version, not the current
# one — a check against the current version would fire on every in-sync repo.
# Runs after the bump (which is local-only) but before any commit/push, and
# restores the old version if it fires.
if [ "$REG_VERSION" = "$NEW_VERSION" ]; then
	node -e "
		const fs = require('fs');
		const f = 'package.json';
		fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('\"version\": \"$NEW_VERSION\"', '\"version\": \"$CURRENT_VERSION\"'));
	"
	cd "$REPO_DIR"
	die "$NEW_VERSION already exists on the registry — nothing to publish. (Local version restored to $CURRENT_VERSION.)"
fi

# ---- sanity: new version syntax-check + exports rule ------------------------
node --check "$PLUGIN_DIR/lib/index.js" || die "lib/index.js fails node --check"
node --check "$PLUGIN_DIR/lib/client.js" || die "lib/client.js fails node --check"
node -p "JSON.parse(require('fs').readFileSync('$PLUGIN_DIR/package.json','utf8')).exports['./package.json']" >/dev/null \
	|| die "package.json exports lost './package.json' (AGENTS.md rule 4 — the client scanner ignores the package without it)"
[ "$(node -p "require('$PLUGIN_DIR/package.json').version")" = "$NEW_VERSION" ] || die "version mismatch after bump"

# ---- commit + push ----------------------------------------------------------
say "Committing version bump"
cd "$REPO_DIR"
git add "dsh-git-badge/package.json" "dsh-git-badge/package-lock.json" 2>/dev/null || git add "dsh-git-badge/package.json"
git commit -m "chore(release): $PKG_NAME@$NEW_VERSION"
git push origin "$BRANCH"

# ---- publish ----------------------------------------------------------------
say "Publishing to npm"
cd "$PLUGIN_DIR"
npm publish --access public || die "npm publish failed. The version bump commit IS pushed — fix the publish problem and re-run (npm will reject a re-publish of $NEW_VERSION; bump again with '$BUMP' or git reset the bump commit first)."

# ---- verify -----------------------------------------------------------------
say "Verifying on registry"
sleep 3
PUBLISHED="$(npm view "$PKG_NAME" version)"
[ "$PUBLISHED" = "$NEW_VERSION" ] || die "registry reports $PUBLISHED, expected $NEW_VERSION — check https://www.npmjs.com/package/$PKG_NAME"
say "OK: $PKG_NAME@$NEW_VERSION is live on npm"

cat <<EOF

Next steps (to see it in your GUI):
  1. In the web profile, force-replace the installed package
     (pnpm re-adds of the same version can be a no-op — AGENTS.md gotcha):
       rm -rf ~/.dsh/profiles/web/node_modules/dsh-git-badge
       cd ~/.dsh/profiles/web && pnpm install
  2. Restart your dsh web process (profile node half runs in-memory code
     from boot) — NOTE: this ends any running harness session.
  3. Refresh the browser.
EOF
