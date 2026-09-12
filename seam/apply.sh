#!/usr/bin/env bash
# Apply / revert the git-badge seam patch + plugin to the installed DSH package.
#
# The patch is SEAM-ONLY (sidebar.workspaces.row / .row.detail slots); all
# badge logic lives in the dsh-git-badge plugin (installed separately into the
# web profile). Safety:
#   - hash-guard: refuses to patch an unrecognized upstream client.js
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

current_hash() { sha256sum "$CLIENT" | cut -d' ' -f1; }

case "${1:?usage: apply.sh apply|revert|status}" in
apply)
	if grep -q '"sidebar.workspaces.row"' "$CLIENT"; then
		echo "seam already present in installed client.js — patch skipped (plugin only)."
	elif [ "$(current_hash)" != "$PRISTINE_HASH" ]; then
		echo "REFUSING: installed client.js hash $(current_hash) does not match the" >&2
		echo "pristine hash this patch was built against ($PRISTINE_HASH)." >&2
		echo "Upstream changed; rebuild the patch before applying." >&2
		exit 1
	else
		cp "$CLIENT" "$HERE/backup-client.js"
		cp "$INDEX" "$HERE/backup-index.js"
		cp "$HERE/patched-client.js" "$CLIENT"
		cp "$HERE/pristine-index.js" "$INDEX"
		echo "applied seam patch. restart the dsh web process to pick it up."
	fi
	echo "now install the plugin:  dsh plugin --profile web add \"$HERE/../dsh-git-badge\""
	;;
revert)
	if [ -f "$HERE/backup-client.js" ]; then
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
	PATCHED_HASH="$(sha256sum "$HERE/patched-client.js" 2>/dev/null | cut -d' ' -f1 || true)"
	if grep -q '"sidebar.workspaces.row"' "$CLIENT"; then SEAM=yes; else SEAM=no; fi

	echo "installed:  $CLIENT"
	echo "hash:       $CUR"
	if [ "$CUR" = "$PRISTINE_HASH" ]; then
		echo "pinned:     $PRISTINE_HASH  <- MATCH (the upstream baseline this patch targets)"
	else
		echo "pinned:     $PRISTINE_HASH  <- differs"
	fi
	if [ -n "$PATCHED_HASH" ]; then
		if [ "$CUR" = "$PATCHED_HASH" ]; then
			echo "patched:    $PATCHED_HASH  <- MATCH (this repo's patched artifact)"
		else
			echo "patched:    $PATCHED_HASH"
		fi
	fi
	if [ -f "$HERE/backup-client.js" ]; then
		echo "backup:     present (revert can restore the pre-patch bytes)"
	else
		echo "backup:     none"
	fi
	echo "seam:       $SEAM"

	if [ "$SEAM" = "yes" ] && [ -n "$PATCHED_HASH" ] && [ "$CUR" = "$PATCHED_HASH" ]; then
		echo "verdict:    PATCHED — sidebar row badges come from this repo's patch."
		exit 0
	elif [ "$SEAM" = "yes" ]; then
		echo "verdict:    SEAM PRESENT, but not this repo's artifact — upstream appears"
		echo "            to declare it. 'apply' correctly no-ops; the patch can be retired."
		exit 0
	elif [ "$CUR" = "$PRISTINE_HASH" ]; then
		echo "verdict:    PRISTINE — the upstream baseline, no seam. 'apply' will patch it."
		exit 0
	else
		echo "verdict:    UNKNOWN BUILD — upstream changed since the pin, and no seam is" >&2
		echo "            present, so the row badge is silently absent. Rebuild:" >&2
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
