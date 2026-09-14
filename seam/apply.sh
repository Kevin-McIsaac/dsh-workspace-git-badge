#!/usr/bin/env bash
# Dev wrapper: run the SHIPPED patcher (dsh-git-badge/seam/apply.js) against this
# machine's DSH install, keeping revert backups HERE (in the repo's seam/, which
# is gitignored for backup-*). Equivalent to running the package's
# `dsh-git-badge-seam` bin; this wrapper exists so the documented commands
# (`seam/apply.sh status|apply|revert`) keep working unchanged.
#
# The full safety contract — anchor assertion, marker-rev upgrade path,
# backup-before-overwrite validation, downgrade-guarded idempotent revert — is
# documented in the shipped apply.js and in SEAM.md.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SEAM_DATA_DIR="$HERE" exec node "$HERE/../dsh-git-badge/seam/apply.js" "$@"
