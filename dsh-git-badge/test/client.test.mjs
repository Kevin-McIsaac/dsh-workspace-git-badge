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
import { createClient, elements, mark, markFill, markShape, text } from "../test-support/client.mjs";

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

test("the mark belongs to the CHIP; the session row carries an action instead", () => {
	// Deliberate asymmetry. The chip is the surface for "where am I / what is the
	// state", so it keeps the shared mark; the row's job is triage, and an action
	// word says more there than a colour can.
	const client = createClient();
	for (const [label, extra] of Object.entries(STATUSES)) {
		for (const [kind, base] of [["main", MAIN], ["worktree", WORKTREE]]) {
			const info = { ...base, ...extra };
			assert.ok(mark(client.chip(info)) !== null, `${kind} / ${label}: the chip draws the mark`);
			assert.equal(mark(client.row(info)), null, `${kind} / ${label}: the row draws no mark`);
		}
	}
});

test("the mark is a disc for a main checkout and a tree for a linked worktree", () => {
	const client = createClient();
	assert.equal(markShape(mark(client.chip({ ...MAIN, dirty: false }))), "disc");
	assert.equal(markShape(mark(client.chip({ ...WORKTREE, dirty: false }))), "tree");
});

test("the fill follows the three-state rule, checked top-down", () => {
	const client = createClient();
	const fill = (info) => markFill(mark(client.chip(info)));
	assert.match(fill({ ...MAIN, dirty: false }), /state-success-primary/, "clean and in sync is green");
	assert.match(fill({ ...MAIN, dirty: true }), /state-warn-primary/, "dirty is amber");
	assert.match(fill({ ...MAIN, dirty: false, behind: 1 }), /state-warn-primary/, "clean but behind is amber, never red");
	assert.match(fill({ ...MAIN, dirty: false, ahead: 1 }), /state-warn-primary/, "ahead is amber too");
	assert.match(fill({ ...MAIN, unmergedFiles: 1, dirty: true }), /state-error-primary/, "a conflict is red");
	assert.match(fill({ ...MAIN, dirty: true, behind: 3 }), /state-error-primary/, "dirty AND behind is red");
});

test("the fill comes from the app's own state tokens, so it follows the theme", () => {
	const client = createClient();
	const fill = markFill(mark(client.chip({ ...MAIN, dirty: false })));
	assert.match(fill, /^var\(--dsw-alias-state-success-primary, #[0-9a-f]{6}\)$/i, `unexpected fill: ${fill}`);
});

test("the selection of a mark colour never depends on the worktree shape", () => {
	// shape is worktree-ness, colour is status: the two must not interact
	const client = createClient();
	for (const [label, extra] of Object.entries(STATUSES)) {
		const mainFill = markFill(mark(client.chip({ ...MAIN, ...extra })));
		const wtFill = markFill(mark(client.chip({ ...WORKTREE, ...extra })));
		assert.equal(wtFill, mainFill, `${label}: the shape must not change the colour`);
	}
});

test("the session row NEVER shows the branch", () => {
	const client = createClient();
	for (const base of [MAIN, WORKTREE]) {
		const rendered = text(client.row({ ...base, branch: "SECRET/BRANCH", pr: { number: 1, state: "passing", mergeState: "CLEAN" } }));
		assert.ok(!rendered.includes("SECRET/BRANCH"), `the branch leaked into the row: ${rendered}`);
	}
});

test("the session row shows the ACTION and nothing else — silence when there is none", () => {
	const client = createClient();
	// Silence is the contract: uncommitted work is a state, not a chore, so a dirty
	// tree with nothing pending renders no badge at all.
	assert.equal(text(client.row({ ...MAIN, dirty: true })), "");
	assert.equal(text(client.row({ ...WORKTREE, worktreeName: "hotfix-tree", dirty: false })), "");
	// and when there IS an action the row carries the word alone: no mark, no PR
	// number, no worktree name, no branch
	const merge = client.row({ ...WORKTREE, worktreeName: "hotfix-tree", pr: { number: 391, state: "passing", mergeState: "CLEAN" } });
	assert.equal(text(merge), "merge");
	assert.equal(mark(merge), null, "the row draws no mark");
	assert.ok(!text(merge).includes("391"), "nor the PR number — the hover line names it");
});

test("the action token maps each state to the one thing to do", () => {
	const client = createClient();
	const action = (info) => client.internals.actionToken({ git: true, ...info });
	// first match wins, so a conflict outranks everything downstream of it
	assert.equal(action({ unmergedFiles: 1, pr: { state: "passing", mergeState: "CLEAN" } }), "resolve");
	assert.equal(action({ pr: { state: "failing" } }), "fix CI");
	assert.equal(action({ pr: { state: "passing", review: "CHANGES_REQUESTED" } }), "review");
	assert.equal(action({ pr: { number: 18, state: "passing", mergeState: "CLEAN" } }), "merge");
	assert.equal(action({ behind: 2 }), "pull");
	assert.equal(action({ ahead: 1 }), "push");
	// WAITING is not an action: every one of these is "leave it alone", because a
	// wrong imperative nags and a neutral state does not
	for (const pr of [
		{ number: 18, state: "passing", mergeState: "BLOCKED" },
		{ number: 18, state: "passing", draft: true, mergeState: "DRAFT" },
		{ number: 18, state: "passing", mergeState: "BEHIND" },
		{ number: 18, state: "passing", mergeState: "UNKNOWN" },
		{ number: 18, state: "pending" }
	]) {
		assert.equal(action({ pr }), "", `waiting must be silent: ${JSON.stringify(pr)}`);
	}
	assert.equal(action({ dirty: true }), "", "uncommitted work is not a chore");
	assert.equal(action({ pr: { number: 18, state: "passing" } }), "", "no merge verdict yet is not an action");
	assert.equal(client.internals.actionToken({ git: false }), "", "nothing to say without a repository");
});

test("the action floats clear of the time and is coloured by SEVERITY", () => {
	const client = createClient();
	const styleFor = (info) => {
		const row = client.row({ ...MAIN, ...info });
		const found = elements(row).find((element) => element.props?.style?.marginLeft === "auto");
		assert.ok(found !== void 0, `expected an action badge for ${JSON.stringify(info)}`);
		return found.props.style;
	};
	// the gap: the first cut sat flush against the relative time and read `merge11m`
	const merge = styleFor({ pr: { number: 1, state: "passing", mergeState: "CLEAN" } });
	assert.equal(merge.marginLeft, "auto", "floated right, so a column of actions lines up");
	assert.equal(merge.marginRight, "8px", "and never flush against the time label");
	assert.equal(merge.fontWeight, 500, "heavier than the timestamp it outranks");
	// colour means how much this needs you, using the same state tokens the mark does
	assert.match(merge.color, /state-success-primary/, "merge is the all-clear");
	assert.match(styleFor({ pr: { state: "failing" } }).color, /state-error-primary/, "a broken build is loud");
	assert.match(styleFor({ unmergedFiles: 1 }).color, /state-error-primary/, "so is a conflict");
	assert.match(
		styleFor({ pr: { state: "passing", review: "CHANGES_REQUESTED" } }).color,
		/state-warn-primary/,
		"a requested review is a nudge"
	);
	assert.match(styleFor({ behind: 1 }).color, /label-secondary/, "routine sync stays quiet");
	assert.match(styleFor({ ahead: 1 }).color, /label-secondary/, "and so does push");
	// the word is still the channel: the colour only reinforces it
	assert.equal(text(client.row({ ...MAIN, pr: { state: "failing" } })), "fix CI");
});

test("a non-repository session row renders no badge", () => {
	const client = createClient();
	assert.equal(client.row({ git: false }), null, "nothing to say about a directory that is not a repository");
});

test("the hover line says what the action word cannot", () => {
	const client = createClient();
	// The inferred case: the row's status describes a tree the conversation is not
	// in, and because the row now carries only an imperative, this card is the ONLY
	// place that can show which tree — and which PR — it refers to.
	assert.equal(
		text(
			client.rowDetail({
				branch: "chore/global-skills-tiering",
				isWorktree: true,
				worktreeName: "global-skills-tiering",
				worktreeFollowed: true,
				pr: { number: 391, state: "passing" }
			})
		),
		"checkout: global-skills-tiering on chore/global-skills-tiering \u00B7 pull request #391 \u00B7 checks passing"
	);
	// a worktree the session is genuinely in is named without the explanation
	assert.equal(
		text(client.rowDetail({ branch: "feat/x", isWorktree: true, worktreeName: "hotfix-tree" })),
		"checkout: hotfix-tree on feat/x"
	);
	// a MAIN checkout has no tree to name, but its pull request is still worth the
	// line: a bare `merge` on the row would otherwise be unexplainable
	assert.equal(
		text(client.rowDetail({ branch: "main", isWorktree: false, pr: { number: 18, state: "passing", review: "APPROVED" } })),
		"pull request #18 \u00B7 checks passing \u00B7 approved"
	);
	// nothing to name at all — no tree, no PR — so the card says nothing
	assert.equal(text(client.rowDetail({ branch: "main", isWorktree: false })), "");
	assert.equal(client.rowDetail({ git: false }), null);
});

test("the chip NEVER names the worktree — the branch, and the mark's shape, only", () => {
	const client = createClient();
	// A checkout's directory name is long, competes with the branch for the same
	// glance, and is not what a reader scans for. The mark's SHAPE already says
	// "worktree"; WHICH tree is the hover card's `worktree` row.
	const chip = client.chip({ ...WORKTREE, dirty: false });
	assert.equal(text(chip), "feat/hotfix", `expected the branch alone, got: ${text(chip)}`);
	assert.equal(markShape(mark(chip)), "tree", "worktree-ness is carried by the shape instead");
	// a name that the branch repeats is no longer special-cased, because no name is
	assert.equal(text(client.chip({ branch: "feat/x", isWorktree: true, worktreeName: "repo-feat-x", dirty: false })), "feat/x");
	assert.equal(text(client.chip({ ...MAIN, dirty: false })), "main");
});

test("the chip still carries the branch, operation token and counts", () => {
	const client = createClient();
	const line = text(client.chip({ ...WORKTREE, operation: "rebase", ahead: 0, behind: 2, changedFiles: 3, dirty: true }));
	assert.equal(line, "feat/hotfix ⚔rebase ↑0 ↓2 ✎3");
});

test("a FOLLOWED worktree is named in the CARD, never on the chip", () => {
	const client = createClient();
	// The case this exists for: the session's own directory is the main checkout and
	// the session registered a linked worktree. The chip shows the tree's branch;
	// which tree it is belongs to the card — that keeps the chip short and honest.
	const followed = {
		branch: "chore/global-skills-tiering",
		isWorktree: true,
		worktreeName: "global-skills-tiering",
		worktreeFollowed: true,
		dirty: false
	};
	assert.equal(text(client.chip(followed)), "chore/global-skills-tiering");
	assert.equal(
		client.internals.worktreeDetail(followed),
		"global-skills-tiering",
		"the card's row names the tree"
	);
	assert.equal(client.internals.worktreeDetail({ branch: "feat/x", isWorktree: true, worktreeName: "hotfix-tree" }), "hotfix-tree");
	assert.equal(client.internals.worktreeDetail({ branch: "main", isWorktree: false }), void 0, "a main checkout has nothing to name");
});

test("the mark's accessible name states status AND worktree-ness", () => {
	const client = createClient();
	const main = mark(client.chip({ ...MAIN, dirty: true }));
	assert.equal(main.props.role, "img");
	assert.equal(main.props["aria-label"], "git: uncommitted changes, or out of sync with upstream");
	const worktree = mark(client.chip({ ...WORKTREE, dirty: false }));
	assert.equal(worktree.props["aria-label"], "git worktree: clean and in sync");
});

test("an INFERRED checkout says so in the mark's accessible name", () => {
	// the same rule the token follows: nothing depends on seeing the trailing name,
	// so a screen reader is told where the shape's fact came from
	const client = createClient();
	const followed = mark(client.chip({ ...WORKTREE, worktreeFollowed: true, dirty: false }));
	assert.equal(
		followed.props["aria-label"],
		"git worktree: clean and in sync (registered for this session)"
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
