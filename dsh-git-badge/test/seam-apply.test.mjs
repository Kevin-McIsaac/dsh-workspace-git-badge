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
	for (const f of ["seam/apply.js", "seam/anchors.js", "seam/postinstall.js", "seam/store.js", "seam/stub-index.js"]) {
		assert.ok(pkg.files.includes(f), `files must ship ${f}`);
		assert.ok(existsSync(join(PACKAGE, f)), `${f} exists`);
	}
	assert.equal(pkg.bin?.["dsh-git-badge-seam"], "seam/apply.js", "the bin entry names the patcher");
	assert.equal(pkg.scripts?.postinstall, "node seam/postinstall.js", "the install-time hook is wired");
});

test("the postinstall hook acts only on pristine installs and never fails one", { skip }, async (t) => {
	// Five states; only `patchable` may write. The hook's whole contract is
	// "best effort, never break an install" — pin it here rather than trusting
	// the try/catch. See the guardrail comment at the top of postinstall.js.
	const { spawnSync } = await import("node:child_process");
	// Hermetic store, like every other block in this file: without SEAM_DATA_DIR
	// the hook resolves dataDir() to the REAL ~/.dsh/git-badge-seam, so the run
	// clobbered the machine's backup-client.js/backup-index.js and dropped a
	// restart marker there. On a writable $HOME (CI) that passed silently; under
	// the read-only $HOME of an agent sandbox the copy threw EROFS, the hook
	// skipped, and this test failed for a reason that had nothing to do with it.
	const dataDir = await makeTempDir(t, "dsh-seam-data-");
	const runHook = (dir) =>
		spawnSync(process.execPath, [join(SEAM_SHIPPED, "postinstall.js")], {
			env: { ...process.env, DSH_INSTALL: dir, SEAM_DATA_DIR: dataDir },
			encoding: "utf8",
		});
	const mklib = async (name) => {
		const root = await makeTempDir(t, `dsh-pi-${name}-`);
		const dir = join(root, "node_modules", "@deepseek-ai", "dsh-client-ui-workspace", "lib");
		await mkdir(dir, { recursive: true });
		return { root, dir };
	};

	// 1. pristine → APPLIED, exit 0, marker present
	const applied = await mklib("pristine");
	await writeFile(join(applied.dir, "client.js"), await readFile(join(SEAM_REPO, "pristine-client.js"), "utf8"));
	await writeFile(join(applied.dir, "index.js"), "// host\n");
	const ok = runHook(applied.root);
	assert.equal(ok.status, 0, `pristine applies cleanly: ${ok.stderr}`);
	assert.match(ok.stdout, /seam applied/);
	assert.match(await readFile(join(applied.dir, "client.js"), "utf8"), new RegExp(MARKER));

	// 2. already patched → no-op, exit 0
	const again = runHook(applied.root);
	assert.equal(again.status, 0);
	assert.match(again.stdout, /already applied/);

	// 3. drifted → skip, file untouched, exit 0
	const drifted = await mklib("drifted");
	const driftedText = (await readFile(join(SEAM_REPO, "pristine-client.js"), "utf8")).replace(
		"function SessionHoverContent({ node, now, t }) {",
		"function SessionHoverContentV2({ node, now, t }) {"
	);
	await writeFile(join(drifted.dir, "client.js"), driftedText);
	const skipDrift = runHook(drifted.root);
	assert.equal(skipDrift.status, 0, "drift must not fail the install");
	assert.match(skipDrift.stdout, /drifted from the patch anchors/);
	assert.equal(await readFile(join(drifted.dir, "client.js"), "utf8"), driftedText, "nothing was written");

	// 4. upstream landed → skip, exit 0
	const landed = await mklib("landed");
	await writeFile(
		join(landed.dir, "client.js"),
		(await readFile(join(SEAM_REPO, "pristine-client.js"), "utf8")) + '\nvar x = "sidebar.workspaces.sessionRow";\n'
	);
	const skipLanded = runHook(landed.root);
	assert.equal(skipLanded.status, 0);
	assert.match(skipLanded.stdout, /declares the seam itself/);

	// 5. no DSH install → skip, exit 0
	const nowhere = await makeTempDir(t, "dsh-pi-missing-");
	const skipMissing = runHook(join(nowhere, "nowhere"));
	assert.equal(skipMissing.status, 0, "a missing install must not fail the hook");
	assert.match(skipMissing.stdout, /not found/);
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

test("the restart-pending marker follows the write → serve → clear lifecycle", { skip }, async (t) => {
	// The marker is the bridge from install-time to the running UI: postinstall
	// writes it when it patches, the status response serves it, and the plugin's
	// node half clears it at the next boot. This pins the store round trip and
	// that the hook/patcher actually earn the marker — the client render and the
	// boot-time clear are driven by the node/client halves (see the surfaces
	// logs when testing by hand).
	const { readRestartMarker, clearRestartMarker } = await import(`${SEAM_SHIPPED}/store.js`);
	const store = await makeTempDir(t, "dsh-seam-marker-");
	process.env.SEAM_DATA_DIR = store; // hermetic override; store.dataDir() reads it per call
	try {
		assert.equal(readRestartMarker(), null, "no marker at rest");

		// postinstall apply earns the marker…
		const install = await fakeInstall(t);
		await writeFile(install.client, await readFile(join(SEAM_REPO, "pristine-client.js"), "utf8"));
		await writeFile(install.index, "// host\n");
		const { spawnSync } = await import("node:child_process");
		const hook = spawnSync(process.execPath, [join(SEAM_SHIPPED, "postinstall.js")], {
			env: { ...process.env, DSH_INSTALL: install.root, SEAM_DATA_DIR: store },
			encoding: "utf8",
		});
		assert.equal(hook.status, 0, `hook applied: ${hook.stderr}`);
		assert.match(hook.stdout, /seam applied/);
		const marker = readRestartMarker();
		assert.ok(marker, "postinstall wrote the marker");
		assert.equal(marker.by, "postinstall");
		assert.equal(marker.schema, "dsh-git-badge/restart-pending/v1");

		// …and so does the CLI apply (the reason field names the actor).
		clearRestartMarker();
		assert.equal(readRestartMarker(), null);
		await writeFile(install.client, await pristine());
		const cli = await apply(install, "apply", store);
		assert.equal(cli.code, 0, `apply applied: ${hook.out}`);
		assert.equal(readRestartMarker().by, "apply");

		// the boot clears it — the change is live, nothing is pending
		clearRestartMarker();
		assert.equal(readRestartMarker(), null, "cleared at boot");
	} finally {
		delete process.env.SEAM_DATA_DIR;
	}
});

// ---------------------------------------------------------------------------
// the gh skill installer — the /gh commands-menu entry point ships as a skill
// ---------------------------------------------------------------------------

test("installSkill copies the packaged skill into the skills catalog", async (t) => {
	const home = await makeTempDir(t, "dsh-git-badge-skills-");
	process.env.DSH_HOME = home;
	t.after(() => { delete process.env.DSH_HOME; });
	const { installSkill, skillTarget } = await import(`${SEAM_SHIPPED}/skill.js`);
	assert.equal(installSkill(), "installed", "first install");
	const target = skillTarget();
	assert.ok(target.startsWith(home), "lands under the catalog DSH_HOME names");
	assert.match(target, /skills[\\/]gh[\\/]SKILL\.md$/);
	assert.match(await import("node:fs").then((fs) => fs.readFileSync(target, "utf8")), /^name: gh$/m);
	assert.equal(installSkill(), "current", "reinstall is a no-op by content");
});

test("installSkill never throws on an unwritable catalog", async (t) => {
	// ENOTDIR, not /proc: a path that cannot be created fails IMMEDIATELY and
	// exercises the same contract. The original fixture pointed DSH_HOME at
	// /proc, where mkdirSync BLOCKS in this sandbox instead of raising — the
	// promise never settled and took the whole file's run down with it (the
	// reason both installer tests were skipped).
	const home = await makeTempDir(t, "dsh-git-badge-blocked-");
	await writeFile(join(home, "skills"), "a file where the catalog directory would go\n");
	process.env.DSH_HOME = home;
	t.after(() => { delete process.env.DSH_HOME; });
	const { installSkill } = await import(`${SEAM_SHIPPED}/skill.js`);
	const outcome = installSkill();
	assert.match(String(outcome), /^skipped \(/, "a reason, not a throw");
});
