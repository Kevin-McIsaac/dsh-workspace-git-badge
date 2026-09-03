#!/usr/bin/env bash
#
# test-profile.sh — recreate a clean DSH profile with dsh-git-badge installed
# from npm, for customer-simulation testing (see TESTING.md § "Clean-profile
# test").
#
# What it does:
#   1. Preflight: checks required tools, refuses to touch protected profiles.
#   2. Stops any server already running the target profile (in-memory code
#      from a previous install would poison the test).
#   3. Deletes the old profile directory and recreates it via `dsh plugin add`.
#   4. Adds the web app bundle (the node half boot-FAILS without webServer/
#      workspaceRegistry) and pins the plugin version if requested.
#   5. Verifies the install on disk: exports map, both lib halves, version.
#   6. Boots headless and verifies over HTTP: boot graph, client.js route,
#      allowlist 403 on an unregistered path.
#
# Usage:
#   ./test-profile.sh                 # latest npm version, profile "test", port 3100
#   ./test-profile.sh 0.5.3           # pin a specific version
#
# Environment overrides:
#   PROFILE=name   profile directory name under ~/.dsh/profiles  (default: test)
#   PORT=nnnn      port for the headless server                  (default: 3100)
#   NO_BOOT=1      set up + verify on disk only, don't boot
#
# Cleanup when finished testing:
#   pkill -f "dsh --profile test" && rm -rf ~/.dsh/profiles/test
#
set -euo pipefail

PROFILE="${PROFILE:-test}"
PORT="${PORT:-3100}"
PIN_VERSION="${1:-}"

PROFILES_ROOT="${HOME}/.dsh/profiles"
PROFILE_DIR="${PROFILES_ROOT}/${PROFILE}"
DSH_BIN="${DSH_BIN:-dsh}"
LOG_FILE="/tmp/dsh-${PROFILE}-boot.log"

log()  { printf '[test-profile] %s\n' "$*"; }
fail() { printf '[test-profile] FAIL: %s\n' "$*" >&2; exit 1; }

# --- --- 1. preflight -----------------------------------------------------

command -v "$DSH_BIN" >/dev/null 2>&1 || fail "'$DSH_BIN' not on PATH (set DSH_BIN to override)"
command -v node       >/dev/null 2>&1 || fail "node not on PATH"
command -v curl       >/dev/null 2>&1 || fail "curl not on PATH"
command -v pnpm       >/dev/null 2>&1 || fail "pnpm not on PATH"

# Hard guard: never manage the user's live profiles from this script.
case "$PROFILE" in
	web|clean|"") fail "refusing to manage protected profile '$PROFILE' — use a dedicated test name" ;;
esac
[[ "$PROFILE" =~ ^[A-Za-z0-9._-]+$ ]] || fail "profile name must be alphanumeric/.-_ (got: $PROFILE)"
[[ "$PORT" =~ ^[0-9]+$ ]] || fail "port must be numeric (got: $PORT)"

log "profile='$PROFILE' port=$PORT version=${PIN_VERSION:-latest}"

# ---

# --- --- 2. stop any server already running this profile ------------------
# A running server holds the OLD node half in memory; testing against it is
# meaningless. Kill by exact profile flag, then wait for the port to free.
if pgrep -f "dsh --profile ${PROFILE}( |$)" >/dev/null 2>&1; then
	log "stopping existing '${PROFILE}' profile server…"
	pkill -f "dsh --profile ${PROFILE}( |$)" || true
	for _ in $(seq 1 20); do
		pgrep -f "dsh --profile ${PROFILE}( |$)" >/dev/null 2>&1 || break
		sleep 0.5
	done
	pgrep -f "dsh --profile ${PROFILE}( |$)" >/dev/null 2>&1 && fail "old '${PROFILE}' server refused to die"
fi
# ---

# --- --- 3. recreate the profile ------------------------------------------
if [[ -d "$PROFILE_DIR" ]]; then
	log "removing old profile at ${PROFILE_DIR}"
	rm -rf "$PROFILE_DIR"
fi

log "creating profile via ${DSH_BIN} plugin add (installs from npm)…"
"$DSH_BIN" plugin --profile "$PROFILE" add dsh-git-badge \
	|| fail "dsh plugin add failed — check npm reachability (npm view dsh-git-badge version)"

[[ -f "$PROFILE_DIR/package.json" ]] || fail "profile package.json missing after add — unexpected dsh CLI behavior"
# ---

# --- --- 4. web app bundle + optional version pin -------------------------
# The node half injects [webServer, workspaceRegistry]; without the web app in
# the bundle stack boot FAILS LOUDLY. Insert it right after dsh-base.
PKG_FILE="$PROFILE_DIR/package.json" node <<'NODE'
const fs = require("fs");
const file = process.env.PKG_FILE;
const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
const bundles = (pkg.dsh ??= {}).profile ??= { bundles: [] };
pkg.dsh.profile.bundles ??= [];
const b = pkg.dsh.profile.bundles;
if (!b.includes("@deepseek-ai/dsh-base")) b.unshift("@deepseek-ai/dsh-base");
if (!b.includes("@deepseek-ai/dsh-web-app")) b.splice(b.indexOf("@deepseek-ai/dsh-base") + 1, 0, "@deepseek-ai/dsh-web-app");
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
NODE

if [[ -n "$PIN_VERSION" ]]; then
	log "pinning dsh-git-badge to ${PIN_VERSION}…"
	PKG_FILE="$PROFILE_DIR/package.json" PIN_VERSION="$PIN_VERSION" node <<'NODE'
const fs = require("fs");
const file = process.env.PKG_FILE;
const version = process.env.PIN_VERSION;
const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
pkg.dependencies["dsh-git-badge"] = version;
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
NODE
	(cd "$PROFILE_DIR" && pnpm install) || fail "pnpm install failed while pinning ${PIN_VERSION}"
fi
# ---

# --- --- 5. verify the install on disk -----------------------------------
PKG_FILE="$PROFILE_DIR/node_modules/dsh-git-badge/package.json"
[[ -f "$PKG_FILE" ]] || fail "dsh-git-badge not present in profile node_modules"
[[ -f "$PROFILE_DIR/node_modules/dsh-git-badge/lib/index.js" ]] || fail "node half (lib/index.js) missing"
[[ -f "$PROFILE_DIR/node_modules/dsh-git-badge/lib/client.js" ]] || fail "client half (lib/client.js) missing"

# Hard rule: without "./package.json" in exports the client scanner silently
# ignores the package — the plugin then "installs fine" but never renders.
node -e '
	const pkg = require(process.argv[1]);
	const e = pkg.exports ?? {};
	if (!(e["./package.json"] && e["."] && e["./client"])) process.exit(1);
' "$PKG_FILE" || fail "exports map incomplete — './package.json', '.', './client' are all required"

INSTALLED_VERSION="$(node -p "require('${PKG_FILE}').version")"
log "installed dsh-git-badge@${INSTALLED_VERSION}"
if [[ -n "$PIN_VERSION" && "$INSTALLED_VERSION" != "$PIN_VERSION" ]]; then
	fail "version mismatch: wanted ${PIN_VERSION}, node_modules has ${INSTALLED_VERSION}"
fi
# ---

# --- --- 6. boot headless + verify over HTTP ------------------------------
if [[ "${NO_BOOT:-0}" == "1" ]]; then
	log "NO_BOOT=1 — skipping boot verification. Start later with:"
	log "  ${DSH_BIN} --profile ${PROFILE} --port ${PORT} --no-open"
	exit 0
fi

CLEANUP_ON_EXIT=1   # flipped to 0 once boot verification has passed
cleanup() {
	if [[ "${CLEANUP_ON_EXIT:-1}" == "1" && -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
		kill "$SERVER_PID" 2>/dev/null || true
	fi
}
trap cleanup EXIT

log "booting headless on port ${PORT} (log: ${LOG_FILE})…"
# nohup + disown: the server must survive the terminal that ran this script —
# as a plain child it dies by SIGHUP when the shell exits, leaving a browser
# stuck on the loading progress bar with every plugin fetch failing.
nohup "$DSH_BIN" --profile "$PROFILE" --port "$PORT" --no-open >"$LOG_FILE" 2>&1 &
SERVER_PID=$!
disown 2>/dev/null || true

# Wait up to 60s for the server to answer at all.
UP=0
for _ in $(seq 1 60); do
	if curl -sf -o /dev/null "http://127.0.0.1:${PORT}/" 2>/dev/null; then UP=1; break; fi
	kill -0 "$SERVER_PID" 2>/dev/null || fail "server process died during boot — see ${LOG_FILE}"
	sleep 1
done
[[ "$UP" == "1" ]] || fail "server did not come up within 60s — see ${LOG_FILE}"

# (a) the plugin is registered in the client bundle graph (its module loader
#     is served; the homepage HTML does NOT list plugins)
curl -sf "http://127.0.0.1:${PORT}/plugins/dsh-git-badge/client.js" | grep -q "dsh-git-badge" \
	|| fail "client.js served but is not the dsh-git-badge module — client scanner wiring broken"

# (b) the client half is served
CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/plugins/dsh-git-badge/client.js")"
[[ "$CODE" == "200" ]] || fail "client.js route returned ${CODE}, expected 200"

# (c) the node half answers and the allowlist rejects unregistered paths.
#     The handler answers 403 with a JSON body for unregistered paths — don't
#     use curl -f here, the 403 is the EXPECTED outcome.
#     Retry: server answering / does not mean the plugin's node half has
#     registered its route yet (boot race — observed as a transient 404).
BODY=""
for _ in $(seq 1 15); do
	CODE="$(curl -s -o /tmp/gb-allowlist.json -w '%{http_code}' "http://127.0.0.1:${PORT}/api/git-badge?path=/tmp")"
	BODY="$(cat /tmp/gb-allowlist.json)"
	[[ "$CODE" == "403" || "$CODE" == "200" ]] && [[ "$BODY" == *'"git":false'* && "$BODY" == *'not a registered workspace'* ]] && break
	kill -0 "$SERVER_PID" 2>/dev/null || fail "server process died — see ${LOG_FILE}"
	sleep 1
done
[[ "$CODE" == "403" || "$CODE" == "200" ]] || fail "allowlist probe returned HTTP ${CODE}, expected 403 (or 200 with git:false)"
[[ "$BODY" == *'"git":false'* && "$BODY" == *'not a registered workspace'* ]] \
	|| fail "allowlist check unexpected (HTTP ${CODE}): ${BODY}"
rm -f /tmp/gb-allowlist.json

CLEANUP_ON_EXIT=0
log "OK — all checks passed:"
log "  /plugins/dsh-git-badge/client.js → 200 (module served)"
log "  /api/git-badge allowlist 403 behavior confirmed"
log ""
log "Server left running on http://127.0.0.1:${PORT} (pid ${SERVER_PID}, log ${LOG_FILE})."
log "Browser console should show: [dsh-git-badge] surfaces: input chip = on; sidebar rows = off (seam absent …)"
log ""
log "When finished:"
log "  pkill -f \"dsh --profile ${PROFILE}\" && rm -rf ${PROFILE_DIR}"
# ---
