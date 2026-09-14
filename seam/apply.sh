#!/usr/bin/env bash
# Apply / revert the git-badge seam patch + plugin to the installed DSH package.
#
# The patch is SEAM-ONLY (sidebar.workspaces.sessionRow / .sessionRow.detail);
# all badge logic lives in the dsh-git-badge plugin (installed separately into the
# web profile).
#
# HOW PATCHING WORKS NOW — anchors, not hashes. The patch is defined once in
# seam/anchors.py as (name, old, new) pairs. `apply` locates each `old` block in
# the INSTALLED client.js (each must occur exactly once) and replaces it in
# place. A DSH update that changes anything else in the file no longer matters;
# only a change that moves one of the anchors does, and the failure names the
# anchor that moved instead of reporting an opaque hash mismatch.
#
# Safety:
#   - anchor assertion: every anchor must match exactly once; anything else is
#     drift and NOTHING is written
#   - own-artifact detection: every artifact carries the dsh-git-badge:seam-patch
#     marker (with a rev number), so our stale patch can be upgraded in place
#     while a genuine upstream landing (seam declared, no marker) is left alone
#   - backup of the bytes as found: revert restores exactly what was installed
#     before WE patched, guarded against downgrading a newer upstream build
#   - the pinned KNOWN_GOOD_HASH is ADVISORY only: status reports whether the
#     installed build is the one the anchors were verified against, but apply
#     proceeds on any build whose anchors resolve
#
# Usage: apply.sh apply | apply.sh revert | apply.sh status
#
# `status` inspects the installed package without touching it and exits 0 for a
# recognised state, 1 for drift — the first thing to run after a DSH update.
set -euo pipefail

DSH="${DSH_INSTALL:-$HOME/.config/nvm/versions/node/v22.23.2/lib/node_modules/@deepseek-ai/dsh}"
PKG="$DSH/node_modules/@deepseek-ai/dsh-client-ui-workspace"
HERE="$(cd "$(dirname "$0")" && pwd)"
CLIENT="$PKG/lib/client.js"
INDEX="$PKG/lib/index.js"
STUB_INDEX="$HERE/stub-index.js"   # no-op host half; copied over index.js on apply

# sha256 of the upstream build the anchors were last verified against. ADVISORY:
# status prints it for orientation; apply does NOT require it.
KNOWN_GOOD_HASH="383b9ef779366c13d818500b6488896328b189f156addbaa480c835e902edd5f"

current_hash() { sha256sum "$CLIENT" 2>/dev/null | cut -d' ' -f1 || echo missing; }

do_patch() {
	# Backup the bytes AS FOUND (both files — this is what revert restores), then
	# patch client.js in place via the anchors and install the no-op host half.
	cp "$CLIENT" "$HERE/backup-client.js"
	cp "$INDEX" "$HERE/backup-index.js"
	python3 - "$HERE" "$CLIENT" <<'PY'
import sys
sys.path.insert(0, sys.argv[1])
import anchors

path = sys.argv[2]
text = open(path, encoding="utf-8").read()
open(path, "w", encoding="utf-8").write(anchors.apply(text))
PY
	cp "$STUB_INDEX" "$INDEX"
	echo "patched lib/client.js in place (anchors applied); host half stubbed."
}

# Inspect the installed client.js and print a machine-ish report:
#   state=<ours-current|ours-stale|upstream-landed|patchable|drift|missing|unreadable>
#   anchor_fail=<name>:<count>   (only when state=drift)
#   hash=<sha256|missing>
#   backup=<yes|no>
inspect() {
	python3 - "$HERE" "$CLIENT" "$HERE/backup-client.js" "$KNOWN_GOOD_HASH" <<'PY'
import sys, os, hashlib
sys.path.insert(0, sys.argv[1])
import anchors

client, backup = sys.argv[2], sys.argv[3]
known_good = sys.argv[4]
try:
    text = open(client, encoding="utf-8").read()
except FileNotFoundError:
    print("state=missing"); sys.exit(0)
except OSError as e:
    print("state=unreadable"); print(f"error={e}"); sys.exit(0)

h = hashlib.sha256(text.encode()).hexdigest()
print(f"hash={h}")
print(f"known_good_match={'yes' if h == known_good else 'no'}")
print(f"backup={'yes' if os.path.exists(backup) else 'no'}")
print(f"marker={'yes' if anchors.is_ours(text) else 'no'}")
print(f"rev_current={'yes' if anchors.is_current_rev(text) else 'no'}")
print(f"seam_strings={'yes' if anchors.seam_present(text) else 'no'}")

fail = anchors.first_failure(text)
if fail is None:
    print("anchors=all-resolve")
else:
    print("anchors=drift")
    print(f"anchor_fail={fail[0]}:{fail[1]}")

if anchors.is_ours(text):
    # A PATCHED file no longer contains the `old` anchor forms — that is the
    # point — so it is verified by its applied signature instead: the seam
    # strings plus the helpers the patch inserts.
    applied = (
        anchors.seam_present(text)
        and "function renderSessionRowSeam" in text
        and "class SeamBoundary" in text
    )
    print(f"applied_signature={'yes' if applied else 'no'}")
    if not anchors.is_current_rev(text):
        print("state=ours-stale")
    elif applied:
        print("state=ours-current")
    else:
        print("state=ours-corrupt")
elif anchors.seam_present(text):
    print("state=upstream-landed")
elif fail is None:
    print("state=patchable")
else:
    print("state=drift")
PY
}

verdict_exit() { # verdict_exit <state> — exit 0 for recognised states
	case "$1" in
	drift|unreadable|missing|ours-corrupt) return 1 ;;
	*) return 0 ;;
	esac
}

report() { # report <readable verdict text...>
	printf '%s\n' "$@"
}

case "${1:?usage: apply.sh apply|revert|status}" in
apply)
	I="$(inspect)"
	STATE="$(sed -n 's/^state=//p' <<<"$I")"
	echo "$I" | grep -v '^state=' | sed 's/^/  /'
	echo "installed:  $CLIENT"
	case "$STATE" in
	ours-current)
		echo "verdict:    PATCHED (rev current) — nothing to do."
		;;
	ours-stale)
		# Our older artifact. The re-patch target is the BACKUP (the bytes as we
		# found them pre-patch). Validate THAT before touching the installed
		# file: restoring a backup whose anchors no longer resolve would overwrite
		# the installed build with an unpatchable older one — the exact
		# blind-overwrite this script exists to prevent.
		if [ ! -f "$HERE/backup-client.js" ]; then
			echo "REFUSING: installed file is an older artifact of ours but no backup" >&2
			echo "exists, so the original bytes are unknown. Reinstall the package or" >&2
			echo "restore seam/backup-client.js by hand, then re-run apply." >&2
			exit 1
		fi
		BSTATE="$(python3 - "$HERE" "$HERE/backup-client.js" <<'PY'
import sys
sys.path.insert(0, sys.argv[1])
import anchors

text = open(sys.argv[2], encoding="utf-8").read()
if anchors.is_ours(text):
    print("ours")
elif anchors.seam_present(text):
    print("upstream-landed")
elif anchors.first_failure(text) is None:
    print("patchable")
else:
    print("drift")
PY
)"
		if [ "$BSTATE" != "patchable" ]; then
			echo "REFUSING: the backup (bytes as found before patching) is '$BSTATE'," >&2
			echo "not patchable — the anchors no longer match the backed-up upstream." >&2
			echo "Nothing was changed. Reinstall the DSH package, then re-run apply." >&2
			exit 1
		fi
		cp "$HERE/backup-client.js" "$CLIENT"
		cp "$HERE/backup-index.js" "$INDEX"
		do_patch
		echo "verdict:    UPGRADED — older artifact replaced with the current patch."
		;;
	patchable)
		do_patch
		echo "verdict:    PATCHED."
		;;
	upstream-landed)
		echo "verdict:    UPSTREAM LANDED — the installed client.js declares the seam" >&2
		echo "and is NOT this repo's artifact. Patch skipped (plugin only); the patch" >&2
		echo "can be retired." >&2
		;;
	drift)
		FAIL="$(sed -n 's/^anchor_fail=//p' <<<"$I")"
		echo "REFUSING: anchor drift — nothing was written." >&2
		echo "  anchor:   ${FAIL%%:*} (found ${FAIL##*:} times, need exactly 1)" >&2
		echo "Upstream changed code this patch anchors on. Update the matching entry" >&2
		echo "in seam/anchors.py, then re-run: seam/apply.sh status && seam/apply.sh apply" >&2
		exit 1
		;;
	ours-corrupt)
		echo "REFUSING: the installed file carries this repo's marker but is neither" >&2
		echo "the current revision nor a restorable state. Inspect by hand:" >&2
		echo "  grep -n 'dsh-git-badge:seam-patch' \"$CLIENT\"" >&2
		exit 1
		;;
	*)
		echo "REFUSING: installed client.js is '$STATE'." >&2
		exit 1
		;;
	esac
	echo "now install the plugin:  dsh plugin --profile web add \"$HERE/../dsh-git-badge\""
	;;
revert)
	if [ -f "$HERE/backup-client.js" ]; then
		I="$(inspect)"
		STATE="$(sed -n 's/^state=//p' <<<"$I")"
		CH="$(sed -n 's/^hash=//p' <<<"$I")"
		BH="$(sha256sum "$HERE/backup-client.js" | cut -d' ' -f1)"
		if [ "$CH" = "$BH" ]; then
			# Idempotent re-run: the installed bytes already ARE the backup.
			echo "already reverted — installed client.js matches the backup; nothing to do."
		else
			case "$STATE" in
			ours-current|ours-stale|ours-corrupt)
				cp "$HERE/backup-client.js" "$CLIENT"
				cp "$HERE/backup-index.js" "$INDEX"
				echo "reverted client.js/index.js to the bytes as found before patching."
				;;
			patchable|drift|upstream-landed)
				# Installed file is not ours => upstream replaced it since patching.
				echo "REFUSING to revert: the installed client.js is not this repo's" >&2
				echo "artifact (state: $STATE), so upstream replaced it since the patch was" >&2
				echo "applied. Restoring the backup would DOWNGRADE the package." >&2
				echo "Nothing was changed. If the downgrade is really what you want, restore" >&2
				echo "seam/backup-client.js by hand." >&2
				exit 1
				;;
			esac
		fi
	else
		I="$(inspect)"
		STATE="$(sed -n 's/^state=//p' <<<"$I")"
		case "$STATE" in
		ours-current|ours-stale|ours-corrupt)
			echo "REFUSING: the installed file is patched but no backup exists, so the" >&2
			echo "original bytes are unknown. Reinstall the package to clear the patch:" >&2
			echo "  npm rebuild -g @deepseek-ai/dsh   # or your package manager's equivalent" >&2
			exit 1
			;;
		*)
			echo "no backup present and nothing of ours installed; client.js left untouched."
			;;
		esac
	fi
	# restore the no-op host half if no backup of the original exists
	if [ ! -f "$HERE/backup-index.js" ]; then
		cp "$STUB_INDEX" "$INDEX"
	fi
	echo "remember to remove the plugin:  dsh plugin --profile web remove dsh-git-badge"
	;;
status)
	I="$(inspect)"
	STATE="$(sed -n 's/^state=//p' <<<"$I")"
	HASH="$(sed -n 's/^hash=//p' <<<"$I")"
	KM="$(sed -n 's/^known_good_match=//p' <<<"$I")"
	BK="$(sed -n 's/^backup=//p' <<<"$I")"
	MK="$(sed -n 's/^marker=//p' <<<"$I")"
	RV="$(sed -n 's/^rev_current=//p' <<<"$I")"
	AP="$(sed -n 's/^applied_signature=//p' <<<"$I")"
	AN="$(sed -n 's/^anchors=//p' <<<"$I")"

	echo "installed:  $CLIENT"
	echo "hash:       $HASH"
	if [ "$KM" = "yes" ]; then
		echo "pinned:     KNOWN-GOOD MATCH — the build the anchors were verified against"
	else
		echo "pinned:     $KNOWN_GOOD_HASH — differs (advisory only; anchors are the guard)"
	fi
	echo "anchors:    $AN"
	[ "$AN" = "drift" ] && sed -n 's/^anchor_fail=/            /p' <<<"$I"
	echo "marker:     $MK (rev current: $RV, applied signature: ${AP:-n/a})"
	echo "backup:     $BK"
	echo "state:      $STATE"

	case "$STATE" in
	ours-current)    echo "verdict:    PATCHED — sidebar session-row badges come from this repo's patch." ;;
	ours-stale)      echo "verdict:    PATCHED, OUT OF DATE — our older artifact; 'apply' upgrades in place." ;;
	ours-corrupt)    echo "verdict:    BROKEN ARTIFACT — marker present but anchors/seam inconsistent. Inspect by hand." ;;
	upstream-landed) echo "verdict:    UPSTREAM LANDED — 'apply' no-ops; the patch can be retired." ;;
	patchable)       echo "verdict:    PATCHABLE — 'apply' will patch it in place." ;;
	drift)           echo "verdict:    DRIFT — an anchor moved; update seam/anchors.py for the new upstream." ;;
	missing)         echo "verdict:    INSTALLED PACKAGE NOT FOUND — check DSH_INSTALL." ;;
	unreadable)      echo "verdict:    UNREADABLE — see error above." ;;
	esac
	verdict_exit "$STATE" || exit 1
	;;
*)
	echo "usage: apply.sh apply|revert|status" >&2
	exit 1
	;;
esac
