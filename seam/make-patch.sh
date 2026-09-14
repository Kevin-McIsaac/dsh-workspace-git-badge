#!/usr/bin/env bash
# Regenerate patched-client.js from pristine-client.js — FOR THE UPSTREAM PR DIFF
# ONLY. The runtime patch is applied by apply.sh directly to the installed
# client.js via the anchors in anchors.py; the snapshot files in this directory
# are not load-bearing anymore.
#
# Keep pristine-client.js pinned to the upstream build the anchors were verified
# against (the KNOWN_GOOD_HASH in apply.sh), so `git diff --no-index
# pristine-client.js patched-client.js` produces the exact +39/−3 diff PR.md
# proposes. If upstream moved an anchor, update anchors.py first — this script
# fails loudly on any anchor that is not found exactly once.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
python3 - "$HERE" <<'PY'
import sys
sys.path.insert(0, sys.argv[1])
import anchors

text = open(f"{sys.argv[1]}/pristine-client.js", encoding="utf-8").read()
fail = anchors.first_failure(text)
if fail is not None:
    sys.exit(f"anchor {fail[0]!r} found {fail[1]} times in pristine-client.js (need exactly 1) — update anchors.py")
open(f"{sys.argv[1]}/patched-client.js", "w", encoding="utf-8").write(anchors.apply(text))
print("patched-client.js regenerated (PR diff only; runtime patching is apply.sh + anchors.py)")
PY
