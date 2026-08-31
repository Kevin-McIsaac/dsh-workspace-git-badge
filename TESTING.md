# Testing dsh-git-badge

Verified procedures from development. Read this before testing changes.

## Layers to test

The feature has three independently testable layers:

1. **Node half** (`plugin/lib/index.js`) — pure functions and git plumbing;
   test without booting DSH (see "Parser/e2e tests" below).
2. **Published plugin** (`dsh-git-badge` from npm) — the customer experience;
   test in a **clean profile**.
3. **Seam patch** (`seam/apply.sh`) — the sidebar rows; only meaningful on
   top of a working plugin install.

## Clean-profile test (customer simulation)

A DSH profile is just a bundle stack under `~/.dsh/profiles/<name>`:
`package.json` → `dsh.profile.bundles` plus its own config. Fresh profiles
boot **headless** by default — the plugin's node half waits for
`webServer`/`workspaceRegistry` and boot FAILS LOUDLY until the web app is
in the stack:

```bash
dsh plugin --profile test add dsh-git-badge   # creates the profile, installs from npm
# add the web app to dsh.profile.bundles in ~/.dsh/profiles/test/package.json
# (insert "@deepseek-ai/dsh-web-app" after "@deepseek-ai/dsh-base";
#  `dsh plugin add` may fail on it — edit the JSON directly)
dsh --profile test --port 3100 --no-open      # NOTE: `dsh web` hardcodes the web profile
```

Verify server-side:

```bash
curl -s http://127.0.0.1:3100/ | grep -o 'dsh-git-badge[^"]*'      # in boot graph
curl -s "http://127.0.0.1:3100/api/git-badge?path=/tmp"            # → {"git":false,"error":"path is not a registered workspace"}
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3100/plugins/dsh-git-badge/client.js  # 200
```

Then in a browser: no sidebar badges (no seam in a clean profile), input chip
present, console shows
`[dsh-git-badge] surfaces: input chip = on; sidebar rows = off (seam absent …)`.

Clean up: stop the server, delete `~/.dsh/profiles/test`.

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

- **Node half changed** → restart required; test parser/gitStatus against a
  real repo (staged/unstaged/untracked, stash, detached HEAD, no-upstream).
- **Client half only** → usually a browser refresh suffices; after patch or
  bundle-graph changes, restart first (see above).

## Known gotchas (each cost us a debugging session once)

- **Hover-card paths are abbreviated** (`~/...` display strings). Any seam
  entry that fetches must get the RAW path (`row.cwd`), not the hover card's
  display path — abbreviated paths 403 on the registry allowlist.
- **`git --no-optional-locks` is a global flag** — it goes BEFORE the
  subcommand.
- **The `exports` map in plugin/package.json must include `"./package.json"`**
  or the client-module scanner silently ignores the package (no error).
- **SSE must flush immediately** — write `": connected\n\n"` right after
  headers or clients see a dead stream until the first heartbeat.
- **Stage explicit paths in git, never `git add -A`** — a test artifact
  (`touch newfile.txt`) once rode a commit and forced a history rewrite.

## Parser / e2e tests without booting

Evaluate the extracted watcher region and helpers via `new Function` against
a temp git repo (staged + unstaged + untracked + stash), e.g. see the
`gitStatus` region in `plugin/lib/index.js` (`//#region git-state watcher`).
Keep such a scratch script in `/tmp` — do not commit test repos.
