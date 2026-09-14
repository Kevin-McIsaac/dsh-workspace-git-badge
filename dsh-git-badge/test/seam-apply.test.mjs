/**
 * The seam patch's apply/revert guard.
 *
 * The guard is ANCHOR-BASED: apply.sh locates each block defined in seam/anchors.py
 * in the INSTALLED client.js (each must occur exactly once) and replaces it in
 * place. These tests pin the states the guard must distinguish, driving the real
 * script against a FAKE install tree (`DSH_INSTALL`) and a COPY of `seam/`, so
 * nothing here can touch the machine's actual DSH package or the repo's own
 * working files.
 *
 * History this pins against: the guard's first rule — "if the seam string is
 * present, skip" — could not tell a genuine upstream landing from an artifact
 * THIS repo had written earlier, and silently left stale patches installed. Its
 * second rule — a whole-file sha256 pin — refused every DSH release that touched
 * the file anywhere, even when the seam targets were untouched. The marker (with
 * a rev number) fixed the first; the anchors fixed the second.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { makeTempDir } from "../test-support/repo.mjs";

const exec = promisify(execFile);
const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEAM = join(PACKAGE, "..", "seam");
/** The seam scripts are repo-only (not in the published `files` list). */
const skip = existsSync(join(SEAM, "apply.sh")) ? false : "seam/ is not present in this checkout";

const MARKER = "dsh-git-badge:seam-patch";

/** A throwaway stand-in for the installed DSH package. */
async function fakeInstall(t) {
	const root = await makeTempDir(t, "dsh-seam-install-");
	const lib = join(root, "node_modules", "@deepseek-ai", "dsh-client-ui-workspace", "lib");
	await mkdir(lib, { recursive: true });
	return { root, client: join(lib, "client.js"), index: join(lib, "index.js") };
}

/** A throwaway copy of seam/, so a script run cannot write into the repo. */
async function seamCopy(t) {
	const dir = await makeTempDir(t, "dsh-seam-copy-");
	await cp(SEAM, dir, { recursive: true });
	// Drop the repo's live revert backup: it is gitignored, so its presence would
	// make these tests depend on whatever this checkout happens to hold. Each
	// test that needs a backup writes its own.
	for (const name of ["backup-client.js", "backup-index.js"]) {
		await rm(join(dir, name));
	}
	return { dir, script: join(dir, "apply.sh") };
}

async function rm(path) {
	try {
		await (await import("node:fs/promises")).rm(path);
	} catch {
		/* absent is fine */
	}
}

/** Run one apply.sh verb against the fake install; never throws. */
async function apply(script, install, verb) {
	try {
		const { stdout, stderr } = await exec("bash", [script, verb], { env: { ...process.env, DSH_INSTALL: install.root } });
		return { code: 0, out: stdout + stderr };
	} catch (error) {
		return { code: error.code ?? 1, out: String(error.stdout ?? "") + String(error.stderr ?? "") };
	}
}

const pristine = () => readFile(join(SEAM, "pristine-client.js"), "utf8");

test("apply installs over a stale artifact of ours instead of skipping it", { skip }, async (t) => {
	const install = await fakeInstall(t);
	const { dir, script } = await seamCopy(t);
	// an artifact this repo built at some earlier point: it carries the marker, so
	// its bytes are ours, but it predates the current anchors. The revert backup
	// (the bytes as found before that old patching) must be present and patchable
	// for the upgrade path to run — here, the upstream baseline.
	await writeFile(install.client, `/* ${MARKER} */\n// an older patch of ours\n`);
	await writeFile(install.index, "// index\n");
	await writeFile(join(dir, "backup-client.js"), await pristine());
	await writeFile(join(dir, "backup-index.js"), "// index\n");
	const before = await apply(script, install, "status");
	assert.match(before.out, /OUT OF DATE/, "status must recognise our own stale artifact");
	assert.equal(before.code, 0);
	const result = await apply(script, install, "apply");
	assert.match(result.out, /patched lib\/client\.js in place/, `apply must install, not skip: ${result.out}`);
	assert.equal(result.code, 0);
	const installed = await readFile(install.client, "utf8");
	assert.equal(
		installed,
		await readFile(join(SEAM, "patched-client.js"), "utf8"),
		"the current artifact is what landed"
	);
	assert.match(installed, new RegExp(MARKER), "and it still carries the marker");
	const after = await apply(script, install, "status");
	assert.match(after.out, /PATCHED — /, `status must now be current: ${after.out}`);
});

test("apply refuses a stale artifact whose backup has drifted, before overwriting anything", { skip }, async (t) => {
	const install = await fakeInstall(t);
	const { dir, script } = await seamCopy(t);
	await writeFile(install.client, `/* ${MARKER} */\n// an older patch of ours\n`);
	await writeFile(install.index, "// index\n");
	// the backup is from an older upstream whose anchors no longer resolve:
	// restoring it would overwrite the installed build with an unpatchable one
	const drifted = (await pristine()).replace(
		"function SessionHoverContent({ node, now, t }) {",
		"function SessionHoverContentV2({ node, now, t }) {"
	);
	await writeFile(join(dir, "backup-client.js"), drifted);
	const installedBefore = await readFile(install.client, "utf8");
	const result = await apply(script, install, "apply");
	assert.equal(result.code, 1, "the upgrade must refuse");
	assert.match(result.out, /REFUSING/);
	assert.equal(await readFile(install.client, "utf8"), installedBefore, "the installed file was not overwritten");
});

test("apply refuses an unrecognised upstream build rather than overwriting it", { skip }, async (t) => {
	const install = await fakeInstall(t);
	const { script } = await seamCopy(t);
	const stranger = "// a newer upstream build this repo has never seen\n";
	await writeFile(install.client, stranger);
	await writeFile(install.index, "// index\n");
	const result = await apply(script, install, "apply");
	assert.equal(result.code, 1, "an unknown build is drift, not something to overwrite");
	assert.match(result.out, /REFUSING/);
	assert.equal(await readFile(install.client, "utf8"), stranger, "and the file is untouched");
	const status = await apply(script, install, "status");
	assert.equal(status.code, 1, "status exits 1 on drift so a script can gate on it");
	assert.match(status.out, /DRIFT/);
});

test("drift names the anchor that moved", { skip }, async (t) => {
	const install = await fakeInstall(t);
	const { script } = await seamCopy(t);
	// a realistic upstream refactor: one anchored component renamed, everything
	// else untouched — exactly the case the hash pin used to treat as total drift
	const renamed = (await pristine()).replace(
		"function SessionHoverContent({ node, now, t }) {",
		"function SessionHoverContentV2({ node, now, t }) {"
	);
	await writeFile(install.client, renamed);
	await writeFile(install.index, "// index\n");
	const status = await apply(script, install, "status");
	assert.equal(status.code, 1);
	// status indents the anchor-fail detail line; apply's stderr carries the raw
	// `anchor_fail=` prefix — either way the MOVED anchor is named
	assert.match(status.out, /SessionHoverContent header:0/, "the report names the moved anchor and its new count");
	const result = await apply(script, install, "apply");
	assert.equal(result.code, 1);
	assert.match(result.out, /anchor_fail=SessionHoverContent header:0/);
});

test("apply patches a build the pin has never seen, when the anchors resolve", { skip }, async (t) => {
	const install = await fakeInstall(t);
	const { script } = await seamCopy(t);
	// a newer upstream build: same anchored code, something else changed. The
	// whole-file hash would have refused this; the anchors are the guard now.
	const newer = (await pristine()) + "\n// an upstream change far from any anchor\n";
	await writeFile(install.client, newer);
	await writeFile(install.index, "// index\n");
	const result = await apply(script, install, "apply");
	assert.equal(result.code, 0, `anchors resolving is enough: ${result.out}`);
	assert.match(result.out, /patched lib\/client\.js in place/);
	const status = await apply(script, install, "status");
	assert.match(status.out, /PATCHED — /);
});

test("apply leaves a genuine upstream landing alone", { skip }, async (t) => {
	const install = await fakeInstall(t);
	const { script } = await seamCopy(t);
	// the seam, declared by upstream: the string is present, the marker is not
	const landed = (await pristine()) + '\nvar upstreamDeclares = "sidebar.workspaces.sessionRow";\n';
	await writeFile(install.client, landed);
	await writeFile(install.index, "// index\n");
	const status = await apply(script, install, "status");
	assert.match(status.out, /UPSTREAM LANDED/);
	assert.equal(status.code, 0);
	const result = await apply(script, install, "apply");
	assert.match(result.out, /Patch skipped/);
	assert.equal(await readFile(install.client, "utf8"), landed, "nothing is overwritten");
});

test("apply then revert lands on the bytes as found, not on someone else's baseline", { skip }, async (t) => {
	const install = await fakeInstall(t);
	const { script } = await seamCopy(t);
	// the installed build is the pinned upstream PLUS a local change; revert must
	// give back exactly these bytes, not the pinned baseline without the change
	const upstream = await pristine();
	const asFound = upstream + "\n// a local modification worth restoring\n";
	await writeFile(install.client, asFound);
	await writeFile(install.index, "// index\n");
	assert.match((await apply(script, install, "apply")).out, /patched lib\/client\.js in place/);
	assert.notEqual(await readFile(install.client, "utf8"), asFound, "the patch is installed");
	const reverted = await apply(script, install, "revert");
	assert.match(reverted.out, /reverted client\.js/);
	assert.equal(await readFile(install.client, "utf8"), asFound, "revert restores the bytes as found before patching");
	// idempotent: a second revert is a no-op, not a refusal
	assert.equal((await apply(script, install, "revert")).code, 0);
});

test("revert refuses when upstream replaced the file since the patch", { skip }, async (t) => {
	const install = await fakeInstall(t);
	const { script } = await seamCopy(t);
	await writeFile(install.client, await pristine());
	await writeFile(install.index, "// index\n");
	await apply(script, install, "apply");
	// DSH updates: the patched file is replaced by a newer upstream build
	const newer = (await pristine()) + "\n// a still newer upstream build\n";
	await writeFile(install.client, newer);
	const result = await apply(script, install, "revert");
	assert.equal(result.code, 1, "restoring the backup would DOWNGRADE the package");
	assert.match(result.out, /REFUSING to revert/);
	assert.equal(await readFile(install.client, "utf8"), newer, "the newer upstream file is untouched");
});

test("the artifact declares the session-row seams and not the workspace-row pair", { skip }, async () => {
	const patched = await readFile(join(SEAM, "patched-client.js"), "utf8");
	assert.match(patched, /"sidebar\.workspaces\.sessionRow"/);
	assert.match(patched, /"sidebar\.workspaces\.sessionRow\.detail"/);
	// the badge moved off the workspace row: leaving the old pair declared would
	// keep advertising a seam nothing renders
	assert.ok(!patched.includes('"sidebar.workspaces.row"'), "the workspace-row seam must be gone");
});

test("the artifact threads renderSlot into every scope a patched call site reads it from", { skip }, async () => {
	// The first cut of this patch threaded `renderSlot` into SessionNodeItem but not
	// into SessionTree, so the row render threw `ReferenceError: renderSlot is not
	// defined` the moment sessions appeared — and the shell ABDICATED the workspace
	// browser entry, blanking the whole sidebar. (The same trace the browser printed:
	// `slot entry crashed in 'sidebar.workspaces'`.) A shorthand prop at a patched
	// call site must arrive through EVERY intermediate component, so this pins the
	// chain rather than trusting a reader to notice the gap.
	const patched = await readFile(join(SEAM, "patched-client.js"), "utf8");
	assert.match(patched, /function SessionTree\(\{[^}]*\brenderSlot\b[^}]*\}\) \{/, "SessionTree must receive renderSlot");
	assert.match(patched, /\(0, react_jsx_runtime\.jsx\)\(SessionTree, \{\s*renderSlot,/, "and pass it down");
	assert.match(
		patched,
		/\(0, react_jsx_runtime\.jsx\)\(SessionNodeItem, \{[\s\S]{0,600}?\brenderSlot,/,
		"which each row passes to the seam helper"
	);
	assert.match(patched, /workspaceId: group\.workspaceId,/, "and the owning workspace id travels with it");
});

test("every anchor in anchors.py resolves exactly once on the pinned pristine build", { skip }, async () => {
	// The contract underneath everything else: if this ever fails, the anchor
	// module and the pinned pristine have drifted apart and NO install state is
	// trustworthy until they are reconciled.
	const { stdout } = await exec("python3", ["-c", `
import sys
sys.path.insert(0, ${JSON.stringify(SEAM)});
import anchors
text = open(${JSON.stringify(join(SEAM, "pristine-client.js"))}, encoding="utf-8").read()
fail = anchors.first_failure(text)
sys.exit(f"anchor {fail[0]!r} found {fail[1]} times" if fail else 0)
`]);
	assert.equal(stdout, "");
});
