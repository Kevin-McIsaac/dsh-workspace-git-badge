#!/usr/bin/env bash
# Regenerate patched-client.js from pristine-client.js — FOR THE UPSTREAM PR DIFF
# ONLY. The runtime patch is applied by the shipped dsh-git-badge/seam/apply.js
# directly to the installed client.js via the anchors in
# dsh-git-badge/seam/anchors.js; the snapshot files in this directory are not
# load-bearing.
#
# Keep pristine-client.js pinned to the upstream build the anchors were verified
# against (the KNOWN_GOOD_HASH in the shipped apply.js), so `git diff --no-index
# pristine-client.js patched-client.js` produces the exact diff PR.md proposes.
# If upstream moved an anchor, update dsh-git-badge/seam/anchors.js first — this
# script fails loudly on any anchor that is not found exactly once.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
node - "$HERE" <<'JS'
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const here = process.argv[2];
const anchors = await import(pathToFileURL(`${here}/../dsh-git-badge/seam/anchors.js`));
const text = readFileSync(`${here}/pristine-client.js`, "utf8");
const fail = anchors.firstFailure(text);
if (fail !== null) {
	console.error(`anchor ${JSON.stringify(fail.name)} found ${fail.count} times in pristine-client.js (need exactly 1) — update dsh-git-badge/seam/anchors.js`);
	process.exit(1);
}
writeFileSync(`${here}/patched-client.js`, anchors.applyPatch(text));
console.log("patched-client.js regenerated (PR diff only; runtime patching is the shipped apply.js)");
JS
