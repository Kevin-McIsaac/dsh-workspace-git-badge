/**
 * The two READMEs must agree on the claims a user acts on.
 *
 * The package lives in a subdirectory, so npm publishes `dsh-git-badge/README.md`
 * while GitHub renders the repo-root `README.md`. The ROOT IS AUTHORITATIVE: when
 * the two disagree, the root wins and the package copy is corrected. This test
 * fails on drift, instead of leaving the npm page to promise something the repo
 * no longer says.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = readFileSync(join(HERE, "..", "..", "README.md"), "utf8");
const PKG = readFileSync(join(HERE, "..", "README.md"), "utf8");
/** Prose assertions run on the unwrapped text — both files are hard-wrapped. */
const FLAT = (text) => text.replace(/\s+/gu, " ");

/** [what the claim is, how to recognise it] — must appear in BOTH files. */
const CLAIMS = [
	["the install command", /dsh plugin --profile web add dsh-git-badge/],
	["the leading-cell seat", /sidebar\.session\.row\.leading/],
	["the hover-card seat", /sidebar\.session\.row\.hover/],
	["the hover example", /↑ push — no upstream configured/],
	["the no-patch statement", /(no|nothing to) (seam )?patch/i]
];

test("both READMEs state the claims a user acts on", () => {
	for (const [what, pattern] of CLAIMS) {
		assert.match(FLAT(ROOT), pattern, `the root README must state ${what}`);
		assert.match(FLAT(PKG), pattern, `the package README must state ${what}`);
	}
});

test("neither README presents the retired patch as a step to run", () => {
	// The patch is retired. `apply` must not reappear as an instruction — the
	// only patch command a user may be told to run is `revert`.
	for (const [name, text] of [["root", ROOT], ["package", PKG]]) {
		assert.ok(!/npx dsh-git-badge apply/.test(text), `${name} README must not instruct \`apply\``);
		assert.ok(!/dsh-git-badge-seam apply/.test(text), `${name} README must not instruct the seam bin`);
	}
});

test("the package README lists the row token vocabulary", () => {
	// The npm page is the reference a user reads for the row's words.
	const TOKENS = ["resume", "resolve", "sync", "pull", "update", "push", "merge", "commit", "review", "fix CI", "in sync"];
	for (const token of TOKENS) {
		assert.ok(PKG.includes(token), `the package README must list the token ${token}`);
	}
});
