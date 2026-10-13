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

/**
 * Every token the node half can attach as `rowToken`, with its glyph and the
 * severity colour it maps to. The row renders the token it is GIVEN; the
 * derivation itself is the node half's and is tested there.
 */
const TOKENS = [
	["resume", "\u23F5", "error"],
	["resolve", "!", "error"],
	["fix CI", "\u2717", "error"],
	["review", "\u25C6", "warn"],
	["merge", "\u2713", "success"],
	["sync", "\u21C4", "business"],
	["pull", "\u2193", "business"],
	["update", "\u21BB", "business"],
	["publish", "\u2191", "business"],
	["push", "\u2191", "business"],
	["commit", "\u271A", "business"]
];

/** A row payload carrying one token, so the pill has something to render. */
const withToken = (token) => ({ ...MAIN, rowToken: token });

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
		const rendered = text(client.row({ ...base, branch: "SECRET/BRANCH", rowToken: "merge" }));
		assert.ok(!rendered.includes("SECRET/BRANCH"), `the branch leaked into the row: ${rendered}`);
	}
});

test("the session row shows the ACTION and nothing else — silence when there is none", () => {
	const client = createClient();
	// Silence is the contract: uncommitted work is a state, not a chore, so a dirty
	// tree with nothing pending renders no badge at all.
	assert.equal(text(client.row({ ...MAIN, dirty: true })), "");
	assert.equal(text(client.row({ ...WORKTREE, worktreeName: "hotfix-tree", dirty: false })), "");
	// and when there IS an action the row carries the pill alone: a glyph and the
	// word — no mark, no PR number, no worktree name, no branch
	const merge = client.row({ ...WORKTREE, worktreeName: "hotfix-tree", rowToken: "merge" });
	assert.equal(text(merge), "\u2713 merge");
	assert.equal(mark(merge), null, "the row draws no mark");
	assert.ok(!text(merge).includes("391"), "nor the PR number — the hover line names it");
});

test("the row renders the node half's rowToken, never a client re-derivation", () => {
	// The token authority moved to the node half: the row reads `info.rowToken`
	// and does NOT inspect `pr`, counts or unmerged files itself. A payload that
	// would once have produced an action now renders nothing at all.
	const client = createClient();
	const action = (info) => text(client.row({ ...MAIN, ...info, rowToken: void 0 }));
	assert.equal(action({ unmergedFiles: 1, pr: { state: "passing", mergeState: "CLEAN" } }), "", "no rowToken, no pill");
	assert.equal(action({ behind: 2 }), "", "not derived from ahead/behind");
	assert.equal(action({ ahead: 1 }), "", "not derived from ahead/behind");
	assert.equal(action({ dirty: true }), "", "uncommitted work is not a chore");
	// and when the node half DOES send one, the row renders it verbatim
	for (const [token, glyph] of TOKENS) {
		assert.equal(text(client.row(withToken(token))), `${glyph} ${token}`, `rowToken ${token}`);
	}
});

test("the action is a severity-tinted pill that floats clear of the time", () => {
	const client = createClient();
	const styleFor = (token) => {
		const row = client.row(withToken(token));
		const found = elements(row).find((element) => element.props?.style?.marginLeft === "auto");
		assert.ok(found !== void 0, `expected an action badge for ${token}`);
		return found.props.style;
	};
	// the gap: the first cut sat flush against the relative time and read `merge11m`
	const merge = styleFor("merge");
	assert.equal(merge.marginLeft, "auto", "floated right, so a column of actions lines up");
	assert.equal(merge.marginRight, "8px", "and never flush against the time label");
	assert.equal(merge.fontWeight, 600, "heavier than the timestamp it outranks");
	// the PILL: padding and the app's own small radius, so the token reads as a tag
	assert.equal(merge.padding, "0 6px", "the word sits inside a pill, not in loose text");
	assert.match(merge.borderRadius, /radius-sm/, "and the radius is the app's own");
	// the FILL is the action's own colour at low alpha: a wash, not a shout
	assert.match(merge.background, /color-mix/, "the pill is tinted rather than solid");
	assert.match(merge.background, /state-success-primary/, "and the tint is the action's own colour");
	// colour means how much this needs you, using the same state tokens the mark does
	assert.match(merge.color, /state-success-primary/, "merge is the all-clear");
	for (const [token, , severity] of TOKENS) {
		assert.match(
			styleFor(token).color,
			new RegExp(`state-${severity}-primary`),
			`${token} is ${severity}`
		);
	}
	// the word is still the channel: the colour only reinforces it
	assert.equal(text(client.row(withToken("fix CI"))), "\u2717 fix CI");
});

test("every action carries a glyph, and the glyph is not the accessible name", () => {
	// The SHAPE channel: a glyph makes the row readable before the word is parsed.
	// It is DECORATION — `aria-hidden` keeps the accessible name the bare word, so a
	// screen reader says "push", not "upwards arrow push".
	const client = createClient();
	for (const [word, glyph] of TOKENS) {
		const row = client.row(withToken(word));
		assert.equal(text(row), `${glyph} ${word}`, `glyph then word for ${word}`);
		const decoration = elements(row).find((element) => element.props?.["aria-hidden"] === true);
		assert.ok(decoration !== void 0, `the glyph for ${word} is decoration`);
		assert.equal(text(decoration), `${glyph} `, "and it holds only the glyph and a space");
		assert.equal(mark(row), null, "a glyph must never become the status mark's <svg>");
		// the accessible name is the word alone: the pill carries no overriding label
		const pill = elements(row).find((element) => element.props?.style?.marginLeft === "auto");
		assert.equal(pill.props["aria-label"], void 0, `${word}: no aria-label on the pill`);
	}
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
	// the sync arrows now sit WITH the branch (they are the branch's standing
	// against upstream), so they render before the operation token
	const client = createClient();
	const line = text(client.chip({ ...WORKTREE, operation: "rebase", ahead: 0, behind: 2, changedFiles: 3, dirty: true }));
	assert.equal(line, "feat/hotfix ↑0 ↓2 ⚔rebase ✎3");
});

test("the sync arrows ride the branch's hover and link; the file count does not", () => {
	// hover: true makes the harness serve the lazy detail payload, which is where
	// compareUrl lives
	const client = createClient({ tooltip: true, hover: true });
	// compareUrl rides the lazy detail payload, so it is the second argument
	const base = { ...WORKTREE, ahead: 1, behind: 2, changedFiles: 3 };
	const chip = client.chip(base, {
		...base,
		compareUrl: "https://github.com/owner/repo/compare/main...feat/hotfix"
	});
	const anchor = elements(chip).find((el) => el.type === "a");
	assert.ok(anchor !== void 0, "the branch is the anchor when a compare URL is present");
	assert.equal(text(anchor), "feat/hotfix \u21911 \u21932", "the arrows are inside the branch's link");
	assert.match(anchor.props["aria-label"], /1 ahead and 2 behind upstream/, "and the accessible name says them");
	// ✎n answers a different question and stays outside the link
	assert.ok(!text(anchor).includes("\u270E"), "the file count is not part of the branch link");
	assert.ok(text(chip).includes("\u270E3"), "it is still on the chip");
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

test("the card names linked worktrees it is NOT following — the failure made visible", () => {
	// A registration is written outside the repository, so a file sandbox or a
	// read-only home can refuse it. The write fails, the badge keeps describing the
	// session's own checkout, and nothing on screen distinguishes that from a
	// session with nothing to follow. This row is the difference.
	const client = createClient();
	assert.match(
		client.internals.linkedWorktreesDetail({ linkedWorktrees: 1 }),
		/^1 linked .*none registered/,
		"one linked tree reads as linked-but-unregistered"
	);
	assert.match(client.internals.linkedWorktreesDetail({ linkedWorktrees: 3 }), /^3 linked/);
	assert.match(
		client.internals.linkedWorktreesDetail({ linkedWorktrees: 2 }),
		/npx dsh-git-badge checkout/,
		"and carries the command that fixes it"
	);
	// absent when there is nothing to say: no count, a zero, or a followed tree
	assert.equal(client.internals.linkedWorktreesDetail({}), void 0);
	assert.equal(client.internals.linkedWorktreesDetail({ linkedWorktrees: 0 }), void 0);
	assert.equal(client.internals.linkedWorktreesDetail({ linkedWorktrees: void 0 }), void 0);
	assert.equal(client.internals.linkedWorktreesDetail(void 0), void 0);
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

// ---------------------------------------------------------------------------
// the leading-cell glyph fallback. On an install WITHOUT the seam patch there
// is no row pill, so the same node-half token renders as one glyph in the
// upstream 16px leading cell.
// ---------------------------------------------------------------------------

/** A stand-in for the shell's standard kit: a selector hook over the sessions store. */
const sessionsWithRunning = (running) => (select) => select({ byId: { "s-1": { running } } });

test("LeadingTokenGlyph renders the token as one glyph with the token colour and name", () => {
	const client = createClient({ seam: false });
	for (const [token, glyph, severity] of TOKENS) {
		const cell = client.leading(withToken(token));
		assert.equal(text(cell), glyph, `${token}: exactly one glyph, no word`);
		assert.equal(cell.type, "span");
		assert.equal(cell.props.role, "img", `${token}: the glyph is the accessible name here`);
		assert.equal(cell.props["aria-label"], "git action: " + token, `${token}: the word is the name`);
		assert.equal(cell.props["aria-hidden"], void 0, `${token}: NOT decoration — no word sits beside it`);
		assert.match(cell.props.style.color, new RegExp(`state-${severity}-primary`), `${token} is ${severity}`);
		// geometry: one text node, and no wrapper that changes the cell's box
		assert.equal(typeof cell.props.children, "string", `${token}: a single text node`);
	}
});

test("the row's hover card explains the glyph, using the row's own hover", () => {
	// The leading glyph carries no tooltip of its own: the row is already a
	// HoverCard anchor, so the explanation rides the SAME card the session line
	// uses. Word and reason come from the same node-half rule, and the card leads
	// with the token GLYPH in the token's colour instead of the word "action".
	const client = createClient();
	const withGlyph = client.rowDetail({ ...MAIN, rowToken: "publish", rowTokenWhy: "no upstream configured" });
	assert.equal(text(withGlyph), "\u2191 publish \u2014 no upstream configured");
	const glyph = elements(withGlyph).find((element) => element.props?.["aria-hidden"] === true);
	assert.ok(glyph !== void 0, "the glyph is decoration; the word follows it");
	assert.equal(text(glyph), "\u2191 ", "the glyph and a space");
	assert.match(glyph.props.style.color, /state-business-primary/, "painted in the token's own colour");
	// no reason from the node half still names the action
	assert.equal(text(client.rowDetail({ ...MAIN, rowToken: "push" })), "\u2191 push");
	// action first, then the checkout and the pull request; and nothing at all
	// when the row has neither a token nor anything else to name
	assert.equal(
		text(client.rowDetail({
			branch: "feat/x", isWorktree: true, worktreeName: "hotfix-tree",
			rowToken: "merge", rowTokenWhy: "pull request 9 is ready to merge"
		})),
		"\u2713 merge \u2014 pull request 9 is ready to merge \u00B7 checkout: hotfix-tree on feat/x"
	);
	assert.equal(text(client.rowDetail({ ...MAIN })), "");
});

test("the hover card WRAPS: a long checkout line must not overrun the card", () => {
	// META_STYLE is `nowrap` for the chip, and it left the row card's long line on
	// one row — in `.dotfiles` it overran. The card overrides that one property.
	const client = createClient();
	const card = client.rowDetail({
		branch: "chore/global-skills-tiering",
		isWorktree: true,
		worktreeName: "global-skills-tiering",
		worktreeFollowed: true,
		rowToken: "push",
		rowTokenWhy: "1 ahead of origin/chore/global-skills-tiering",
		pr: { number: 391, state: "passing" }
	});
	assert.equal(card.props.style.whiteSpace, "normal", "the card line wraps");
	assert.equal(card.props.style.overflowWrap, "anywhere", "and a long unbroken name still breaks");
	// the chip's own meta style must stay nowrap — this override is local
	assert.equal(card.props.style.flex, "none");
});

test("LeadingTokenGlyph falls back to the shared status mark with no token", () => {
	const client = createClient({ seam: false });
	const disc = client.leading({ ...MAIN, dirty: false });
	assert.equal(markShape(mark(disc)), "disc", "clean and in sync is the green disc");
	assert.match(markFill(mark(disc)), /state-success-primary/);
	assert.equal(markShape(mark(client.leading({ ...WORKTREE, dirty: false }))), "tree", "a linked worktree keeps its shape");
	// and nothing at all for a non-repository, or a target that is not resolved
	assert.equal(client.leading({ git: false }), null, "no repository, no cell");
	assert.equal(client.leading(void 0), null, "unresolved target, no cell");
});

test("LeadingTokenGlyph fetches only when the seam is absent, and for PR state too", () => {
	// The patched install returns null here, so it pays for neither a render nor
	// a status request.
	const patched = createClient({ seam: true });
	assert.equal(patched.leading(withToken("push")), null, "the pill owns the row");
	assert.equal(patched.requests.filter((key) => typeof key === "string").length, 0, "and fetches nothing");
	// The unpatched install asks the SAME question the row card asks, so the
	// glyph and the card resolve to one cache entry and one in-flight read.
	const unpatched = createClient({ seam: false });
	unpatched.leading(withToken("push"));
	assert.deepEqual(unpatched.requests, ["session=s-1&pr=1"], "one session+PR request, nothing else");
	// and the PR token it can now receive is what the card shows
	assert.equal(text(unpatched.leading({ ...MAIN, rowToken: "merge" })), "\u2713", "a PR token reaches the glyph");
});

test("LeadingTokenGlyph hides while the session runs a turn", () => {
	const client = createClient({ seam: false });
	assert.equal(text(client.leading(withToken("push"), { useSessions: sessionsWithRunning(false) })), "\u2191");
	assert.equal(client.leading(withToken("push"), { useSessions: sessionsWithRunning(true) }), null, "nothing during a turn");
});

test("the leading glyph disappears once a late seam declaration arrives", () => {
	// Boot race: the leading cell can render before the workspace browser declares
	// the seam. It shows the glyph, then the seam flag flips and it goes away.
	const client = createClient({ seam: false });
	assert.equal(text(client.leading(withToken("push"))), "\u2191", "the fallback shows during the race");
	client.declareSeam();
	assert.equal(client.leading(withToken("push")), null, "and vanishes on the next render");
});

