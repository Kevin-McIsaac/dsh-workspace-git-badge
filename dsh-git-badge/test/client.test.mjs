/**
 * Client half: the three surfaces, and the status mark they share.
 *
 * `lib/client.js` runs in a browser, so these tests load the real bundle with a
 * stub module loader (`test-support/client.mjs`) and render the registered
 * components directly. That is what makes the client's rules — shape means
 * worktree, colour means status, the row's glyph never names a branch —
 * regression-proof instead of verified by eye. No browser, no DSH, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient, elements, expand, rows, text } from "../test-support/client.mjs";

/** A main checkout and a linked worktree, differing only in that one field. */
const MAIN = { branch: "main", isWorktree: false, worktreeName: "repo" };
const WORKTREE = { branch: "feat/hotfix", isWorktree: true, worktreeName: "hotfix-tree" };

/**
 * Every token the node half can attach as `rowToken`, with its text glyph and the
 * severity colour it maps to. `null` in the glyph column means the icon is DRAWN
 * (see DRAWN below), so no text character exists for it. The row renders the token
 * it is GIVEN; the derivation itself is the node half's and is tested there.
 */
const TOKENS = [
	["resume", "\u23F5", "error"],
	["resolve", "!", "error"],
	["fix CI", "\u2717", "error"],
	["review", "\u25C6", "warn"],
	["commit", "\u271A", "business"],
	["merge", null, "success"],
	["sync", null, "business"],
	["pull", null, "business"],
	["update", null, "business"],
	["push", null, "business"],
	["in sync", null, "success"]
];

/** token -> severity, from the table above, so a fixture and its colour agree. */
const SEVERITY = Object.fromEntries(TOKENS.map(([token, , severity]) => [token, severity]));

/** The tokens whose icons are DRAWN, not typed: the arrows, the idle disc and merge. */
const DRAWN = new Set(["push", "pull", "sync", "update", "in sync", "merge"]);

/** True when any node in the tree is an <svg>. */
const hasSvg = (node) => elements(node).some((element) => element.type === "svg");

/** A row payload carrying one token, so the leading cell has something to draw. */
const withToken = (token) => ({ ...MAIN, rowToken: token, rowSeverity: SEVERITY[token] });

test("the chip shows the action icon, and NO icon when there is no token", () => {
	// ONE icon system: the chip's leading cluster draws the same token the row
	// draws. A checkout with no token has no action to triage, so it draws nothing
	// — no disc, no tree, no decorative dot.
	const client = createClient();
	const clean = client.chip({ ...MAIN, rowToken: void 0 });
	assert.equal(text(clean), "main", "a tokenless chip is just the branch");
	assert.equal(hasSvg(clean), false, "and no icon at all");
	for (const [token, glyph] of TOKENS) {
		const chip = client.chip({ ...MAIN, rowToken: token, rowSeverity: SEVERITY[token] });
		if (DRAWN.has(token)) assert.equal(hasSvg(chip), true, `${token}: a drawn arrow`);
		else {
			assert.ok(text(chip).includes(glyph), `${token}: the chip draws its glyph`);
			assert.equal(hasSvg(chip), false, `${token}: and no drawn shape`);
		}
	}
});

test("no surface draws the retired disc/tree mark", () => {
	// The mark is gone. Several tokens draw an SVG, so this uses one whose icon is
	// still a text glyph.
	const client = createClient();
	for (const node of [client.chip(withToken("commit")), client.leading(withToken("commit"))]) {
		assert.equal(hasSvg(node), false, "the mark is gone");
	}
});

test("the row's leading glyph NEVER shows the branch", () => {
	// The row lists conversations; WHICH checkout the token describes is the hover
	// card's business. The card may name a worktree's branch as part of its
	// `checkout:` line — the glyph never does.
	const client = createClient();
	for (const base of [MAIN, WORKTREE]) {
		const glyph = text(client.leading({ ...base, branch: "SECRET/BRANCH", rowToken: "merge", rowSeverity: "success" }));
		assert.ok(!glyph.includes("SECRET/BRANCH"), `the branch leaked into the glyph: ${glyph}`);
	}
	// a MAIN checkout's card has no tree to name, so the branch stays out of it too
	const card = text(client.rowDetail({ ...MAIN, branch: "SECRET/BRANCH", rowToken: "merge", rowSeverity: "success" }));
	assert.ok(!card.includes("SECRET/BRANCH"), `the branch leaked into the card: ${card}`);
});

test("the leading cell shows the token glyph, and NOTHING when there is none", () => {
	const client = createClient();
	// no token: the cell renders nothing at all — no mark, no text
	assert.equal(client.leading({ ...MAIN, dirty: false }), null, "a checkout with no action draws nothing");
	// a token: the glyph alone — no word, no mark, no PR number
	const commit = client.leading({ ...WORKTREE, worktreeName: "hotfix-tree", rowToken: "commit", rowSeverity: "business" });
	assert.equal(text(commit), "\u271A");
	const merge = client.leading({ ...WORKTREE, worktreeName: "hotfix-tree", rowToken: "merge", rowSeverity: "success" });
	assert.equal(hasSvg(merge), true, "merge is drawn now");
	assert.ok(!text(merge).includes("391"), "and the cell never carries the PR number");
});

test("the leading glyph renders the node half's rowToken, never a client re-derivation", () => {
	// The token authority is the node half: the glyph reads `info.rowToken` and
	// does NOT inspect `pr`, counts or unmerged files itself.
	const client = createClient();
	const drew = (info) => client.leading({ ...MAIN, ...info, rowToken: void 0 }) !== null;
	assert.ok(!drew({ unmergedFiles: 1, pr: { state: "passing", mergeState: "CLEAN" } }), "no rowToken, so nothing");
	assert.ok(!drew({ behind: 2 }), "not derived from ahead/behind");
	assert.ok(!drew({ dirty: true }), "not derived from dirty");
	// and when the node half DOES send one, the icon renders it verbatim: a text
	// glyph, or a drawn arrow for the four hairline tokens
	for (const [token, glyph] of TOKENS) {
		const cell = client.leading(withToken(token));
		if (DRAWN.has(token)) assert.equal(hasSvg(cell), true, `rowToken ${token}: a drawn arrow`);
		else assert.equal(text(cell), glyph, `rowToken ${token}`);
	}
});

test("a non-repository session row renders no glyph", () => {
	const client = createClient();
	assert.equal(client.leading({ git: false }), null, "nothing to say about a directory that is not a repository");
});

test("the row card says what the action glyph cannot", () => {
	const client = createClient();
	// The inferred case: the row's status describes a tree the conversation is not
	// in, so this card names the tree and the PR the action refers to.
	assert.deepEqual(
		rows(
			client.rowDetail({
				branch: "chore/global-skills-tiering",
				isWorktree: true,
				worktreeName: "global-skills-tiering",
				worktreeFollowed: true,
				pr: { number: 391, state: "passing" }
			})
		),
		[
			{ label: "checkout", value: "global-skills-tiering on chore/global-skills-tiering" },
			{ label: "pull request", value: "#391 \u00B7 checks passing" }
		]
	);
	// a worktree the session is genuinely in is named the same way
	assert.deepEqual(
		rows(client.rowDetail({ branch: "feat/x", isWorktree: true, worktreeName: "hotfix-tree" })),
		[{ label: "checkout", value: "hotfix-tree on feat/x" }]
	);
	// a MAIN checkout has no tree to name, but its pull request is still worth a row
	assert.deepEqual(
		rows(client.rowDetail({ branch: "main", isWorktree: false, pr: { number: 18, state: "passing", review: "APPROVED" } })),
		[{ label: "pull request", value: "#18 \u00B7 checks passing \u00B7 approved" }]
	);
	// nothing to name at all — no tree, no PR — so the card renders nothing
	assert.equal(client.rowDetail({ branch: "main", isWorktree: false }), null);
	assert.equal(client.rowDetail({ git: false }), null);
});

test("the chip NEVER names the worktree — the branch alone", () => {
	const client = createClient();
	// A checkout's directory name is long, competes with the branch for the same
	// glance, and is not what a reader scans for. WHICH tree is the card's
	// `worktree` row.
	const chip = client.chip({ ...WORKTREE, dirty: false });
	assert.equal(text(chip), "feat/hotfix", `expected the branch alone, got: ${text(chip)}`);
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

test("the idle verdict draws a disc: green when merged, amber when work is unmerged", () => {
	// The node emits `in sync` when no rule fires, so the row is never iconless. The
	// COLOUR carries the branch fact: green = nothing outstanding, amber = commits
	// that its base does not have.
	const client = createClient();
	const discOf = (severity, why) => {
		const info = { ...MAIN, rowToken: "in sync", rowSeverity: severity, rowTokenWhy: why };
		const icon = elements(client.leading(info)).find((el) => el.props?.["aria-label"] === "git action: in sync");
		assert.ok(icon !== void 0, "the idle row still has an icon");
		const svg = elements(icon).find((el) => el.type === "svg");
		assert.equal(svg.props.viewBox, "0 0 12 12", "on the shared grid");
		const circle = elements(svg).find((el) => el.type === "circle");
		assert.ok(circle !== void 0, "a disc, not an arrow");
		assert.equal(circle.props.cx, 6);
		assert.equal(circle.props.cy, 6);
		assert.equal(circle.props.r, 5, "a 10px disc, the arrows' size");
		return { icon, info };
	};
	const merged = discOf("success", "clean and matching the remote");
	assert.match(merged.icon.props.style.color, /state-success-primary/, "green when nothing is outstanding");
	assert.deepEqual(rows(client.rowDetail(merged.info)), [{ label: "action", value: " in sync \u2014 clean and matching the remote" }]);
	const unmerged = discOf("warn", "2 commits not merged");
	assert.match(unmerged.icon.props.style.color, /state-warn-primary/, "amber when work is unmerged");
	assert.deepEqual(rows(client.rowDetail(unmerged.info)), [{ label: "action", value: " in sync \u2014 2 commits not merged" }]);
});

test("the merge icon is Remix Icon git-merge-line, vendored as SVG at 16", () => {
	// Unicode has no merge glyph, so every tool draws the branch-into-a-trunk shape.
	// We vendor Remix Icon's `git-merge-line` verbatim and render it as inline SVG at
	// 16px: its ink is inset (about 16 of its 24 units), so it lands at the arrows'
	// weight and fills the row's 16px leading cell. No icon font is involved.
	const client = createClient();
	const icon = elements(client.leading({ ...MAIN, rowToken: "merge", rowSeverity: "success" }))
		.find((el) => el.props?.["aria-label"] === "git action: merge");
	assert.ok(icon !== void 0, "the row draws the merge icon");
	const svg = elements(icon).find((el) => el.type === "svg");
	assert.equal(svg.props.viewBox, "0 0 24 24", "Remix Icon's own grid");
	assert.equal(svg.props.width, 16, "rendered at the row cell's 16px");
	assert.equal(svg.props.height, 16);
	const paths = elements(svg).filter((el) => el.type === "path");
	assert.equal(paths.length, 1, "Remix Icon is one filled path");
	assert.ok(paths[0].props.d.startsWith("M7.10508 8.78991"), "vendored verbatim, not redrawn");
	assert.equal(elements(svg).some((el) => el.type === "circle"), false, "no hand-drawn shapes left");
	assert.equal(text(icon), "", "and no text glyph is left");
	assert.match(icon.props.style.color, /state-success-primary/, "still the success colour");
});

test("the retired status mark is gone; the only shapes are the drawn icons", () => {
	// The status disc and the worktree tree are deleted. Worktree-ness is named in
	// the card's `worktree` row now. The only svg left is a drawn icon: an arrow,
	// or the idle disc — and none of them is the old status mark.
	const client = createClient();
	assert.equal(hasSvg(client.chip({ ...MAIN, dirty: true })), false, "no mark on a tokenless chip");
	assert.equal(hasSvg(client.chip(withToken("commit"))), false, "no mark beside a text glyph");
	assert.equal(hasSvg(client.leading(withToken("commit"))), false, "and none in the row cell");
	for (const token of DRAWN) {
		const icon = elements(client.leading(withToken(token))).find((el) => el.type === "svg");
		assert.ok(icon !== void 0, `${token}: the icon is drawn`);
		// merge is Remix Icon's 24-grid; the rest live on our 12-grid
		assert.equal(icon.props.viewBox, token === "merge" ? "0 0 24 24" : "0 0 12 12", `${token}: its own grid`);
		assert.equal(icon.props["aria-hidden"], true, `${token}: decoration — the span names it`);
	}
});

test("neither surface still renders the emoji dot or the old worktree glyph", () => {
	const client = createClient();
	const rendered = text(client.leading({ ...WORKTREE, rowToken: "push", rowSeverity: "business" })) + text(client.chip({ ...WORKTREE, dirty: true }));
	assert.ok(!/[\u{1F534}\u{1F7E1}\u{1F7E2}]/u.test(rendered), "the emoji status dot must be gone");
	assert.ok(!rendered.includes("\u2442"), "the ⑂ worktree glyph must be gone");
});

test("a non-repository, and an unresolved workspace, render no mark", () => {
	const client = createClient();
	assert.equal(client.chip({ git: false }), null, "the chip renders nothing without a repository");
	assert.equal(client.chip(void 0), null, "and nothing while the target is unresolved");
	assert.equal(client.leading({ git: false }), null, "the leading cell shows nothing without a repository");
	// the glyph is ADDITIVE: upstream still renders the session title, so it
	// contributes nothing at all when it has nothing to say
	assert.equal(client.leading({ git: false }), null, "and no glyph");
});

// ---------------------------------------------------------------------------
// the leading-cell token glyph — upstream's own seat, on every install
// ---------------------------------------------------------------------------

/** A stand-in for the shell's standard kit: a selector hook over the sessions store. */
const sessionsWithRunning = (running) => (select) => select({ byId: { "s-1": { running } } });

test("LeadingTokenGlyph renders the token as one icon with the token colour and name", () => {
	const client = createClient();
	for (const [token, glyph, severity] of TOKENS) {
		const cell = client.leading(withToken(token));
		assert.equal(cell.type, "span");
		assert.equal(cell.props.role, "img", `${token}: the icon is the accessible name here`);
		assert.equal(cell.props["aria-label"], "git action: " + token, `${token}: the word is the name`);
		assert.equal(cell.props["aria-hidden"], void 0, `${token}: NOT decoration — no word sits beside it`);
		assert.match(cell.props.style.color, new RegExp(`state-${severity}-primary`), `${token} is ${severity}`);
		assert.equal(cell.props.style.fontSize, "13px", `${token}: the text size`);
		if (DRAWN.has(token)) {
			assert.equal(text(cell), "", `${token}: a drawn arrow carries no text`);
			assert.equal(hasSvg(cell), true, `${token}: the arrow is drawn`);
			assert.equal(cell.props.style.fontWeight, void 0, `${token}: drawing needs no weight`);
		} else {
			assert.equal(text(cell), glyph, `${token}: exactly one glyph, no word`);
			assert.equal(typeof cell.props.children, "string", `${token}: a single text node`);
		}
	}
});

test("the chip icon uses the same size and colour rule as the row icon", () => {
	const client = createClient();
	for (const token of ["push", "commit"]) {
		const icon = elements(client.chip(withToken(token)))
			.find((el) => el.props?.["aria-label"] === "git action: " + token);
		assert.ok(icon !== void 0, `${token}: the chip draws an icon`);
		assert.equal(icon.props.style.fontSize, "13px", `${token}: the same text size`);
		assert.match(icon.props.style.color, new RegExp(`state-${SEVERITY[token]}-primary`), `${token}: the severity colour`);
		assert.equal(hasSvg(icon), DRAWN.has(token), `${token}: drawn only when hairline`);
	}
});

test("the card's action row carries the icon for every token", () => {
	const client = createClient();
	for (const token of ["push", "commit"]) {
		const row = client.rowDetail({ ...MAIN, rowToken: token, rowSeverity: SEVERITY[token] });
		const icon = elements(row).find((el) => el.props?.["aria-hidden"] === true);
		assert.ok(icon !== void 0, `${token}: the card draws an icon`);
		assert.equal(icon.props.style.fontWeight, 700, `${token}: bold in the card`);
		assert.equal(hasSvg(icon), DRAWN.has(token), `${token}: drawn only when hairline`);
	}
});

test("the PR token's state glyph takes the CI colour, and the number stays muted", () => {
	const client = createClient();
	const cases = [
		["passing", "state-success-primary", "\u2713"],
		["failing", "state-error-primary", "\u2717"],
		["pending", "state-warn-primary", "\u2026"]
	];
	for (const [state, colour, glyph] of cases) {
		const chip = client.chip({ ...MAIN, pr: { number: 18, state, open: true } });
		const span = elements(chip).find((el) => el.props?.children === " " + glyph);
		assert.ok(span !== void 0, `${state}: the state glyph is its own span`);
		assert.match(span.props.style.color, new RegExp(colour), `${state}: the glyph is coloured`);
		assert.ok(text(chip).includes("PR#18 " + glyph), `${state}: the token still reads as one run`);
	}
	// no state glyph: nothing extra is added to the token
	const quiet = client.chip({ ...MAIN, pr: { number: 18, state: "none", open: true, draft: true } });
	assert.ok(!elements(quiet).some((el) => typeof el.props?.children === "string" && el.props.children.startsWith(" \u2713")), "no tick without a passing state");
	// the plain formatter, which the internals export keeps, is unchanged
	assert.equal(client.internals.formatPrToken({ pr: { number: 42, state: "failing" } }), " PR#42 \u2717");
});

test("the row's hover card explains the glyph, using the row's own hover", () => {
	// The leading glyph carries no tooltip of its own: the row is already a
	// HoverCard anchor, so the explanation rides the SAME card the session line
	// uses. Word and reason come from the same node-half rule, and the card's
	// action row leads with the token GLYPH in the token's colour.
	const client = createClient();
	const withGlyph = client.rowDetail({ ...MAIN, rowToken: "push", rowSeverity: "business", rowTokenWhy: "no upstream configured" });
	// the drawn arrow contributes no TEXT, so the value starts at the separator space
	assert.deepEqual(rows(withGlyph), [{ label: "action", value: " push \u2014 no upstream configured" }]);
	const glyph = elements(withGlyph).find((element) => element.props?.["aria-hidden"] === true);
	assert.ok(glyph !== void 0, "the icon is decoration; the word follows it");
	assert.equal(hasSvg(glyph), true, "a hairline token is drawn");
	assert.match(glyph.props.style.color, /state-business-primary/, "painted in the token's own colour");
	// a TEXT token keeps its text glyph
	const commit = client.rowDetail({ ...MAIN, rowToken: "commit", rowSeverity: "business", rowTokenWhy: "ready" });
	const commitGlyph = elements(commit).find((element) => element.props?.["aria-hidden"] === true);
	assert.equal(text(commitGlyph), "\u271A", "the text glyph is text");
	assert.deepEqual(rows(commit), [{ label: "action", value: "\u271A commit \u2014 ready" }]);
	// no reason from the node half still names the action
	assert.deepEqual(rows(client.rowDetail({ ...MAIN, rowToken: "push", rowSeverity: "business" })), [{ label: "action", value: " push" }]);
	// action first, then the checkout; and nothing at all when the row has neither
	// a token nor anything else to name
	assert.deepEqual(
		rows(client.rowDetail({
			branch: "feat/x", isWorktree: true, worktreeName: "hotfix-tree",
			rowToken: "merge", rowSeverity: "success", rowTokenWhy: "pull request 9 is ready to merge"
		})),
		[
			{ label: "action", value: " merge \u2014 pull request 9 is ready to merge" },
			{ label: "checkout", value: "hotfix-tree on feat/x" }
		]
	);
	assert.equal(client.rowDetail({ ...MAIN }), null);
});

test("the row card FILLS the hover card, so its values wrap instead of overflowing", () => {
	// Upstream's HoverCard is a fixed 244px box. A `max-content` stack overflows it
	// without wrapping — the bug this pins. The card fills the box instead.
	const client = createClient();
	const card = client.rowDetail({
		branch: "chore/global-skills-tiering",
		isWorktree: true,
		worktreeName: "global-skills-tiering",
		worktreeFollowed: true,
		rowToken: "push", rowSeverity: "business",
		rowTokenWhy: "1 ahead of origin/chore/global-skills-tiering",
		pr: { number: 391, state: "passing" }
	});
	assert.equal(card.props.style.width, "100%", "the stack fills the hover card");
	assert.equal(card.props.style.maxWidth, "100%", "and never exceeds it");
	const parsed = rows(card);
	assert.deepEqual(parsed.map((row) => row.label), ["action", "checkout", "pull request"]);
	for (const row of parsed) assert.ok(row.value.length > 0, `row ${row.label} has a value`);
	const value = elements(card).find((element) => element.props?.style?.overflowWrap === "anywhere");
	assert.ok(value !== void 0, "the value cell breaks a long unbroken name");
	assert.equal(value.props.style.whiteSpace, "normal", "and is allowed to wrap");
});

test("the chip card and the row card render the SAME action sentence", () => {
	// The acceptance criterion for the shared helper: one checkout, one action
	// sentence, whichever card renders it. The chip card shows it as a heading
	// (actionHeader) and the row card as an action row (actionRow); both call the
	// same actionRow producer, so byte equality must hold.
	const client = createClient({ tooltip: true });
	const info = {
		...MAIN,
		rowToken: "push", rowSeverity: "business",
		rowTokenWhy: "no upstream configured",
		next: { args: "push", why: "no upstream configured", what: "publish feat/x for the first time", primary: true }
	};
	const tooltip = elements(expand(client.rawChip(info))).find((element) => element.type === "Tooltip");
	assert.ok(tooltip !== void 0, "the chip card is wrapped in the Tooltip primitive");
	const body = expand(tooltip.props.label());
	const header = elements(body).find((element) => element.props?.style?.fontWeight === 600);
	const rowAction = rows(client.rowDetail(info)).find((row) => row.label === "action");
	assert.ok(header !== void 0 && rowAction !== void 0, "both cards render the action sentence");
	assert.equal(text(header).trim(), rowAction.value.trim(), "one action sentence, two cards");
});

test("LeadingTokenGlyph renders nothing with no token — the mark is retired", () => {
	const client = createClient();
	assert.equal(client.leading({ ...MAIN, dirty: false }), null, "clean and in sync: no action, no icon");
	assert.equal(client.leading({ ...WORKTREE, dirty: false }), null, "a linked worktree is the same: no token, no icon");
	// and nothing at all for a non-repository, or a target that is not resolved
	assert.equal(client.leading({ git: false }), null, "no repository, no cell");
	assert.equal(client.leading(void 0), null, "unresolved target, no cell");
});

test("LeadingTokenGlyph asks for session AND PR state, once", () => {
	// The glyph and the row's hover card ask the SAME question, so they resolve to
	// one cache entry and one in-flight read.
	const client = createClient();
	client.leading(withToken("push"));
	assert.deepEqual(client.requests, ["session=s-1&pr=1"], "one session+PR request, nothing else");
	// and the PR token it receives is what the card shows
	assert.equal(text(client.leading({ ...MAIN, rowToken: "commit", rowSeverity: "business" })), "\u271A", "a text token reaches the glyph");
});

test("LeadingTokenGlyph hides while the session runs a turn", () => {
	const client = createClient();
	assert.equal(hasSvg(client.leading(withToken("push"), { useSessions: sessionsWithRunning(false) })), true, "the arrow while idle");
	assert.equal(client.leading(withToken("push"), { useSessions: sessionsWithRunning(true) }), null, "nothing during a turn");
});

