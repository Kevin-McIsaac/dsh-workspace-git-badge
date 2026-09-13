/**
 * Client half: the two surfaces, and the status mark they share.
 *
 * `lib/client.js` runs in a browser, so these tests load the real bundle with a
 * stub module loader (`test-support/client.mjs`) and render the registered
 * components directly. That is what makes the client's rules — shape means
 * worktree, colour means status, the row never shows a branch — regression-proof
 * instead of verified by eye. No browser, no DSH, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient, mark, markFill, markShape, text } from "../test-support/client.mjs";

/** A main checkout and a linked worktree, differing only in that one field. */
const MAIN = { branch: "main", isWorktree: false, worktreeName: "repo" };
const WORKTREE = { branch: "feat/hotfix", isWorktree: true, worktreeName: "hotfix-tree" };

const STATUSES = {
	"clean": { dirty: false },
	"dirty": { dirty: true },
	"ahead": { dirty: false, ahead: 2 },
	"behind": { dirty: false, behind: 2 },
	"conflict": { unmergedFiles: 1, dirty: true },
	"dirty and behind": { dirty: true, behind: 2 }
};

test("the chip and the row draw an IDENTICAL mark for the same status", () => {
	const client = createClient();
	for (const [label, extra] of Object.entries(STATUSES)) {
		for (const [kind, base] of [["main", MAIN], ["worktree", WORKTREE]]) {
			const info = { ...base, ...extra };
			assert.deepEqual(
				mark(client.chip(info)),
				mark(client.row(info)),
				`${kind} / ${label}: the two surfaces must draw the same mark`
			);
		}
	}
});

test("the mark is a disc for a main checkout and a tree for a linked worktree", () => {
	const client = createClient();
	assert.equal(markShape(mark(client.row({ ...MAIN, dirty: false }))), "disc");
	assert.equal(markShape(mark(client.row({ ...WORKTREE, dirty: false }))), "tree");
	// and the chip agrees, since it draws the same mark
	assert.equal(markShape(mark(client.chip({ ...WORKTREE, dirty: false }))), "tree");
});

test("the fill follows the three-state rule, checked top-down", () => {
	const client = createClient();
	const fill = (info) => markFill(mark(client.row(info)));
	assert.match(fill({ ...MAIN, dirty: false }), /state-success-primary/, "clean and in sync is green");
	assert.match(fill({ ...MAIN, dirty: true }), /state-warn-primary/, "dirty is amber");
	assert.match(fill({ ...MAIN, dirty: false, behind: 1 }), /state-warn-primary/, "clean but behind is amber, never red");
	assert.match(fill({ ...MAIN, dirty: false, ahead: 1 }), /state-warn-primary/, "ahead is amber too");
	assert.match(fill({ ...MAIN, unmergedFiles: 1, dirty: true }), /state-error-primary/, "a conflict is red");
	assert.match(fill({ ...MAIN, dirty: true, behind: 3 }), /state-error-primary/, "dirty AND behind is red");
});

test("the fill comes from the app's own state tokens, so it follows the theme", () => {
	const client = createClient();
	const fill = markFill(mark(client.row({ ...MAIN, dirty: false })));
	assert.match(fill, /^var\(--dsw-alias-state-success-primary, #[0-9a-f]{6}\)$/i, `unexpected fill: ${fill}`);
});

test("the selection of a mark colour never depends on the worktree shape", () => {
	// shape is worktree-ness, colour is status: the two must not interact
	const client = createClient();
	for (const [label, extra] of Object.entries(STATUSES)) {
		const mainFill = markFill(mark(client.row({ ...MAIN, ...extra })));
		const wtFill = markFill(mark(client.row({ ...WORKTREE, ...extra })));
		assert.equal(wtFill, mainFill, `${label}: the shape must not change the colour`);
	}
});

test("the session row NEVER shows the branch", () => {
	const client = createClient();
	for (const base of [MAIN, WORKTREE]) {
		const rendered = text(client.row({ ...base, branch: "SECRET/BRANCH", pr: { number: 1, state: "passing" } }));
		assert.ok(!rendered.includes("SECRET/BRANCH"), `the branch leaked into the row: ${rendered}`);
	}
});

test("the session row is the status mark, plus the PR token when there is one", () => {
	const client = createClient();
	// the mark is an <svg>, so a row with no PR contributes no TEXT at all — and
	// neither the worktree's name nor its branch appears there
	assert.equal(text(client.row({ ...MAIN, dirty: true })), "", "a main checkout with no PR adds no text");
	assert.equal(text(client.row({ ...WORKTREE, worktreeName: "hotfix-tree", dirty: false })), "");
	const withPr = text(client.row({ ...WORKTREE, worktreeName: "hotfix-tree", pr: { number: 391, state: "pending" } }));
	assert.ok(withPr.includes("PR#391"), `expected the PR token: ${withPr}`);
	assert.ok(!withPr.includes("hotfix-tree"), "the worktree name belongs to the hover card");
	assert.ok(!withPr.includes("feat/hotfix"), "and so does the branch");
});

test("a non-repository session row renders no badge", () => {
	const client = createClient();
	assert.equal(client.row({ git: false }), null, "nothing to say about a directory that is not a repository");
});

test("the hover line names the checkout a session row's badge describes", () => {
	const client = createClient();
	// the inferred case is the one the row's own title cannot explain: the badge
	// describes a tree the conversation is not in, so the line says which and why
	assert.equal(
		text(
			client.rowDetail({
				branch: "chore/global-skills-tiering",
				isWorktree: true,
				worktreeName: "global-skills-tiering",
				worktreeInferred: true,
				pr: { number: 391, state: "passing" }
			})
		),
		"checkout: global-skills-tiering on chore/global-skills-tiering \u00B7 its branch has the open pull request"
	);
	// a worktree the session is genuinely in is named without the explanation
	assert.equal(
		text(client.rowDetail({ branch: "feat/x", isWorktree: true, worktreeName: "hotfix-tree" })),
		"checkout: hotfix-tree on feat/x"
	);
	// a main checkout is the ordinary case, and the card must not restate it
	assert.equal(text(client.rowDetail({ branch: "main", isWorktree: false })), "");
	assert.equal(client.rowDetail({ git: false }), null);
});

test("the chip appends the worktree name unless the branch already implies it", () => {
	const client = createClient();
	assert.ok(text(client.chip({ ...WORKTREE, dirty: false })).includes("hotfix-tree"), "a distinct name is shown");
	const redundant = text(client.chip({ branch: "feat/x", isWorktree: true, worktreeName: "repo-feat-x", dirty: false }));
	assert.ok(!redundant.includes("repo-feat-x"), "a name the branch already says must be dropped as stutter");
	assert.ok(redundant.includes("feat/x"), "the branch is always on the chip");
	assert.equal(text(client.chip({ ...MAIN, dirty: false })), "main", "a main checkout appends no name");
});

test("the chip still carries branch, worktree name, operation token and counts", () => {
	const client = createClient();
	const line = text(client.chip({ ...WORKTREE, operation: "rebase", ahead: 0, behind: 2, changedFiles: 3, dirty: true }));
	assert.equal(line, "feat/hotfix hotfix-tree ⚔rebase ↑0 ↓2 ✎3");
});

test("an INFERRED worktree is named even when the branch would make it stutter", () => {
	const client = createClient();
	// The case this rule exists for: a session whose own directory is the main
	// checkout, whose badge the node half moved onto the tree that has the open PR.
	// The name does not repeat the branch beside it — it IS the disclosure that the
	// chip left the conversation's directory — so the redundancy rule must not
	// swallow it.
	const inferred = text(
		client.chip({
			branch: "chore/global-skills-tiering",
			isWorktree: true,
			worktreeName: "global-skills-tiering",
			worktreeInferred: true,
			dirty: false
		})
	);
	assert.equal(inferred, "chore/global-skills-tiering global-skills-tiering");
	// the same pair WITHOUT inference is the ordinary stutter case and stays terse
	const own = text(
		client.chip({
			branch: "chore/global-skills-tiering",
			isWorktree: true,
			worktreeName: "global-skills-tiering",
			dirty: false
		})
	);
	assert.equal(own, "chore/global-skills-tiering");
});

test("the mark's accessible name states status AND worktree-ness", () => {
	const client = createClient();
	const main = mark(client.row({ ...MAIN, dirty: true }));
	assert.equal(main.props.role, "img");
	assert.equal(main.props["aria-label"], "git: uncommitted changes, or out of sync with upstream");
	const worktree = mark(client.row({ ...WORKTREE, dirty: false }));
	assert.equal(worktree.props["aria-label"], "git worktree: clean and in sync");
});

test("an INFERRED checkout says so in the mark's accessible name", () => {
	// the same rule the token follows: nothing depends on seeing the trailing name,
	// so a screen reader is told where the shape's fact came from
	const client = createClient();
	const inferred = mark(client.row({ ...WORKTREE, worktreeInferred: true, dirty: false }));
	assert.equal(
		inferred.props["aria-label"],
		"git worktree: clean and in sync (inferred from an open pull request in this repository)"
	);
});

test("neither surface still renders the emoji dot or the old worktree glyph", () => {
	const client = createClient();
	const rendered = text(client.row({ ...WORKTREE, dirty: true })) + text(client.chip({ ...WORKTREE, dirty: true }));
	assert.ok(!/[\u{1F534}\u{1F7E1}\u{1F7E2}]/u.test(rendered), "the emoji status dot must be gone");
	assert.ok(!rendered.includes("\u2442"), "the ⑂ worktree glyph must be gone");
});

test("a non-repository, and an unresolved workspace, render no mark", () => {
	const client = createClient();
	assert.equal(client.chip({ git: false }), null, "the chip renders nothing without a repository");
	assert.equal(client.chip(void 0), null, "and nothing while the target is unresolved");
	assert.equal(mark(client.row({ git: false })), null, "the row shows no mark without a repository");
	// the row badge is ADDITIVE: upstream still renders the session title, so the
	// badge contributes nothing at all when it has nothing to say
	assert.equal(client.row({ git: false }), null, "and no badge");
});
