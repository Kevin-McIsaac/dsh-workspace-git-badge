#!/usr/bin/env bash
# Apply / revert the git-badge seam patch + plugin to the installed DSH package.
#
# The patch is SEAM-ONLY (sidebar.workspaces.sessionRow / .sessionRow.detail);
# all badge logic lives in the dsh-git-badge plugin (installed separately into the
# web profile). Safety:
#   - hash-guard: refuses to patch an unrecognized upstream client.js
#   - own-artifact detection: every artifact this script writes carries a marker
#     comment, so a stale patch of ours can be upgraded in place while a genuine
#     upstream landing (which declares the seam but carries no marker) is left
#     alone — the two states used to be indistinguishable, and the old
#     "seam string present" test silently skipped every rebuilt patch
#   - seam detection: if the installed client.js already declares the seam
#     (upstream PR merged), the patch step is a no-op — the plugin keeps working
#
# Usage: apply.sh apply | apply.sh revert | apply.sh status
#
# `status` inspects the installed package without touching it and exits 0 for a
# recognised state, 1 for drift — the first thing to run after a DSH update,
# because a DSH release changes lib/client.js and invalidates the hash-guard.
set -euo pipefail

DSH="${DSH_INSTALL:-$HOME/.config/nvm/versions/node/v22.23.2/lib/node_modules/@deepseek-ai/dsh}"
PKG="$DSH/node_modules/@deepseek-ai/dsh-client-ui-workspace"
HERE="$(cd "$(dirname "$0")" && pwd)"

# sha256 of the known upstream lib/client.js this patch was built against.
PRISTINE_HASH="383b9ef779366c13d818500b6488896328b189f156addbaa480c835e902edd5f"
CLIENT="$PKG/lib/client.js"
INDEX="$PKG/lib/index.js"

# Marker every artifact THIS repo builds carries (see make-patch.sh). It is what
# lets "our stale patch" and "upstream landed the seam" be told apart.
MARKER="dsh-git-badge:seam-patch"

# Artifacts this repo has previously shipped as patched-client.js. Applied over
# an older one of ours is an upgrade, not drift — without these the guard would
# refuse to move from the workspace-row patch to the session-row one.
PREVIOUS_PATCHED_HASHES="d04a97732b9d43507849d8406ed584d6396d1d068647515e491d37b0ff1e2d0d"

current_hash() { sha256sum "$CLIENT" | cut -d' ' -f1; }
artifact_hash() { sha256sum "$1" 2>/dev/null | cut -d' ' -f1 || true; }
has_marker() { grep -q "$MARKER" "$1" 2>/dev/null; }
hash_in() { # hash_in <hash> <space-separated list>
	local needle="$1" haystack="$2" candidate
	for candidate in $haystack; do [ "$needle" = "$candidate" ] && return 0; done
	return 1
}
is_our_artifact() { # is_our_artifact <hash>
	has_marker "$CLIENT" || hash_in "$1" "$PREVIOUS_PATCHED_HASHES"
}

PATCHED_HASH="$(artifact_hash "$HERE/patched-client.js")"

case "${1:?usage: apply.sh apply|revert|status}" in
apply)
	CUR="$(current_hash)"
	if [ "$CUR" = "$PATCHED_HASH" ]; then
		echo "installed client.js is already this repo's current patch — nothing to do."
	elif is_our_artifact "$CUR" || [ "$CUR" = "$PRISTINE_HASH" ]; then
		# The backup is the UPSTREAM baseline, not the bytes being replaced. When the
		# installed file is an older patch of ours, restoring THAT on `revert` would
		# leave the package on a stale seam; `pristine-client.js` is the upstream
		# build this patch targets, and `apply` only ever proceeds when the package
		# is at that baseline or already carries an artifact of ours.
		if [ ! -f "$HERE/backup-client.js" ]; then
			cp "$HERE/pristine-client.js" "$HERE/backup-client.js"
			cp "$HERE/pristine-index.js" "$HERE/backup-index.js"
		fi
		cp "$HERE/patched-client.js" "$CLIENT"
		cp "$HERE/pristine-index.js" "$INDEX"
		echo "applied seam patch. restart the dsh web process to pick it up."
	elif grep -q '"sidebar.workspaces.sessionRow"' "$CLIENT" || grep -q '"sidebar.workspaces.row"' "$CLIENT"; then
		echo "seam already present in installed client.js and it is NOT this repo's"
		echo "artifact — upstream appears to declare it. patch skipped (plugin only)."
	else
		echo "REFUSING: installed client.js hash $CUR is neither the pristine baseline" >&2
		echo "this patch targets, nor an artifact this repo built, nor a file that" >&2
		echo "declares the seam. Upstream changed; rebuild the patch first:" >&2
		echo "  cp \"$CLIENT\" \"$HERE/pristine-client.js\"" >&2
		echo "  cp \"$INDEX\"  \"$HERE/pristine-index.js\"" >&2
		echo "  seam/make-patch.sh && seam/stamp-hash.sh && seam/apply.sh apply" >&2
		exit 1
	fi
	echo "now install the plugin:  dsh plugin --profile web add \"$HERE/../dsh-git-badge\""
	;;
revert)
	# Guard against downgrading an upstream update. `backup-client.js` is the file
	# as it was before WE patched it, so it is the previous upstream build. If a
	# DSH update has since replaced lib/client.js, restoring that backup would
	# overwrite a NEWER upstream file with an older one. Only restore when the
	# installed file is still an artifact of ours (current or previous) or already
	# the backup (the idempotent re-run case).
	if [ -f "$HERE/backup-client.js" ]; then
		CUR="$(current_hash)"
		BACKUP_HASH="$(artifact_hash "$HERE/backup-client.js")"
		if [ "$CUR" != "$PATCHED_HASH" ] && [ "$CUR" != "$BACKUP_HASH" ] && ! is_our_artifact "$CUR"; then
			echo "REFUSING to revert: the installed client.js is neither an artifact this" >&2
			echo "repo built nor the backup, so upstream has replaced it since the patch" >&2
			echo "was applied. Restoring the backup would DOWNGRADE the package." >&2
			echo "  installed: $CUR" >&2
			echo "  patched:   $PATCHED_HASH" >&2
			echo "  backup:    $BACKUP_HASH" >&2
			echo "Nothing was changed. Run 'seam/apply.sh status' to see the state; if the" >&2
			echo "downgrade is really what you want, restore the backup by hand." >&2
			exit 1
		fi
		cp "$HERE/backup-client.js" "$CLIENT"
		cp "$HERE/backup-index.js" "$INDEX"
		echo "reverted client.js/index.js to backup."
	else
		echo "no backup present; client.js left untouched."
	fi
	# restore the upstream no-op index if no backup exists
	if [ ! -f "$HERE/backup-index.js" ]; then
		cp "$HERE/pristine-index.js" "$INDEX"
	fi
	echo "remember to remove the plugin:  dsh plugin --profile web remove dsh-git-badge"
	;;
status)
	# Report, never mutate. Hashes are the only reliable signal: a version
	# string is read from whichever copy is installed and tells you nothing
	# about which bytes they are.
	CUR="$(current_hash)"
	if grep -q '"sidebar.workspaces.sessionRow"' "$CLIENT" || grep -q '"sidebar.workspaces.row"' "$CLIENT"; then SEAM=yes; else SEAM=no; fi

	echo "installed:  $CLIENT"
	echo "hash:       $CUR"
	if [ "$CUR" = "$PRISTINE_HASH" ]; then
		echo "pinned:     $PRISTINE_HASH  <- MATCH (the upstream baseline this patch targets)"
	else
		echo "pinned:     $PRISTINE_HASH  <- differs"
	fi
	if [ "$CUR" = "$PATCHED_HASH" ]; then
		echo "patched:    $PATCHED_HASH  <- MATCH (this repo's patched artifact)"
	else
		echo "patched:    $PATCHED_HASH"
	fi
	BACKUP_HASH=""
	if [ -f "$HERE/backup-client.js" ]; then
		BACKUP_HASH="$(artifact_hash "$HERE/backup-client.js")"
		echo "backup:     present (revert can restore the pre-patch bytes)"
		if [ "$CUR" != "$PATCHED_HASH" ] && [ "$CUR" != "$BACKUP_HASH" ] && ! is_our_artifact "$CUR"; then
			echo "revert:     would REFUSE — the installed file is neither an artifact this"
			echo "            repo built nor the backup, so upstream replaced it since patching."
		fi
	else
		echo "backup:     none"
	fi
	echo "seam:       $SEAM"

	if [ "$CUR" = "$PATCHED_HASH" ]; then
		echo "verdict:    PATCHED — sidebar session-row badges come from this repo's patch."
		exit 0
	elif is_our_artifact "$CUR"; then
		echo "verdict:    PATCHED, OUT OF DATE — an artifact this repo built, but not the"
		echo "            current one. 'apply' upgrades it in place; restart afterwards."
		exit 0
	elif [ "$SEAM" = "yes" ]; then
		echo "verdict:    SEAM PRESENT, but not an artifact of ours — upstream appears to"
		echo "            declare it. 'apply' correctly no-ops; the patch can be retired."
		exit 0
	elif [ "$CUR" = "$PRISTINE_HASH" ]; then
		echo "verdict:    PRISTINE — the upstream baseline, no seam. 'apply' will patch it."
		exit 0
	else
		echo "verdict:    UNKNOWN BUILD — upstream changed since the pin, and no seam is" >&2
		echo "            present, so the badge is silently absent. Rebuild:" >&2
		echo "              cp \"$CLIENT\" \"$HERE/pristine-client.js\"" >&2
		echo "              cp \"$INDEX\"  \"$HERE/pristine-index.js\"" >&2
		echo "              seam/make-patch.sh && seam/stamp-hash.sh && seam/apply.sh apply" >&2
		exit 1
	fi
	;;
*)
	echo "usage: apply.sh apply|revert|status" >&2
	exit 1
	;;
esac
