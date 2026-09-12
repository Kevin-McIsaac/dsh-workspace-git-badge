/**
 * parseStatusV2 table tests — the pure half of the status pipeline, no git
 * process involved. Every record shape here is copied from real
 * `git status --porcelain=v2 --branch` output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStatusV2 } from "../lib/index.js";

test("clean branch with upstream: branch, upstream and ahead/behind", () => {
	const parsed = parseStatusV2([
		"# branch.oid 1111111111111111111111111111111111111111",
		"# branch.head main",
		"# branch.upstream origin/main",
		"# branch.ab +2 -3"
	].join("\n"));
	assert.deepEqual(parsed, {
		branch: "main",
		upstream: "origin/main",
		ahead: 2,
		behind: 3,
		staged: 0,
		unstaged: 0,
		unmerged: 0,
		untracked: 0
	});
});

test("detached HEAD is labelled (detached)", () => {
	assert.equal(parseStatusV2("# branch.head (detached)\n").branch, "(detached)");
});

test("no branch header at all falls back to HEAD (detached)", () => {
	assert.equal(parseStatusV2("").branch, "HEAD (detached)");
});

test("no upstream header leaves upstream and ahead/behind undefined", () => {
	const parsed = parseStatusV2("# branch.head main\n");
	assert.equal(parsed.upstream, undefined);
	assert.equal(parsed.ahead, undefined);
	assert.equal(parsed.behind, undefined);
});

test("in-sync upstream (+0 -0) parses to two zeroes, not undefined", () => {
	const parsed = parseStatusV2("# branch.head main\n# branch.ab +0 -0\n");
	assert.equal(parsed.ahead, 0);
	assert.equal(parsed.behind, 0);
});

test("staged-only change counts on the index side", () => {
	const parsed = parseStatusV2("1 M. N... 100644 100644 100644 aaa bbb path.txt");
	assert.equal(parsed.staged, 1);
	assert.equal(parsed.unstaged, 0);
});

test("unstaged-only change counts on the worktree side", () => {
	const parsed = parseStatusV2("1 .M N... 100644 100644 100644 aaa bbb path.txt");
	assert.equal(parsed.staged, 0);
	assert.equal(parsed.unstaged, 1);
});

test("a partially staged file counts on BOTH sides", () => {
	const parsed = parseStatusV2("1 MM N... 100644 100644 100644 aaa bbb path.txt");
	assert.equal(parsed.staged, 1);
	assert.equal(parsed.unstaged, 1);
});

test("unmerged, untracked and renamed records each count once", () => {
	const parsed = parseStatusV2([
		"u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.txt",
		"? newdir/",
		"2 R. N... 100644 100644 100644 aaa bbb R100 new.txt\told.txt"
	].join("\n"));
	assert.equal(parsed.unmerged, 1);
	assert.equal(parsed.untracked, 1);
	assert.equal(parsed.staged, 1);
	assert.equal(parsed.unstaged, 0);
});

test("a directory-style untracked line is a single entry at this layer", () => {
	// This is the shape git emits WITHOUT --untracked-files=all. The parser is
	// faithful to its input by design; the -uall fix lives in gitStatus, and
	// status-git.test.mjs pins the end-to-end count.
	assert.equal(parseStatusV2("? newdir/\n").untracked, 1);
});
