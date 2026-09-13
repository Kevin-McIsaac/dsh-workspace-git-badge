# README images

These are **hand-built SVG mockups**, not screenshots — this repo has no way to
drive a browser, so the art is drawn from the real markup, tokens and strings the
plugin renders (same mark geometry, same state colours, same token text).

They are deliberately small, diffable text, which makes them easy to correct when
the UI changes. They are *not* evidence — the suite and `docs/VERIFICATION.md`
are. Treat them as illustrations.

## Replacing them with real captures

1. Keep the filename and the alt text in the README; drop the new bytes in place.
   Nothing else needs editing.
2. Capture with a system in dark mode **and** light mode if you want both; the
   READMEs currently reference one image each, so a second variant needs a
   `*-dark.svg`/`.png` sibling plus a `<picture>` element in the README.
3. Show the state, not an empty shell: a dirty tree with counts, an operation
   token, and a PR whose checks are failing read better than "all green".
4. Crop to the surface itself (the chip, the card, the row) — no desktop chrome,
   no conversation content, and nothing that leaks a filesystem path.

| File | Shows |
|---|---|
| `chip.svg` | the input chip: clean main with a failing PR, a linked worktree, shape/colour channels |
| `session-rows.svg` | sidebar session rows with `fix CI`, `merge`, and a row with nothing to do |
