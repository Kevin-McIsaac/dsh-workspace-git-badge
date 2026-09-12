# Testing dsh-git-badge

Verified procedures from development. Read this before testing changes.

## Node tests (no DSH, no restart)

```bash
cd dsh-git-badge && npm test      # node --test, no dependencies
```

Run this first for **any** node-half change. It verifies the status parser,
`gitStatus` against real temporary repositories, the workspace allowlist, SSE
framing and the fs watcher without booting DSH — so it costs no restart and
cannot end your session. CI runs the same command on Node 20/22/24
(`.github/workflows/test.yml`).

Layout:

- `dsh-git-badge/test/*.test.mjs` — the suite.
- `dsh-git-badge/test-support/` — `harness.mjs` (fake cordis ctx, fake req/res,
  SSE frame parsing) and `repo.mjs` (throwaway git repositories). Deliberately
  outside `test/`, so `node --test` discovers exactly the suite.

House rules for extending it: keep helpers out of `test/`; release every watcher
and SSE stream in `t.after` (an open handle keeps the process alive and hangs the
run); poll to a deadline rather than asserting on a fixed sleep, because fs.watch
delivery plus the debounce window are not deterministic; and never race a real
millisecond timeout — `config.gitRunner` exists so the collapsed-status fallback
can be forced deterministically.

Pattern credit: the fake-ctx / fake-stream / temp-repo shape is adapted from
`@wongzexu/dsh-git-status` (MIT).

## Layers to test

The feature has three independently testable layers:

1. **Node half** (`dsh-git-badge/lib/index.js`) — pure functions and git plumbing;
   covered by the suite above without booting DSH. A restart is only needed to see
   the change live.
2. **Published plugin** (`dsh-git-badge` from npm) — the customer experience;
   test in a **clean profile**.
3. **Seam patch** (`seam/apply.sh`) — the sidebar rows; only meaningful on
   top of a working plugin install.

## Clean-profile test (customer simulation)

**Automated**: `./test-profile.sh [version]` performs the whole procedure —
removes the old profile, stops any server running it, installs from npm
(optionally pinned to `[version]`), adds the web bundle, verifies the exports
map and both lib halves on disk, boots headless, then verifies the plugin is in
the composed **client** graph and that its advertised bundle is served, plus
the allowlist 403. Leaves the server running and prints the cleanup command.

Env overrides:

| Var | Effect |
|---|---|
| `PROFILE=` | profile name under `$DSH_HOME/profiles` (default `test`) |
| `PORT=` | headless port (default 3100) |
| `NO_BOOT=1` | set up + verify on disk only |
| `PLUGIN_SOURCE=<path>` | install the **working tree** instead of npm — the only way to exercise unreleased code |
| `PROFILES_ROOT=` | override `$DSH_HOME/profiles` |

`DSH_HOME` is honored by the harness (`$DSH_HOME` > `~/.dsh`), so
`PROFILES_ROOT` must name wherever the `dsh` CLI actually installs.

**Version resolution is not "newest".** An unpinned run has been observed
installing `0.5.5` while `0.6.0` was `latest`, so always read the script's
`installed dsh-git-badge@x.y.z` line, and pass an explicit version when testing
a freshly published release.

Manual procedure (what the script automates), for reference:

A DSH profile is just a bundle stack under `$DSH_HOME/profiles/<name>`:
`package.json` → `dsh.profile.bundles` plus its own config. Fresh profiles
boot **headless** by default — the plugin's node half waits for
`webServer`/`workspaceRegistry` and boot FAILS LOUDLY until the web app is
in the stack:

```bash
dsh plugin --profile test add dsh-git-badge   # creates the profile, installs from npm
# working tree instead: dsh plugin --profile test add /path/to/dsh-git-badge
# add the web app to dsh.profile.bundles in the profile's package.json
# (insert "@deepseek-ai/dsh-web-app" after "@deepseek-ai/dsh-base";
#  `dsh plugin add` may fail on it — edit the JSON directly)
dsh --profile test --port 3100 --no-open      # NOTE: `dsh web` hardcodes the web profile
```

Verifying over HTTP has two traps. The **shell is auth-gated** (an
unauthenticated `/` returns no 2xx, so `curl -f` reports a healthy server as
dead), and **`/plugins/<id>/client.js` is not a route**: the client-modules
host serves only the exact rev-pinned URLs it advertises in the boot payload,
so every other shape is 404 by design. Take the token the server printed into
its boot log, then read the advertised URL out of `window.__DSH_BOOT__`:

```bash
TOKEN=$(grep -oE 'token=[A-Za-z0-9_-]+' /tmp/dsh-test-boot.log | head -1 | cut -d= -f2)
curl -sL -c /tmp/jar -b /tmp/jar "http://127.0.0.1:3100/?token=$TOKEN" \
  | grep -o '"id":"dsh-git-badge"[^}]*'   # {"id":"dsh-git-badge","url":"/plugins/??dsh-git-badge/client.js&rev=…"}
# fetch that advertised url with the same cookie jar → 200 and the module body

# node half, unauthenticated on purpose — the 403 IS the expected result:
curl -s "http://127.0.0.1:3100/api/git-badge?path=/tmp"
#   → 403 {"git":false,"error":"path is not a registered workspace"}
```

`test-profile.sh` does exactly this — prefer it over retyping.

Then in a browser: no sidebar badges (no seam in a clean profile), input chip
present, console shows
`[dsh-git-badge] surfaces: input chip = on; sidebar rows = off (seam absent …)`.
Open the URL the server printed (the one carrying `?token=`) — a bare
`http://127.0.0.1:3100` will not authenticate.

Clean up: stop the server and delete the profile directory; `test-profile.sh`
prints both commands with the real paths.

## Seam-patched test (full badges)

```bash
seam/apply.sh apply     # hash-guarded; refuses unknown upstream builds
seam/apply.sh revert    # restore pristine
```

After apply, **restart the dsh web process** — the workspace bundle URL
carries a `?rev=` hash that only changes at boot, so a browser refresh alone
can keep serving stale JS (and the composed boot graph is what the browser
trusts). If the UI looks stale after a patch change: restart, THEN
hard-refresh. DevTools console confirms which code is live via the
`[dsh-git-badge] surfaces:` line.

## What "verified" means per change

- **Node half changed** → run `npm test` first; a restart is then only needed to
  see it live (the suite already covers the parser, `gitStatus` against real
  repos, the allowlist, SSE and the watcher).
- **Client half only** → usually a browser refresh suffices; after patch or
  bundle-graph changes, restart first (see above).

## Publishing a new version

Publishing runs in CI with **npm trusted publishing** (OIDC) — no token, no
interactive 2FA OTP. `.github/workflows/publish.yml` fires on a published GitHub
release, re-runs `npm test`, then publishes with `--provenance`.

One-time setup, on npmjs.com (package owner only):

> package `dsh-git-badge` → **Settings** → **Trusted Publisher** →
> **GitHub Actions** → Organization/user `Kevin-McIsaac`, Repository
> `dsh-workspace-git-badge`, Workflow filename `publish.yml`.

Then, per release:

1. Land the change on `main` with the new version already in
   `dsh-git-badge/package.json` (`npm version patch|minor` inside
   `dsh-git-badge/`). npm publishes the version in that file, so it must be
   committed **before** the release is cut.
2. Cut a GitHub release (tag `vX.Y.Z`). Publishing runs itself; watch the Actions
   run — it fails before publishing if the suite is red.
3. Update the profile(s) and restart. A plain `pnpm install` will **not** move
   past the lockfile pin (it re-installs the pinned version), and
   `rm -rf node_modules/dsh-git-badge` followed by `pnpm install` can no-op on
   a stale `node_modules/.modules.yaml` — update explicitly instead:

   ```bash
   cd ~/.dsh/profiles/<name> && pnpm update dsh-git-badge
   # fallback if that does not take:
   pnpm install --force
   ```

   Then **restart the dsh web process** (node-half rule) and hard-refresh.

### Fallback: publishing by hand

Only if CI is unavailable. The account has 2FA "Authorization and writes", so
this prompts for an authenticator OTP and must run **in your own terminal, not an
agent sandbox**:

```bash
cd dsh-git-badge && npm publish
```

npm masks a dead/missing token as `404 Not Found` on PUT and `EOTP` otherwise —
check `npm whoami` first if it fails. Do NOT mint a 2FA-bypass granular token:
npm deprecated bypass-2FA GATs in July 2026
(https://github.blog/changelog/2026-07-31-restricting-npm-bypass-2fa-granular-access-tokens/).
