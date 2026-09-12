/**
 * The input chip's hover card and PR/CI token.
 *
 * Two contracts are under test, and the first is a performance one:
 *
 *  1. LAZINESS. The card's fields cost a `log -3` plus a stash list, so the chip
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
import { createClient, elements, expand, mark, text } from "../test-support/client.mjs";

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
	stashCount: 2
};

/**
 * Render the card body. The Tooltip keeps it in a `label` FUNCTION, so the test
 * calls it the way the tooltip would when it opens. `base` and `detail` are the
 * two payloads separately on purpose: a base response never contains the
 * detail-only fields, and a test that let it would prove nothing about laziness.
 */
function card(client, base, detail = base) {
	const rendered = client.chip(base, detail);
	assert.equal(rendered.type, "Tooltip", "expected the chip to be wrapped in the Tooltip primitive");
	return text(expand(rendered.props.label()));
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

test("the chip wires a pointer-enter, which is what unlocks the card's fields", () => {
	const client = createClient();
	const raw = client.rawChip({ branch: "main" });
	assert.equal(typeof raw.props.onPointerEnter, "function", "without this the lazy fetch could never start");
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
	assert.ok(mark(expand(raw)) !== null, "and it must still carry the status mark");
	assert.ok(text(expand(raw)).includes("main"), "and the branch");
});

test("with the primitive present the chip is wrapped, and the card is built lazily", () => {
	const client = createClient({ tooltip: true });
	const raw = client.rawChip({ ...DETAIL });
	assert.equal(typeof raw.type, "function", "the chip is handed to the Tooltip component");
	// the label is a FUNCTION, so the card's tree is only built when it opens
	const rendered = client.chip({ ...DETAIL });
	assert.equal(rendered.type, "Tooltip");
	assert.equal(typeof rendered.props.label, "function");
	assert.equal(rendered.props.side, "top", "the card opens above the input row");
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

test("the card spells out the base facts, including the file breakdown", () => {
	const body = card(createClient({ tooltip: true, hover: true }), BASE);
	assert.ok(body.includes("main"), "branch");
	assert.ok(body.includes("origin/main"), "upstream");
	assert.ok(body.includes("\u21911 \u21932"), "ahead/behind");
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

test("an unreachable upstream count is labelled, not silently blank", () => {
	const body = card(createClient({ tooltip: true, hover: true }), { branch: "main", dirty: false });
	assert.ok(body.includes("none configured"), "a local-only repo must say so");
});

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

test("the detail fields appear only once detail has been fetched", () => {
	const without = card(createClient({ tooltip: true, hover: false }), BASE, DETAIL);
	assert.ok(!without.includes("abc1234"), "no commits before the detail request");
	assert.ok(!without.includes("stashed"), "no stash before the detail request");
	const withDetail = card(createClient({ tooltip: true, hover: true }), BASE, DETAIL);
	assert.ok(withDetail.includes("abc1234"), "the short hash");
	assert.ok(withDetail.includes("fix the thing"), "the subject");
	assert.ok(withDetail.includes("2 hours ago"), "the age");
	assert.ok(withDetail.includes("2 stashed"), "the stash count");
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

test("the row ignores a PR field entirely", () => {
	// the row is status and identity only, and it never asks for pr=1
	const client = createClient();
	const rendered = text(client.row({ branch: "main", dirty: false, pr: { number: 142, state: "failing" } }, "Project 1"));
	assert.ok(!rendered.includes("PR#"), `the row must not grow a PR token: ${rendered}`);
	assert.equal(rendered, "Project 1");
});

test("the card describes the PR in words, including review and draft", () => {
	const body = card(createClient({ tooltip: true, hover: true }), BASE);
	assert.ok(body.includes("#142"), `PR number: ${body}`);
	assert.ok(body.includes("checks failing"), `CI state: ${body}`);
	assert.ok(body.includes("draft"), `draft: ${body}`);
	assert.ok(body.includes("review required"), `review decision: ${body}`);
});

//#endregion
