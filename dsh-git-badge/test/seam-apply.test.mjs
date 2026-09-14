/**
 * The seam patch's apply/revert guard — the SHIPPED patcher
 * (dsh-git-badge/seam/apply.js, published as the `dsh-git-badge-seam` bin).
 *
 * The guard is ANCHOR-BASED: apply.js locates each block defined in
 * seam/anchors.js in the INSTALLED client.js (each must occur exactly once) and
 * replaces it in place. These tests pin the states the guard must distinguish,
 * driving the real script against a FAKE install tree (`DSH_INSTALL`) and a
 * throwaway backup directory (`SEAM_DATA_DIR`), so nothing here can touch the
 * machine's actual DSH package or the repo's own working files.
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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { makeTempDir } from "../test-support/repo.mjs";

const exec = promisify(execFile);
const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEAM_SHIPPED = join(PACKAGE, "seam"); // ships in the npm package
const SEAM_REPO = join(PACKAGE, "..", "seam"); // repo-only: pristine/patched snapshots
const APPLY = join(SEAM_SHIPPED, "apply.js");
/** The seam patcher is repo+package code; the snapshots are repo-only. */
const skip = existsSync(APPLY) ? false : "the shipped seam patcher is not in this checkout";

const MARKER = "dsh-git-badge:seam-patch";

/** A throwaway stand-in for the installed DSH package. */
async function fakeInstall(t) {
	const root = await makeTempDir(t, "dsh-seam-install-");
	const lib = join(root, "node_modules", "@deepseek-ai", "dsh-client-ui-workspace", "lib");
	await mkdir(lib, { recursive: true });
	return { root, client: join(lib, "client.js"), index: join(lib, "index.js") };
}

/** Run one apply.js verb against the fake install; never throws. */
async function apply(install, verb, dataDir) {
	try {
		const { stdout, stderr } = await exec(process.execPath, [APPLY, verb], {
			env: { ...process.env, DSH_INSTALL: install.root, SEAM_DATA_DIR: dataDir },
		});
		return { code: 0, out: stdout + stderr };
	} catch (error) {
		return { code: error.code ?? 1, out: String(error.stdout ?? "") + String(error.stderr ?? "") };
	}
}

const pristine = () => readFile(join(SEAM_REPO, "pristine-client.js"), "utf8");

test("apply installs over a stale artifact of ours instead of skipping it", { skip }, async (t) => {
	const install = await fakeInstall(t);
	const dataDir = await makeTempDir(t, "dsh-seam-data-");
	// an artifact this repo built at some earlier point: it carries the marker, so
	// its bytes are ours, but it predates the current anchors. The revert backup
	// (the bytes as found before that old patching) must be present and patchable
	// for the upgrade path to run — here, the upstream baseline.
	await writeFile(install.client, `/* ${MARKER} */\n// an older patch of ours\n`);
	await writeFile(install.index, "// index\n");
	await writeFile(join(dataDir, "backup-client.js"), await pristine());
	await writeFile(join(dataDir, "backup-index.js"), "// index\n");
	const before = await apply(install, "status", dataDir);
	assert.match(before.out, /OUT OF DATE/, "status must recognise our own stale artifact");
	assert.equal(before.code, 0);
	const result = await apply(install, "apply", dataDir);
	assert.match(result.out, /patched lib\/client\.js in place/, `apply must install, not skip: ${result.out}`);
	assert.equal(result.code, 0);
	const installed = await readFile(install.client, "utf8");
	const anchors = await import(`${SEAM_SHIPPED}/anchors.js`);
	assert.equal(installed, anchors.applyPatch(await pristine()), "the current patch is what landed");
	assert.match(installed, new RegExp(MARKER), "and it still carries the marker");
	const after = await apply(install, "status", dataDir);
	assert.match(after.out, /PATCHED — /, `status must now be current: ${after.out}`);
});

test("apply refuses a stale artifact whose backup has drifted, before overwriting anything", { skip }, async (t) => {
	const install = await fakeInstall(t);
	const dataDir = await makeTempDir(t, "dsh-seam-data-");
	await writeFile(install.client, `/* ${MARKER} */\n// an older patch of ours\n`);
	await writeFile(install.index, "// index\n");
	// the backup is from an older upstream whose anchors no longer resolve:
	// restoring it would overwrite the installed build with an unpatchable one
	const drifted = (await pristine()).replace(
		"function SessionHoverContent({ node, now, t }) {",
		"function SessionHoverContentV2({ node, now, t }) {"
	);
	await writeFile(join(dataDir, "backup-client.js"), drifted);
	const installedBefore = await readFile(install.client, "utf8");
	const result = await apply(install, "apply", dataDir);
	assert.equal(result.code, 1, "the upgrade must refuse");
	assert.match(result.out, /REFUSING/);
	assert.equal(await readFile(install.client, "utf8"), installedBefore, "the installed file was not overwritten");
});

test("apply refuses an unrecognised upstream build rather than overwriting it", { skip }, async (t) => {
	const install = await fakeInstall(t);
	const dataDir = await makeTempDir(t, "dsh-seam-data-");
	const stranger = "// a newer upstream build this repo has never seen\n";
	await writeFile(install.client, stranger);
	await writeFile(install.index, "// index\n");
	const result = await apply(install, "apply", dataDir);
	assert.equal(result.code, 1, "an unknown build is drift, not something to overwrite");
	assert.match(result.out, /REFUSING/);
	assert.equal(await readFile(install.client, "utf8"), stranger, "and the file is untouched");
	const status = await apply(install, "status", dataDir);
	assert.equal(status.code, 1, "status exits 1 on drift so a script can gate on it");
	assert.match(status.out, /DRIFT/);
});

test("drift names the anchor that moved", { skip }, async (t) => {
	const install = await fakeInstall(t);
	const dataDir = await makeTempDir(t, "dsh-seam-data-");
	// a realistic upstream refactor: one anchored component renamed, everything
	// else untouched — exactly the case the hash pin used to treat as total drift
	const renamed = (await pristine()).replace(
		"function SessionHoverContent({ node, now, t }) {",
		"function SessionHoverContentV2({ node, now, t }) {"
	);
	await writeFile(install.client, renamed);
	await writeFile(install.index, "// index\n");
	const status = await apply(install, "status", dataDir);
	assert.equal(status.code, 1);
	// status indents the anchor-fail detail line; apply's stderr carries the raw
	// `anchor_fail=` prefix — either way the MOVED anchor is named
	assert.match(status.out, /SessionHoverContent header:0/, "the report names the moved anchor and its new count");
	const result = await apply(install, "apply", dataDir);
	assert.equal(result.code, 1);
	assert.match(result.out, /anchor_fail=SessionHoverContent header:0/);
});

test("apply patches a build the pin has never seen, when the anchors resolve", { skip }, async (t) => {
	const install = await fakeInstall(t);
	const dataDir = await makeTempDir(t, "dsh-seam-data-");
	// a newer upstream build: same anchored code, something else changed. The
	// whole-file hash would have refused this; the anchors are the guard now.
	const newer = (await pristine()) + "\n// an upstream change far from any anchor\n";
	await writeFile(install.client, newer);
	await writeFile(install.index, "// index\n");
	const result = await apply(install, "apply", dataDir);
	assert.equal(result.code, 0, `anchors resolving is enough: ${result.out}`);
	assert.match(result.out, /patched lib\/client\.js in place/);
	const status = await apply(install, "status", dataDir);
	assert.match(status.out, /PATCHED — /);
});

test("apply leaves a genuine upstream landing alone", { skip }, async (t) => {
	const install = await fakeInstall(t);
	const dataDir = await makeTempDir(t, "dsh-seam-data-");
	// the seam, declared by upstream: the string is present, the marker is not
	const landed = (await pristine()) + '\nvar upstreamDeclares = "sidebar.workspaces.sessionRow";\n';
	await writeFile(install.client, landed);
	await writeFile(install.index, "// index\n");
	const status = await apply(install, "status", dataDir);
	assert.match(status.out, /UPSTREAM LANDED/);
	assert.equal(status.code, 0);
	const result = await apply(install, "apply", dataDir);
	assert.match(result.out, /Patch skipped/);
	assert.equal(await readFile(install.client, "utf8"), landed, "nothing is overwritten");
});

test("apply then revert lands on the bytes as found, not on someone else's baseline", { skip }, async (t) => {
	const install = await fakeInstall(t);
	const dataDir = await makeTempDir(t, "dsh-seam-data-");
	// the installed build is the pinned upstream PLUS a local change; revert must
	// give back exactly these bytes, not the pinned baseline without the change
	const upstream = await pristine();
	const asFound = upstream + "\n// a local modification worth restoring\n";
	await writeFile(install.client, asFound);
	await writeFile(install.index, "// index\n");
	assert.match((await apply(install, "apply", dataDir)).out, /patched lib\/client\.js in place/);
	assert.notEqual(await readFile(install.client, "utf8"), asFound, "the patch is installed");
	const reverted = await apply(install, "revert", dataDir);
	assert.match(reverted.out, /reverted client\.js/);
	assert.equal(await readFile(install.client, "utf8"), asFound, "revert restores the bytes as found before patching");
	// idempotent: a second revert is a no-op, not a refusal
	assert.equal((await apply(install, "revert", dataDir)).code, 0);
});

test("revert refuses when upstream replaced the file since the patch", { skip }, async (t) => {
	const install = await fakeInstall(t);
	const dataDir = await makeTempDir(t, "dsh-seam-data-");
	await writeFile(install.client, await pristine());
	await writeFile(install.index, "// index\n");
	await apply(install, "apply", dataDir);
	// DSH updates: the patched file is REPLACED by a newer upstream build (no
	// marker) — appending to our patch would leave it ours, and reverting that is
	// legitimate
	const newer = (await pristine()) + "\n// a still newer upstream build\n";
	await writeFile(install.client, newer);
	const result = await apply(install, "revert", dataDir);
	assert.equal(result.code, 1, "restoring the backup would DOWNGRADE the package");
	assert.match(result.out, /REFUSING to revert/);
	assert.equal(await readFile(install.client, "utf8"), newer, "the newer upstream file is untouched");
});

test("the patcher ships in the package: files list, bin, and stub", { skip }, async () => {
	const pkg = JSON.parse(await readFile(join(PACKAGE, "package.json"), "utf8"));
	for (const f of ["seam/apply.js", "seam/anchors.js", "seam/stub-index.js"]) {
		assert.ok(pkg.files.includes(f), `files must ship ${f}`);
		assert.ok(existsSync(join(PACKAGE, f)), `${f} exists`);
	}
	assert.equal(pkg.bin?.["dsh-git-badge-seam"], "seam/apply.js", "the bin entry names the patcher");
});

test("every anchor resolves exactly once on the pinned pristine build", { skip }, async () => {
	// The contract underneath everything else: if this ever fails, the anchor
	// module and the pinned pristine have drifted apart and NO install state is
	// trustworthy until they are reconciled.
	const anchors = await import(`${SEAM_SHIPPED}/anchors.js`);
	const text = await pristine();
	const fail = anchors.firstFailure(text);
	assert.equal(fail, null, `anchor ${fail?.name} found ${fail?.count} times`);
});

test("regenerating the PR-diff artifact is byte-identical to the shipped anchors", { skip }, async () => {
	// anchors.js is the single definition of the patch; the repo's
	// patched-client.js snapshot (PR-diff only) must stay in lockstep with it.
	const anchors = await import(`${SEAM_SHIPPED}/anchors.js`);
	const out = anchors.applyPatch(await pristine());
	assert.equal(out, await readFile(join(SEAM_REPO, "patched-client.js"), "utf8"), "run seam/make-patch.sh if this drifts");
});
