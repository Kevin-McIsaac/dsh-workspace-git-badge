/**
 * The PR token's LINK — input chip only.
 *
 * A token is a link only when the node half vouched for an http(s) `url`.
 * Without one it stays the plain token it has always been, so a machine with no
 * `gh` (or a branch with no PR) grows no dead link to discover.
 *
 * The second half of the contract lives here: this half re-checks the protocol
 * before an `href` exists, so a payload that somehow carried `javascript:`
 * renders as text rather than as an executable link. An `href` is the one place
 * a payload string becomes code, so the element creating it verifies its own
 * input instead of trusting an upstream guard to stay in place.
 *
 * The bundle is loaded with a stub loader (test-support/client.mjs): no browser,
 * no fetch, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient, elements, text } from "../test-support/client.mjs";

const PR = { number: 16, state: "failing", draft: false };
const PR_URL = "https://github.com/Kevin-McIsaac/dsh-workspace-git-badge/pull/16";

/** The chip's link element, when the token rendered as one. */
function anchor(chip) {
	return elements(chip).find((element) => element.type === "a") ?? null;
}

/** The chip for a PR payload, expanded. */
function chipFor(pr, options) {
	return createClient(options).chip({ branch: "main", dirty: false, pr });
}

test("an http(s) url makes the token a link to the PR", () => {
	const link = anchor(chipFor({ ...PR, url: PR_URL }));
	assert.ok(link !== null, "expected an anchor");
	assert.equal(link.props.href, PR_URL);
	// a new tab: navigating THIS one away from the app would lose the conversation
	assert.equal(link.props.target, "_blank");
	assert.equal(link.props.rel, "noopener noreferrer");
	assert.ok(text(link).includes("PR#16"), `the token is the link text: ${text(link)}`);
});

test("the link's accessible name says what it is and where it goes", () => {
	const label = anchor(chipFor({ ...PR, url: PR_URL })).props["aria-label"];
	assert.ok(label.startsWith("pull request 16, checks failing"), label);
	assert.ok(label.includes("opens on GitHub in a new tab"), label);
});

test("no url means the token is text, exactly as before the link existed", () => {
	const chip = chipFor(PR);
	assert.equal(anchor(chip), null, "no url, no link — never a dead one");
	assert.ok(text(chip).includes("PR#16"), "the token itself is unchanged");
});

test("a non-http(s) url is refused HERE too, not only upstream", () => {
	for (const url of [
		"javascript:alert(1)",
		"data:text/html,<script>alert(1)</script>",
		"file:///etc/passwd",
		"not a url at all"
	]) {
		const chip = chipFor({ ...PR, url });
		assert.equal(anchor(chip), null, `must not become an href: ${url}`);
		assert.ok(text(chip).includes("PR#16"), "the token still renders");
	}
});

test("the affordance is an underline on hover or focus, never at rest", () => {
	const rest = anchor(chipFor({ ...PR, url: PR_URL })).props.style;
	assert.equal(rest.textDecoration, "none", "at rest the token still reads as one row");
	assert.equal(rest.cursor, "pointer", "the pointer is the at-rest signal");

	// `hover: true` renders the chip as if the pointer (or focus) were already on it
	const active = anchor(chipFor({ ...PR, url: PR_URL }, { hover: true })).props;
	assert.equal(active.style.textDecoration, "underline");
	// keyboard reachability is why focus is wired to the same state
	assert.equal(typeof active.onFocus, "function", "focus is the keyboard's hover");
	assert.equal(typeof active.onPointerEnter, "function");
});

test("the sidebar row never grows a link either", () => {
	const row = createClient().row({ branch: "main", dirty: false, pr: { ...PR, url: PR_URL } }, "Project");
	assert.equal(anchor(row), null, "the row shows status and identity only");
});
