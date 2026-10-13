/**
 * The leading-cell fallback (the row's token when a status dot owns the cell).
 *
 * Upstream mounts `sidebar.session.row.leading` ONLY while a row's primary state
 * is idle: a row showing a solid status dot — `done` (a background turn finished
 * unread, green) or `warning` (a pending interaction, orange) — keeps that cell,
 * so the real seat is never called. The fallback rides the row-action strip
 * instead, which is hidden by CSS rather than unmounted, marks the row, and the
 * injected stylesheet paints the node half's token over the dot.
 *
 * The DOM glue (a layout effect plus a MutationObserver) cannot run under the
 * stub react, so the decision and the attribute writes live in
 * `__internals.syncRowFallback` and are driven here against a fake row. The
 * contract worth protecting is that the CELL decides: the fallback appears only
 * when a solid dot occupies the cell, it never replaces `in sync`, and it always
 * leaves the row exactly as upstream left it when the action goes away.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../test-support/client.mjs";

const client = createClient();
const {
	fallbackGlyph,
	glyphMaskDataUri,
	syncRowFallback,
	clearFallbackMark,
	ROW_FALLBACK_CSS,
	ROW_FALLBACK_DOT
} = client.internals;

/** A row element whose first child is the 16px leading cell. */
function fakeRow({ dot } = {}) {
	const attributes = new Map();
	const properties = new Map();
	const cell = {
		// Answer the way the browser would: the selector matches this cell only
		// when it names this dot's state. That is what proves `ongoing` (the
		// running spinner) cannot be mistaken for a solid dot.
		querySelector: (selector) => (dot !== void 0 && selector.includes('"' + dot + '"') ? { "data-state": dot } : null)
	};
	return {
		firstElementChild: cell,
		setAttribute: (name, value) => attributes.set(name, value),
		removeAttribute: (name) => attributes.delete(name),
		style: {
			setProperty: (name, value) => properties.set(name, value),
			removeProperty: (name) => properties.delete(name)
		},
		attributes,
		properties
	};
}

const PUSH = { git: true, rowToken: "push", rowSeverity: "business" };

test("the fallback triggers on the cell's own solid dots, never on the spinner", () => {
	assert.equal(ROW_FALLBACK_DOT, '[data-state="done"], [data-state="warning"]');
	assert.equal(ROW_FALLBACK_DOT.includes("ongoing"), false, "a running row keeps upstream's spinner");
});

test("a drawn token becomes a mask of the seat's own artwork", () => {
	const mark = fallbackGlyph("push", "business");
	assert.equal(mark.size, "12px");
	assert.match(mark.colour, /^var\(--dsw-alias-state-business-primary/);
	assert.match(mark.mask, /^url\("data:image\/svg\+xml;charset=utf-8,/);
	assert.match(mark.mask, /%3Csvg/);
	assert.match(mark.mask, /%3Cpath/);
	assert.equal(mark.glyph, void 0, "a drawn token is never also a text glyph");
});

test("merge keeps its 16px grid", () => {
	assert.equal(fallbackGlyph("merge", "success").size, "16px");
});

test("a text token keeps its character, not a mask", () => {
	const mark = fallbackGlyph("commit", "warn");
	assert.equal(mark.glyph, "\u271A");
	assert.equal(mark.mask, void 0);
	assert.match(mark.colour, /^var\(--dsw-alias-state-warn-primary/);
});

test("in sync never replaces a status dot", () => {
	assert.equal(fallbackGlyph("in sync", "success"), void 0);
});

test("no token, or a non-repository, leaves the dot alone", () => {
	assert.equal(fallbackGlyph(void 0, "success"), void 0);
	assert.equal(fallbackGlyph("", "success"), void 0);
	assert.equal(syncRowFallback(fakeRow({ dot: "done" }), { git: false }), false);
});

test("a done dot plus an action paints the overlay on the row", () => {
	const row = fakeRow({ dot: "done" });
	assert.equal(syncRowFallback(row, PUSH), true);
	assert.equal(row.attributes.get("data-git-badge-overlay"), "");
	assert.equal(row.attributes.get("data-git-badge-drawn"), "");
	assert.equal(row.properties.get("--git-badge-mask-size"), "12px");
	assert.match(row.properties.get("--git-badge-mask-src"), /^url\(/);
	assert.match(row.properties.get("--git-badge-color"), /^var\(/);
});

test("a warning dot is covered too, in text mode", () => {
	const row = fakeRow({ dot: "warning" });
	assert.equal(syncRowFallback(row, { git: true, rowToken: "commit", rowSeverity: "warn" }), true);
	assert.equal(row.attributes.has("data-git-badge-drawn"), false);
	assert.equal(row.properties.get("--git-badge-glyph"), JSON.stringify("\u271A"));
});

test("an idle cell (the real seat's) is never marked", () => {
	const row = fakeRow();
	assert.equal(syncRowFallback(row, PUSH), false);
	assert.equal(row.attributes.size, 0);
	assert.equal(row.properties.size, 0);
});

test("a running row's spinner is not a solid dot", () => {
	const row = fakeRow({ dot: "ongoing" });
	assert.equal(syncRowFallback(row, PUSH), false, "a live turn keeps upstream's own indicator");
	assert.equal(row.attributes.size, 0);
	assert.equal(row.properties.size, 0);
});

test("a dot with nothing to do is left exactly as upstream drew it", () => {
	const row = fakeRow({ dot: "done" });
	assert.equal(syncRowFallback(row, { git: true, rowToken: "in sync", rowSeverity: "success" }), false);
	assert.equal(row.attributes.has("data-git-badge-overlay"), false);
	assert.equal(row.properties.size, 0);
});

test("a stale mark is removed when the action goes away", () => {
	const row = fakeRow({ dot: "done" });
	syncRowFallback(row, PUSH);
	syncRowFallback(row, { git: true, rowToken: "in sync", rowSeverity: "success" });
	assert.equal(row.attributes.size, 0);
	assert.equal(row.properties.size, 0);
});

test("clearFallbackMark removes attributes and custom properties", () => {
	const row = fakeRow({ dot: "done" });
	syncRowFallback(row, PUSH);
	clearFallbackMark(row);
	assert.equal(row.attributes.size, 0);
	assert.equal(row.properties.size, 0);
	clearFallbackMark(null);
});

test("the stylesheet hides only the solid dots and draws both glyph modes", () => {
	assert.match(ROW_FALLBACK_CSS, /\[data-state="done"\], \[data-state="warning"\] \{ display: none; \}/);
	assert.match(ROW_FALLBACK_CSS, /:not\(:has\(\[data-git-badge-leading\]\)\)/, "the real seat always wins");
	assert.match(ROW_FALLBACK_CSS, /content: var\(--git-badge-glyph, ""\)/);
	assert.match(ROW_FALLBACK_CSS, /-webkit-mask-image: var\(--git-badge-mask-src\)/);
	assert.match(ROW_FALLBACK_CSS, /mask-size: var\(--git-badge-mask-size, 12px\)/);
});

test("glyphMaskDataUri encodes the SVG for a CSS url()", () => {
	const uri = glyphMaskDataUri({ size: 12, viewBox: "0 0 12 12", shapes: [{ circle: true }] });
	assert.match(uri, /%3Ccircle/);
	assert.equal(uri.includes('"'), true, "the url() wrapper keeps its quotes until the data is encoded");
	assert.equal(uri.slice(0, 5), 'url("');
});

test("the marker is registered on the always-mounted strip and renders hidden", () => {
	const rendered = client.fallback({ rowToken: "push", rowSeverity: "business" });
	assert.equal(rendered.props.style.display, "none");
	assert.equal(rendered.props["aria-hidden"], true);
	assert.equal(rendered.props.ref.current, null);
});
