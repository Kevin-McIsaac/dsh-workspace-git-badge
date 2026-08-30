#!/usr/bin/env bash
# Apply / revert the workspace git-badge patch to the installed DSH package.
# Usage: apply.sh apply | apply.sh revert
set -euo pipefail

DSH="${DSH_INSTALL:-$HOME/.config/nvm/versions/node/v22.23.2/lib/node_modules/@deepseek-ai/dsh}"
PKG="$DSH/node_modules/@deepseek-ai/dsh-client-ui-workspace"
HERE="$(cd "$(dirname "$0")" && pwd)"

case "${1:?usage: apply.sh apply|revert}" in
apply)
	cp "$PKG/lib/client.js" "$HERE/backup-client.js"
	cp "$PKG/lib/index.js" "$HERE/backup-index.js"
	cp "$HERE/patched-client.js" "$PKG/lib/client.js"
	cp "$HERE/patched-index.js" "$PKG/lib/index.js"
	echo "applied. restart the dsh web process to pick up the host route; browser bundle updates via /plugins hash change."
	;;
revert)
	[ -f "$HERE/backup-client.js" ] || { echo "no backup present"; exit 1; }
	cp "$HERE/backup-client.js" "$PKG/lib/client.js"
	cp "$HERE/backup-index.js" "$PKG/lib/index.js"
	echo "reverted to backup."
	;;
*)
	echo "usage: apply.sh apply|revert" >&2
	exit 1
	;;
esac
