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
2. These are drawn for the **dark** theme, which is what the READMEs reference.
   A light variant is a `*-light.*` sibling plus a `<picture>` element in the
   README — worth doing if the repo is read in light mode as often as dark.
3. Show the state, not an empty shell: a dirty tree with counts, an operation
   token, and a PR whose checks are failing read better than "all green".
4. Crop to the surface itself (the chip, the card, the row) — no desktop chrome,
   no conversation content, and nothing that leaks a filesystem path.

| File | Shows |
|---|---|
| `chip.svg` | the input chip from this repo's own session: a linked worktree with a passing PR, above a main checkout with counts and a failing check |
| `session-rows.svg` | sidebar session rows: `merge` (green), `fix CI` (red), and a row with nothing to do |
