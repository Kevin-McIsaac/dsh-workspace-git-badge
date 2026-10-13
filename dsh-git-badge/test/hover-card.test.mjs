/**
 * The input chip's hover card and PR/CI token.
 *
 * Two contracts are under test, and the first is a performance one:
 *
 *  1. LAZINESS. The card's fields cost a `log -10` plus a stash list, so the chip
 *     must not ask for them until a pointer rests on it — the base request asks
 *     for the PR token only, and the row asks for neither.
 *  2. GRACEFUL ABSENCE. A shell without the Tooltip primitive still gets a
 *     working badge, and a response with no `pr` renders exactly the chip it
 *     rendered before `gh` existed.
 *
 * The bundle is loaded with a stub loader (test-support/client.mjs): no browser,
 * no fetch, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient, elements, expand, rows, sessionsWithRunning, text } from "../test-support/client.mjs";

/**
 * The ORDINARY status response — everything a plain (no `detail=1`) fetch
 * carries. Loosely "the chip before anyone hovers it".
 */
const BASE = {
	branch: "main",
	upstream: "origin/main",
	ahead: 1,
	behind: 2,
	dirty: true,
	stagedFiles: 2,
	unstagedFiles: 1,
	untrackedFiles: 3,
	untrackedMode: "all",
	operation: "rebase",
	pr: { number: 142, state: "failing", draft: true, review: "REVIEW_REQUIRED", open: true }
};

/** The superset a `detail=1` fetch adds — the fields the hover card unlocks. */
const DETAIL = {
	...BASE,
	lastCommits: [
		{ hash: "abc1234", subject: "fix the thing", when: "2 hours ago" },
		{ hash: "def5678", subject: "add another thing", when: "yesterday" }
	],
	stashCount: 2,
	untrackedNames: ["notes/todo.txt", "scratch.md"],
	untrackedNamesTotal: 5,
	unstagedNames: ["edited.txt"],
	unstagedNamesTotal: 1,
	branchCommits: [
		{ sign: "+", hash: "abc1234", subject: "fix the thing", when: "2 hours ago" },
		{ sign: "\u2212", hash: "def5678", subject: "add another thing", when: "yesterday" }
	]
};

/**
 * Render the card body. The Tooltip keeps it in a `label` FUNCTION, so the test
 * calls it the way the tooltip would when it opens. `base` and `detail` are the
 * two payloads separately on purpose: a base response never contains the
 * detail-only fields, and a test that let it would prove nothing about laziness.
 */
/** The card BODY as an element tree, so a test can read its rows. */
function cardBody(client, base, detail = base) {
	const tooltip = elements(expand(client.rawChip(base, detail))).find((el) => el.type === "Tooltip");
	assert.ok(tooltip !== void 0, "expected the status mark to be wrapped in the Tooltip primitive");
	return expand(tooltip.props.label());
}

function card(client, base, detail = base) {
	return text(cardBody(client, base, detail));
}

//#region the request contract (laziness)

test("the chip's base request asks for the PR token but NOT for detail", () => {
	// this is the whole reason the detail fields are lazy: a badge refresh fires on
	// every file edit, and detail=1 would add two git invocations to each one
	const { targetQuery } = createClient().internals;
	const base = targetQuery({ kind: "session", id: "s-1" }, { pr: true });
	assert.equal(base, "session=s-1&pr=1");
	assert.ok(!base.includes("detail"), `the base request must not ask for detail: ${base}`);
});

test("detail is requested only when explicitly asked for", () => {
	const { targetQuery } = createClient().internals;
	assert.equal(targetQuery({ kind: "session", id: "s-1" }, { pr: true, detail: true }), "session=s-1&pr=1&detail=1");
	assert.equal(targetQuery({ kind: "session", id: "s-1" }, { detail: true }), "session=s-1&detail=1");
});

test("a sidebar row asks for neither extra", () => {
	// a row surveys every workspace: N rows must never become N forge calls
	const { targetQuery } = createClient().internals;
	assert.equal(targetQuery({ kind: "workspace", id: "ws-1" }, void 0), "workspace=ws-1");
	assert.equal(targetQuery({ kind: "workspace", id: "ws-1" }, {}), "workspace=ws-1");
});

test("the leading cluster wires a pointer-enter, which is what unlocks the card's fields", () => {
	// the card lives on the LEADING CLUSTER now (the glyph is the "what does this
	// colour mean" element, and the branch is always there), so the lazy fetch is
	// gated by resting on the cluster, not the badge
	const client = createClient();
	const markEl = elements(expand(client.rawChip({ branch: "main" })))
		.find((el) => typeof el.props?.onPointerEnter === "function");
	assert.ok(markEl !== void 0, "without this the lazy fetch could never start");
});

test("the PR token wires its own pointer-enter, so its hover can fetch its commits", () => {
	// The token's hover renders `prCommits`, which is detail-only. The mark's
	// pointer-enter is not enough: a pointer that goes STRAIGHT to the token has
	// rested on nothing that fetches, so the detail request was never made and the
	// hover could not open at all. Both forms must gate the fetch themselves — the
	// link (a GitHub PR URL) and the plain span (no gh, or no GitHub remote).
	const client = createClient({ tooltip: true });
	const tokenFor = (pr) => elements(expand(client.rawChip({ ...BASE, pr })))
		.find((el) => typeof el.props?.["aria-label"] === "string" && el.props["aria-label"].startsWith("pull request 47"));
	const plain = tokenFor({ number: 47, state: "passing", open: true });
	assert.ok(plain !== void 0, "the plain token must be in the tree");
	assert.equal(typeof plain.props.onPointerEnter, "function", "the plain token must enable the detail fetch itself");
	const link = tokenFor({ number: 47, state: "passing", open: true, url: "https://github.com/o/r/pull/47" });
	assert.ok(link !== void 0, "the linked token must be in the tree");
	assert.equal(typeof link.props.onPointerEnter, "function", "the linked token must enable the detail fetch itself");
});

test("the client tags an id safely, so a crafted id cannot forge a second parameter", () => {
	const { targetQuery } = createClient().internals;
	const query = targetQuery({ kind: "session", id: "a&detail=1&pr=1" }, {});
	assert.equal(query, "session=a%26detail%3D1%26pr%3D1");
});

//#endregion

//#region the Tooltip primitive is optional

test("the chip renders WITHOUT the Tooltip primitive, just uncarded", () => {
	// the shell seeds primitives; if it ever stops, the badge must survive and only
	// the card should be lost
	const client = createClient({ tooltip: false });
	const raw = client.rawChip({ ...DETAIL });
	assert.equal(raw.type, "span", "the chip itself must still render");
	assert.equal(elements(expand(raw)).some((el) => el.type === "svg"), false, "and it draws no mark");
	assert.ok(text(expand(raw)).includes("main"), "and the branch");
});

test("with the primitive present the MARK is wrapped, and the card is built lazily", () => {
	const client = createClient({ tooltip: true });
	const raw = client.rawChip({ ...DETAIL });
	// the card's anchor is the status mark, NOT the badge: the badge carries the
	// branch pull-down, and a card opening sideways from the branch text would
	// fight the very menu the row now offers
	const tooltip = elements(expand(raw)).find((el) => el.type === "Tooltip");
	assert.ok(tooltip !== void 0, "the mark is handed to the Tooltip component");
	// the label is a FUNCTION, so the card's tree is only built when it opens
	assert.equal(typeof tooltip.props.label, "function");
	assert.equal(tooltip.props.side, "top", "the card opens above the input row");
	// and the badge itself is not the anchor: the chip root is a plain span
	assert.equal(raw.type, "span");
});

test("every hover surface is wrapped before its data lands, so the first hover opens", () => {
	// Regression: the Tooltip primitive is uncontrolled (it has no `open` prop)
	// and opens on the CHILD's mouseenter. A wrapper mounted only after the lazy
	// detail arrives therefore cannot open for the pointer that fetched it — the
	// pointer has to leave and return, which was reported as "the first hover does
	// nothing, the second works". So all THREE wrappers must exist with NO detail
	// payload (hover: false), and each label must degrade to the base response
	// rather than claim an empty list.
	const client = createClient({ tooltip: true });
	const base = { ...BASE };
	const wrappers = elements(expand(client.rawChip(base))).filter((el) => el.type === "Tooltip");
	assert.equal(wrappers.length, 3, "leading cluster + count + PR token are all wrapped");
	const labels = wrappers.map((el) => text(expand(el.props.label()))).join(" | ");
	assert.ok(labels.includes("2 staged"), `the count names the breakdown: ${labels}`);
	assert.ok(!labels.includes("no changed files"), "not a false empty-list claim before the names arrive");
	assert.ok(labels.includes("#142"), `the token names the PR while its commits load: ${labels}`);
	assert.ok(!labels.includes("no commits beyond the base branch"), "not a false empty-PR claim before the commits arrive");

	// and the leading cluster's child keeps its element type once detail lands: a
	// span -> anchor swap would remount the node under the resting pointer
	const leadingWrapper = (c, detail) => elements(expand(c.rawChip(base, detail)))
		.filter((el) => el.type === "Tooltip")
		.find((el) => text(expand(el.props.children)).includes(base.branch));
	assert.equal(leadingWrapper(client).props.children.type, "span", "the cluster's child, before detail");
	// hover: true is what serves the lazy detail slot — the harness models laziness
	const online = createClient({ tooltip: true, hover: true });
	const stated = leadingWrapper(online, { ...base, compareUrl: "https://github.com/owner/repo/compare/main...main" });
	assert.equal(stated.props.children.type, "span", "and still a span after the compare URL arrives");
	assert.ok(elements(stated.props.children).some((el) => el.type === "a"), "while the anchor itself is nested INSIDE that stable span");
});

test("the boot log says which hover-card path was taken", () => {
	// the primitive comes from the SHELL, so a missing seed must be REPORTED rather
	// than looking like a missing feature — the try/catch keeps the badge working,
	// which would otherwise make that failure completely silent
	const withPrimitive = createClient({ tooltip: true }).logs.join("\n");
	assert.match(withPrimitive, /hover card = on/, `expected an "on" report, got: ${withPrimitive}`);
	const withoutPrimitive = createClient({ tooltip: false }).logs.join("\n");
	assert.match(withoutPrimitive, /hover card = off/, `expected an "off" report, got: ${withoutPrimitive}`);
	assert.match(withoutPrimitive, /Tooltip/, "and the report should name the missing primitive");
});

//#endregion

//#region the card body

test("the card spells out the checkout's verdict, including the file breakdown", () => {
	// branch/upstream/sync moved to the branch name's hover (the lineage surface)
	const body = card(createClient({ tooltip: true, hover: true }), BASE);
	assert.ok(!body.includes("origin/main"), "upstream is lineage, not the card's");
	assert.ok(!body.includes("\u21911 \u21932"), "sync too");
	// the chip's single ✎n split into what it actually is
	assert.ok(body.includes("2 staged"), `staged: ${body}`);
	assert.ok(body.includes("1 unstaged"), `unstaged: ${body}`);
	assert.ok(body.includes("3 untracked"), `untracked: ${body}`);
	assert.ok(body.includes("rebase"), "the paused operation");
});

test("a clean tree says so rather than rendering an empty breakdown", () => {
	const body = card(createClient({ tooltip: true, hover: true }), { branch: "main", dirty: false });
	assert.ok(body.includes("clean"), `expected an explicit clean: ${body}`);
});

test("a branch with no pull request says so on the state row", () => {
	const rendered = client_labels(createClient({ tooltip: true, hover: true }), { branch: "feat/x", dirty: false });
	assert.ok(rendered.includes("no pull request"), `the state row states the fact: ${rendered}`);
});

test("the default branch is named as the base, never as a branch with no PR", () => {
	// `main` is where pull requests merge INTO, and none is ever opened FROM it,
	// so "no pull request" there nags for something that cannot exist. The node
	// half already flags the default branch for exactly this suppression; the
	// always-render row (0.17.0) only ever made sense on a feature branch.
	const rendered = client_labels(createClient({ tooltip: true, hover: true }), {
		branch: "main",
		upstream: "origin/main",
		defaultBranch: true,
		dirty: false
	});
	assert.ok(rendered.includes("base branch"), `the base-branch statement: ${rendered}`);
	assert.ok(!rendered.includes("no pull request"), `not a missing-PR nag: ${rendered}`);
});

test("the default branch does not state base-relative counts against itself", () => {
	// "2 ahead, 1 behind main" WHILE ON main is self-referential, and that
	// divergence is already the chip's own arrow token.
	const rendered = client_labels(createClient({ tooltip: true, hover: true }), {
		branch: "main",
		upstream: "origin/main",
		defaultBranch: true,
		dirty: false,
		mainAhead: 2,
		mainBehind: 1
	});
	assert.ok(!rendered.includes("behind main"), `no self-referential counts: ${rendered}`);
});

/** All hover labels of the chip (mark card + branch lineage + count names). */
function client_labels(client, base, detail = base) {
	const rendered = client.rawChip(base, detail);
	return elements(expand(rendered))
		.filter((el) => el.type === "Tooltip")
		.map((el) => text(expand(el.props.label())))
		.join(" | ");
}

test("the collapsed untracked fallback is disclosed in the card", () => {
	// the node half reports which mode answered precisely so this can be said: an
	// under-count must never be presented as exact
	const body = card(createClient({ tooltip: true, hover: true }), {
		branch: "main",
		dirty: true,
		untrackedFiles: 1,
		untrackedMode: "collapsed"
	});
	assert.ok(body.includes("(collapsed)"), `expected the caveat: ${body}`);
});

test("the card merges the checkout verdict and the branch lineage, without the count's file list", () => {
	// ONE card now: the leading cluster (glyph + branch) opens the checkout rows
	// AND the branch's lineage rows. The untracked NAMES still live on the count's
	// own tooltip, so the card does not repeat that list.
	const body = card(createClient({ tooltip: true, hover: true }), BASE, DETAIL);
	assert.ok(!body.includes("notes/todo.txt"), `no untracked row: ${body}`);
	assert.ok(!body.includes("\u2026 and 3 more"), "no untracked and-k-more");
	assert.ok(body.includes("2 stashed"), "stash stays on the card");
	assert.ok(body.includes("def5678"), "and the branch's commits are now ON the card");
});

test("the chip card splits the merge verdict from the base counts", () => {
	const client = createClient({ tooltip: true, hover: true });
	const data = {
		...BASE,
		pr: { number: 7, state: "passing", mergeState: "CLEAN", review: "APPROVED", open: true },
		mainAhead: 3,
		mainBehind: 1
	};
	const body = cardBody(client, data);
	const parsed = rows(body);
	assert.ok(parsed.some((row) => row.label === "state" && row.value.includes("ready to merge")), "the state row carries the verdict");
	assert.ok(parsed.some((row) => row.label === "base" && row.value.includes("3 ahead, 1 behind main")), "the base row carries the counts");
	// the divider names the branch section it introduces
	assert.ok(text(body).includes("branch"), "a labelled divider separates the sections");
});

test("a tokenless chip STILL opens the card from its leading cluster", () => {
	// The retired mark was the card's ONLY anchor. A clean checkout has no token,
	// so without this the whole card would be unreachable. The cluster — the glyph
	// when there is one, plus the branch, which ALWAYS exists — is the anchor.
	const client = createClient({ tooltip: true, hover: true });
	const clean = { branch: "feat/x", upstream: "origin/feat/x", ahead: 0, behind: 0, dirty: false };
	const raw = client.rawChip(clean);
	const tooltip = elements(expand(raw)).find((el) => el.type === "Tooltip");
	assert.ok(tooltip !== void 0, "the cluster is wrapped even with no token");
	assert.ok(text(expand(tooltip.props.children)).includes("feat/x"), "and the branch name is inside that anchor");
	const body = text(expand(tooltip.props.label()));
	assert.ok(body.includes("no pull request"), `the card still renders: ${body}`);
	assert.ok(!body.includes("action"), "with no action row, because there is no token");
});

test("the card names the linked worktrees the session is NOT following", () => {
	// This row exists to make one failure visible. A registration is written
	// OUTSIDE the repository, so a file sandbox or a read-only home can refuse it;
	// the write fails, the badge goes on describing the session's own checkout, and
	// nothing on screen distinguishes that from a session with nothing to follow.
	// The node half sends the count under detail=1, and the card is where it lands.
	const client = createClient({ tooltip: true, hover: true });
	const body = card(client, BASE, { ...DETAIL, linkedWorktrees: 2 });
	assert.ok(body.includes("2 linked"), `the count is on the card: ${body}`);
	assert.ok(body.includes("none registered"), "and says what it means");
	assert.ok(body.includes("npx dsh-git-badge checkout"), "and carries the command that fixes it");
	// and it stays off the card when there is nothing to report
	const quiet = card(client, BASE, DETAIL);
	assert.ok(!quiet.includes("none registered"), `no row without a count: ${quiet}`);
});

test("the leading card carries the branch's lineage, including its commits", () => {
	// The lineage is no longer a SEPARATE card: it is the bottom half of the one
	// card the leading cluster opens. Identify that label by its commit hashes.
	const client = createClient({ tooltip: true, hover: true });
	const rendered = client.rawChip(BASE, DETAIL);
	const labels = elements(expand(rendered)).filter((el) => el.type === "Tooltip").map((el) => text(expand(el.props.label())));
	const leading = labels.find((l) => l.includes("abc1234"));
	assert.ok(leading !== void 0, `expected the lineage label: ${JSON.stringify(labels)}`);
	// the state row is the only lineage row for this fixture (no base counts),
	// and it always renders
	assert.ok(leading.includes("state"), "the state row");
	assert.ok(!leading.includes("origin/main"), "upstream row is gone — redundant with merge");
	assert.ok(!leading.includes("\u2191"), "sync arrows are gone — same fact, said in words");
	assert.ok(leading.includes("abc1234"), "the branch's commits, no heading — the lines are the label");
});

test("the chip card leads with the action header, and the server's verdict is the next step", () => {
	// clean feature branch, pushed, no PR: the picker offers /gh pr (an extra),
	// but the server's next is null — so the card must stay quiet rather than
	// promoting that extra into its next line. No rowToken either, so no header.
	const client = createClient({ tooltip: true, hover: true });
	const clean = { branch: "feat/x", upstream: "origin/feat/x", ahead: 0, behind: 0, dirty: false };
	const cleanBody = card(client, clean);
	assert.ok(!cleanBody.includes("action"), `no header without a token: ${cleanBody}`);
	assert.ok(!cleanBody.includes("next"), `no next step when the server suggests nothing: ${cleanBody}`);
	// When the server DOES suggest, the next step is its suggestion — `next` is
	// the whole contract, so the fixture supplies it the way the response does.
	// The action header comes from the SAME node rule as the icon.
	const dirty = {
		...clean,
		dirty: true,
		stagedFiles: 2,
		rowToken: "commit", rowSeverity: "business",
		rowTokenWhy: "work to commit: 2 staged",
		next: { args: "commit", why: "work to commit: 2 staged", what: "commit the staged changes" }
	};
	const body = cardBody(client, dirty);
	// the action sentence is the HEADER now, not a labelled row
	const header = elements(body).find((el) => el.props?.style?.fontWeight === 600);
	assert.ok(header !== void 0, "the action header leads the card");
	assert.match(text(header), /commit \u2014 work to commit: 2 staged/, "and mirrors the icon's word and reason");
	const parsed = rows(body);
	assert.ok(parsed.some((row) => row.label === "next step" && row.value.includes("/gh commit")), "the server's suggestion is the next step row");
	// and the action sentence moved out of the row list
	assert.ok(!parsed.some((row) => row.label === "action"), "the action moved out of the row list");
});

test("the PR token's hover lists only the commits in that PR", () => {
	const client = createClient({ tooltip: true, hover: true });
	const base = { ...BASE, pr: { number: 47, state: "passing", open: true } };
	const detail = {
		...base,
		prCommits: [
			{ hash: "aaa1111", subject: "first in the PR", when: "3 hours ago" },
			{ hash: "bbb2222", subject: "second in the PR", when: "5 minutes ago" }
		],
		prCommitsTotal: 4
	};
	const labels = elements(expand(client.rawChip(base, detail)))
		.filter((el) => el.type === "Tooltip")
		.map((el) => text(expand(el.props.label())));
	const prLabel = labels.find((l) => l.includes("aaa1111"));
	assert.ok(prLabel !== void 0, `expected a commits label on the token: ${JSON.stringify(labels)}`);
	assert.ok(prLabel.includes("first in the PR") && prLabel.includes("second in the PR"), "only this PR's commits");
	assert.match(prLabel, /\u2026 and 2 more/, "4 total - 2 shown = 2 more");
	assert.ok(!prLabel.includes("state"), "nothing else rides the token's hover");
	assert.ok(!prLabel.includes("files"), "no card content bleeds in");
	// the token itself is still rendered
	assert.ok(text(expand(client.chip(base, detail))).includes("PR#47"));
	// no commits in the PR (nothing beyond the base) → the token stays plain
	const plain = elements(expand(client.rawChip(base, { ...base })))
		.filter((el) => el.type === "Tooltip")
		.map((el) => text(expand(el.props.label())));
	assert.equal(plain.some((l) => l.includes("PR#47")), false, "no tooltip without commits");
});

test("the PR hover's commit lines align exactly like the branch hover's", () => {
	// The visible contract: a FIXED-WIDTH hash cell, so every description starts on
	// the same column in both lists. Both now come from one renderer (CommitLine),
	// because the PR list had drifted — it put the hash in the card's label style,
	// whose minWidth/flex only apply inside a flex row, so on an inline span they
	// did nothing: no gap after the hash, and the descriptions never lined up.
	const client = createClient({ tooltip: true, hover: true });
	const base = { ...BASE, pr: { number: 47, state: "passing", open: true } };
	const detail = {
		...base,
		branchCommits: [{ sign: "+", hash: "aaa1111", subject: "on this branch", when: "3 hours ago" }],
		prCommits: [{ hash: "bbb2222", subject: "in this PR", when: "5 minutes ago" }],
		prCommitsTotal: 1
	};
	const labels = elements(expand(client.rawChip(base, detail)))
		.filter((el) => el.type === "Tooltip")
		.map((el) => expand(el.props.label()));
	const cellIn = (mentions, hashText) => {
		const label = labels.find((l) => text(l).includes(mentions));
		assert.ok(label !== void 0, `expected a hover mentioning "${mentions}": ${JSON.stringify(labels.map(text))}`);
		const cell = elements(label).find((el) => text(el) === hashText);
		assert.ok(cell !== void 0, `expected a hash cell for ${hashText}`);
		return cell;
	};
	const branchCell = cellIn("on this branch", "+aaa1111");
	const prCell = cellIn("in this PR", "bbb2222");
	// the mechanism, asserted on the PR cell directly (not just "both are equal",
	// which two equally-broken cells would also satisfy)
	assert.equal(prCell.props.style.fontFamily, "monospace", "a monospace hash keeps the column stable");
	assert.equal(prCell.props.style.display, "inline-block", "minWidth needs a non-inline box to apply");
	assert.equal(prCell.props.style.minWidth, "68px", "the fixed column every description starts on");
	assert.deepEqual(prCell.props.style, branchCell.props.style, "the branch hover's cell, exactly");
});

test("the detail fields appear only once detail has been fetched", () => {
	const without = card(createClient({ tooltip: true, hover: false }), BASE, DETAIL);
	assert.ok(!without.includes("stashed"), "no stash before the detail request");
	const withDetail = card(createClient({ tooltip: true, hover: true }), BASE, DETAIL);
	assert.ok(withDetail.includes("2 stashed"), "the stash count");
});

//#endregion

//#region the followed worktree

test("the card names WHICH worktree the badge describes", () => {
	// The chip shows the branch alone, so this row is the only place a tree is
	// identified.
	const client = createClient({ tooltip: true });
	const followed = card(client, {
		...BASE,
		branch: "chore/global-skills-tiering",
		isWorktree: true,
		worktreeName: "global-skills-tiering",
		worktreeFollowed: true
	});
	assert.ok(followed.includes("worktree"), `expected the worktree row: ${followed}`);
	assert.ok(followed.includes("global-skills-tiering"), `expected the tree's name: ${followed}`);
	// a worktree the session is genuinely in is named the same way
	const own = card(client, { ...BASE, branch: "feat/x", isWorktree: true, worktreeName: "hotfix-tree" });
	assert.ok(own.includes("hotfix-tree"), `expected the tree's name: ${own}`);
	assert.ok(!own.includes("registered"), `no registration wording for a plain worktree: ${own}`);
	// and a main checkout has no tree to name
	assert.ok(!card(client, BASE).includes("worktree"));
});

test("the card names the conversation's OWN checkout when the badge followed a worktree", () => {
	// Once the chip's branch and counts describe a followed worktree, the
	// checkout's own state is nowhere else on screen — that is the whole reason
	// this row exists. It is detail-gated like every other expensive field.
	const client = createClient({ tooltip: true });
	const followed = {
		...BASE,
		branch: "chore/global-skills-tiering",
		isWorktree: true,
		worktreeName: "global-skills-tiering",
		worktreeFollowed: true,
		checkout: { branch: "main", dirty: true, changedFiles: 2, untrackedFiles: 1, ahead: 1, behind: 2 }
	};
	const body = card(client, followed);
	assert.ok(body.includes("own checkout"), `expected the own-checkout row: ${body}`);
	assert.ok(body.includes("main \u00B7 \u270E3 \u00B7 \u21911 \u21932"), `expected the checkout's own state: ${body}`);
	assert.ok(!body.includes("chore/global-skills-tiering"), "the branch name lives on the chip, not the card");
});

test("the card has no checkout row when the badge describes the conversation's own directory", () => {
	const client = createClient({ tooltip: true });
	const body = card(client, { ...BASE, checkout: { branch: "main", dirty: false } });
	assert.ok(!body.includes("checkout"), `the row would be pure repetition: ${body}`);
});

test("a followed checkout with no checkout payload yet shows no empty row", () => {
	// the base request carries worktreeFollowed but NOT checkout: the row must wait
	// for the detail response rather than render a blank
	const client = createClient({ tooltip: true });
	const body = card(client, { ...BASE, isWorktree: true, worktreeName: "linked-tree", worktreeFollowed: true });
	assert.ok(!body.includes("checkout"), `expected no row before detail lands: ${body}`);
});

//#endregion

//#region the PR / CI token

test("the chip carries the PR number and CI state", () => {
	const client = createClient();
	const rendered = text(client.chip({ branch: "main", dirty: false, pr: { number: 142, state: "failing" } }));
	assert.ok(rendered.includes("PR#142"), `expected the PR token: ${rendered}`);
	assert.ok(rendered.includes("\u2717"), "a failing rollup shows the failure glyph");
});

test("the CI state is not left to a glyph alone", () => {
	// same rule the status mark follows: the token carries an accessible name
	const client = createClient();
	const chip = client.chip({ branch: "main", dirty: false, pr: { number: 142, state: "failing", draft: true } });
	const token = elements(chip).find((element) => typeof element.props?.["aria-label"] === "string" && element.props["aria-label"].startsWith("pull request"));
	assert.ok(token !== void 0, "the PR token must carry an accessible name");
	assert.equal(token.props["aria-label"], "pull request 142, checks failing, draft");
});

test("each rollup state renders its own glyph", () => {
	const client = createClient();
	const glyph = (state) => text(client.chip({ branch: "main", dirty: false, pr: { number: 1, state } }));
	assert.ok(glyph("passing").includes("\u2713"));
	assert.ok(glyph("pending").includes("\u2026"));
	assert.ok(glyph("failing").includes("\u2717"));
	assert.ok(!glyph("none").includes("\u2713"), "no checks means no verdict glyph");
});

test("a draft PR says so", () => {
	const client = createClient();
	const rendered = text(client.chip({ branch: "main", dirty: false, pr: { number: 7, state: "passing", draft: true } }));
	assert.ok(rendered.includes("draft"), `expected the draft marker: ${rendered}`);
});

test("no PR field renders exactly the chip it rendered before gh existed", () => {
	// the graceful-absence contract, from the client side: a machine without gh
	// must see NO trace of the feature
	const client = createClient();
	const withPr = { branch: "main", dirty: true, changedFiles: 3 };
	const withoutPr = text(client.chip({ ...withPr, pr: void 0 }));
	const beforeFeature = text(client.chip({ branch: "main", dirty: true, changedFiles: 3 }));
	assert.equal(withoutPr, beforeFeature);
	assert.ok(!withoutPr.includes("PR#"), "no token, no trace");
});

test("the session row shows a GLYPH, never a PR token or a branch", () => {
	// The row's job is triage, so it shows the node half's token as one glyph. The
	// PR number and CI state live on the row's hover line; the chip keeps both.
	const client = createClient();
	const rendered = text(client.leading({ branch: "SECRET/BRANCH", dirty: false, rowToken: "fix CI", rowSeverity: "error", pr: { number: 142, state: "failing" } }));
	assert.equal(rendered, "\u2717", `expected the glyph alone: ${rendered}`);
	assert.ok(!rendered.includes("PR#"), "the token belongs to the chip now");
	assert.ok(!rendered.includes("SECRET/BRANCH"), `the row must not name the branch: ${rendered}`);
});

//#region the row's idle gate

/** One commit ahead of upstream, which the node half turns into the token `push`. */
const ROW_AHEAD = { branch: "feat/x", ahead: 1, rowToken: "push", rowSeverity: "business" };

test("the row's token glyph hides while the session is running a turn", () => {
	// The shell hands every slot entry the sessions store as a selector hook, which
	// is how a row can tell an idle session from one mid-turn. A turn in flight is
	// exactly when a suggestion is noise: the checkout is still moving.
	const client = createClient();
	const idle = client.leading(ROW_AHEAD, { useSessions: sessionsWithRunning(false) });
	assert.ok(elements(idle).some((el) => el.type === "svg"), `expected the arrow while idle: ${text(idle)}`);
	const busy = client.leading(ROW_AHEAD, { useSessions: sessionsWithRunning(true) });
	assert.equal(busy, null, "no icon while a turn is running");
});

test("without the standard-kit hook the row is unchanged, and the console says so", () => {
	// Absent means "cannot know", never "running": a shell that seeds no useSessions
	// must keep the glyph exactly as it was rather than blanking it.
	const client = createClient();
	const rendered = client.leading(ROW_AHEAD);
	assert.ok(elements(rendered).some((el) => el.type === "svg"), `expected the icon unchanged: ${text(rendered)}`);
	assert.ok(
		client.logs.some((line) => line.includes("session-row idle gate = off")),
		`expected the off report: ${JSON.stringify(client.logs)}`
	);
});

test("the idle gate reports ON when the shell supplies the hook", () => {
	const client = createClient();
	client.leading(ROW_AHEAD, { useSessions: sessionsWithRunning(false) });
	assert.ok(
		client.logs.some((line) => line.includes("session-row idle gate = on")),
		`expected the on report: ${JSON.stringify(client.logs)}`
	);
});

//#endregion

test("the lineage always states the state row, even with no pull request", () => {
	// the row can no longer be silent: a branch with no PR says so, and one with
	// counts speaks against the base branch in words rather than arrows
	const noPr = client_labels(createClient({ tooltip: true, hover: true }), { branch: "feat/x", dirty: false });
	const mergeRow = noPr.split(" | ").find((l) => l.includes("state"));
	assert.ok(mergeRow !== void 0, `the merge row always renders: ${noPr}`);
	assert.ok(mergeRow.includes("no pull request"));
	// ahead/behind main joins the same row when the counts are known
	const withCounts = client_labels(createClient({ tooltip: true, hover: true }), {
		...BASE,
		pr: { number: 7, state: "passing", mergeState: "CLEAN", review: "APPROVED", open: true },
		mainAhead: 3,
		mainBehind: 1
	});
	const row = withCounts.split(" | ").find((l) => l.includes("state"));
	assert.ok(row.includes("3 ahead, 1 behind main"), `counts in words: ${row}`);
	assert.ok(row.includes("ready to merge"), `and the state: ${row}`);
});

test("the lineage phrases the state blocker", () => {
	// BLOCKED must say why — a dead-end word names the next action instead.
	// Draft outranks: fixing checks on a draft is wasted work until it is
	// marked ready.
	const lineage = client_labels(createClient({ tooltip: true, hover: true }), {
		...BASE,
		pr: { number: 142, state: "failing", draft: true, review: "REVIEW_REQUIRED", open: true },
		draft: true
	});
	const mergeRow = lineage.split(" | ").find((l) => l.includes("state"));
	assert.ok(mergeRow !== void 0, `expected a merge row: ${lineage}`);
	assert.ok(mergeRow.includes("blocked: draft"), `draft outranks: ${mergeRow}`);

	const reviewBlocked = client_labels(createClient({ tooltip: true, hover: true }), {
		...BASE,
		pr: { number: 142, state: "passing", mergeState: "BLOCKED", review: "REVIEW_REQUIRED", open: true }
	});
	const mergeRow2 = reviewBlocked.split(" | ").find((l) => l.includes("state"));
	assert.ok(mergeRow2 !== void 0 && mergeRow2.includes("blocked: review required"), `review required: ${mergeRow2}`);

	// CLEAN is stated, not silent: the merge row always renders and says so
	const clean = client_labels(createClient({ tooltip: true, hover: true }), {
		...BASE,
		pr: { number: 142, state: "passing", mergeState: "CLEAN", review: "APPROVED", open: true }
	});
	const cleanRow = clean.split(" | ").find((l) => l.includes("state"));
	assert.ok(cleanRow !== void 0 && cleanRow.includes("ready to merge"), `ready: ${clean}`);
});

test("the PR is NOT in any hover: the chip token carries it", () => {
	const rendered = client_labels(createClient({ tooltip: true, hover: true }), BASE);
	assert.ok(!rendered.includes("#142"), `no PR row in the hovers: ${rendered}`);
});

//#endregion
