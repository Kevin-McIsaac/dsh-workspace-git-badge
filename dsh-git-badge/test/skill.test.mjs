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
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeCtx } from "../test-support/harness.mjs";

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

test("/gh order and /gh next name the new row-only categories", () => {
	// `conflict` and `review` are ROW-ONLY: no `/gh` verb covers them, so the
	// skill must order them AND must not promise a command for them.
	assert.match(FLAT, /`conflict`/, "the order list names conflict");
	assert.match(FLAT, /`review`/, "the order list names review");
	assert.match(FLAT, /`CHANGES_REQUESTED`/, "/gh next names the changes-requested case");
	assert.match(FLAT, /`REVIEW_REQUIRED`/, "/gh next names the review-required case");
	assert.match(FLAT, /do not invent a command for it/, "and says there is no verb");
});

// ---------------------------------------------------------------------------
// the menu entry (client half): /gh clean appears only with untracked files,
// last, and carrying the host's risk gate
// ---------------------------------------------------------------------------

test("the server offers clean only with untracked files, and last", async () => {
	// the rules moved into the node half with the action list (the client renders
	// it verbatim now), so this drives nextActions directly
	const { nextActions } = await import("../lib/index.js");
	const base = { git: true, branch: "feat/x", upstream: "origin/feat/x", ahead: 0, behind: 0, dirty: false, stagedFiles: 0, unstagedFiles: 0, untrackedFiles: 0 };
	const without = nextActions({ ...base, untrackedFiles: 0 });
	assert.equal(without.actions.some((a) => a.args === "clean"), false, "nothing to clean, nothing offered");
	const withFiles = nextActions({ ...base, stagedFiles: 1, untrackedFiles: 2 });
	assert.equal(withFiles.actions[withFiles.actions.length - 1].args, "clean", "offered last");
	assert.equal(withFiles.actions[0].args, "commit", "and never the primary suggestion");
	const entry = withFiles.actions[withFiles.actions.length - 1];
	assert.equal(entry.danger, true, "flagged so the picker attaches the gate");
	assert.match(entry.what, /asks first/);
});

test("the server never suggests a pull request FROM the default branch", async () => {
	const { nextActions } = await import("../lib/index.js");
	const cleanMain = {
		git: true, branch: "main", upstream: "origin/main", ahead: 0, behind: 0,
		dirty: false, stagedFiles: 0, unstagedFiles: 0, untrackedFiles: 0, defaultBranch: true
	};
	assert.deepEqual(nextActions(cleanMain).actions, [], "clean main has nothing to offer");
	assert.equal(nextActions(cleanMain).next, null, "and no primary suggestion");
	// the same state on a FEATURE branch is the case the entry exists for
	const cleanFeature = { ...cleanMain, branch: "feat/x", upstream: "origin/feat/x", defaultBranch: false };
	assert.equal(nextActions(cleanFeature).actions[0].args, "pr");
});

test("the client renders the server's list verbatim", async () => {
	const { createClient } = await import("../test-support/client.mjs");
	const { ghSkillActions } = createClient().internals;
	const serverList = [
		{ args: "push", why: "1 ahead", what: "push", command: "git push", primary: true },
		{ args: "merge 46", why: "ready", what: "merge (squash)" },
		{ args: "clean", why: "2 untracked files", what: "remove untracked files", danger: true }
	];
	assert.deepEqual(ghSkillActions({ git: true, actions: serverList }), serverList, "verbatim, gate flags included");
	assert.deepEqual(ghSkillActions({ git: true }), [], "nothing to render");
});

test("the clean risk gate carries every field the host's confirmation renders", async () => {
	const { createClient } = await import("../test-support/client.mjs");
	const { cleanGate } = createClient().internals;
	const gate = cleanGate();
	for (const field of ["title", "description", "acknowledgeLabel", "cancelLabel", "confirmLabel"]) {
		assert.equal(typeof gate[field], "string", `${field} must be a string`);
		assert.ok(gate[field].length > 0, `${field} must not be empty`);
	}
	assert.match(gate.description, /no reflog and no stash entry/, "the gate says WHY it is dangerous");
	assert.match(gate.acknowledgeLabel, /cannot be recovered/, "the checkbox states the risk");
});

// ---------------------------------------------------------------------------
// the default branch: no pull request is ever suggested FROM main
// ---------------------------------------------------------------------------

test("the plugin's apply() installs the /gh skill into the catalog", async (t) => {
	// The skill install moved from the retired postinstall/patcher CLI into the
	// plugin itself, so a market install gets /gh on the next boot. installSkill()
	// never throws: this pins that apply() actually calls it.
	const home = mkdtempSync(join(tmpdir(), "dsh-git-badge-apply-skill-"));
	const previous = process.env.DSH_HOME;
	process.env.DSH_HOME = home;
	t.after(() => {
		if (previous === void 0) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = previous;
	});
	const { apply } = await import("../lib/index.js");
	const { ctx, disposeAll } = fakeCtx({ workspaces: [] });
	apply(ctx);
	disposeAll();
	const target = join(home, "skills", "gh", "SKILL.md");
	assert.ok(existsSync(target), "apply() installs /gh");
	assert.match(readFileSync(target, "utf8"), /^name: gh$/m, "and it is the packaged skill");
});

