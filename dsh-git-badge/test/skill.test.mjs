/**
 * The shipped `gh` skill's safety contract.
 *
 * The skill is prose the agent follows, so the suite cannot execute it — but two
 * of its rules are load-bearing enough to pin: the destructive verb must show
 * the dry run first, and it must forbid the flags that widen the blast radius.
 * A skill edit that drops either is a behaviour change, and this is where it
 * fails.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "skill", "gh", "SKILL.md"), "utf8");
/** Prose assertions run on the unwrapped text — the skill is hard-wrapped. */
const FLAT = SKILL.replace(/\s+/gu, " ");

test("/gh clean documents the dry run BEFORE the forced run", () => {
	const dry = SKILL.indexOf("git clean -n");
	const force = SKILL.indexOf("git clean -f");
	assert.notEqual(dry, -1, "the dry run must be documented");
	assert.notEqual(force, -1, "the forced run must be documented");
	assert.ok(dry < force, "the dry run must come first in the verb's steps");
	assert.match(FLAT, /quote its output back verbatim/, "the user approves the LIST, not the idea of cleaning");
});

test("/gh clean forbids the flags that widen the blast radius", () => {
	for (const flag of ["`-x`", "`-d`", "bare `git clean -f`"]) {
		assert.ok(FLAT.includes(flag), `the skill must name ${flag} as forbidden`);
	}
	assert.match(FLAT, /no reflog and no stash entry/, "and say why: untracked files are unrecoverable");
});

test("the hard rules tie the dry run to the clean verb", () => {
	assert.match(FLAT, /`\/gh clean`'s dry run and verbatim quote come before any `git clean -f`/);
});
