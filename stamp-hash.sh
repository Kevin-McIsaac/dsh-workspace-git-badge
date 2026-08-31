#!/usr/bin/env bash
# Stamp apply.sh with the sha256 of the workspace's pristine-client.js
# (run after make-patch.sh whenever the patch is rebuilt against a new upstream).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
HASH="$(sha256sum "$HERE/pristine-client.js" | cut -d' ' -f1)"
sed -i "s/^PRISTINE_HASH=.*/PRISTINE_HASH=\"$HASH\"/" "$HERE/apply.sh"
echo "PRISTINE_HASH=$HASH"
