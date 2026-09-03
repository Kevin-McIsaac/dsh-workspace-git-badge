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
# Usage: apply.sh apply | apply.sh revert
set -euo pipefail

DSH="${DSH_INSTALL:-$HOME/.config/nvm/versions/node/v22.23.2/lib/node_modules/@deepseek-ai/dsh}"
PKG="$DSH/node_modules/@deepseek-ai/dsh-client-ui-workspace"
HERE="$(cd "$(dirname "$0")" && pwd)"

# sha256 of the known upstream lib/client.js this patch was built against.
PRISTINE_HASH="75d8a09a43a820e0ff8470e7b9c87b6dced523764ee650a8382317f6ef7a314b"
CLIENT="$PKG/lib/client.js"
INDEX="$PKG/lib/index.js"

current_hash() { sha256sum "$CLIENT" | cut -d' ' -f1; }

case "${1:?usage: apply.sh apply|revert}" in
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
*)
	echo "usage: apply.sh apply|revert" >&2
	exit 1
	;;
esac
