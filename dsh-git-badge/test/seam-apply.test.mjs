/**
 * The seam patch's apply/revert guard.
 *
 * This exists because the guard's old rule — "if the seam string is present, skip"
 * — could not tell a genuine upstream landing from an artifact THIS repo had
 * written earlier. The consequence was silent: after any change to the patch,
 * `apply` reported success while leaving the previous patch installed, so a
 * restart showed the old UI and looked like a broken feature. These tests pin the
 * five states the guard must distinguish, driving the real script against a FAKE
 * install tree (`DSH_INSTALL`) and a COPY of `seam/`, so nothing here can touch
 * the machine's actual DSH package or the repo's own working files.
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
	return join(dir, "apply.sh");
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
	const script = await seamCopy(t);
	// an artifact this repo built at some earlier point: it carries the marker, so
	// its bytes are ours, but it is not what patched-client.js holds now
	await writeFile(install.client, `/* ${MARKER} */\n// an older patch of ours\n`);
	await writeFile(install.index, "// index\n");
	const before = await apply(script, install, "status");
	assert.match(before.out, /OUT OF DATE/, "status must recognise our own stale artifact");
	assert.equal(before.code, 0);
	const result = await apply(script, install, "apply");
	assert.match(result.out, /applied seam patch/, `apply must install, not skip: ${result.out}`);
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

test("apply refuses an unrecognised upstream build rather than overwriting it", { skip }, async (t) => {
	const install = await fakeInstall(t);
	const script = await seamCopy(t);
	const stranger = "// a newer upstream build this repo has never seen\n";
	await writeFile(install.client, stranger);
	await writeFile(install.index, "// index\n");
	const result = await apply(script, install, "apply");
	assert.equal(result.code, 1, "an unknown build is drift, not something to overwrite");
	assert.match(result.out, /REFUSING/);
	assert.equal(await readFile(install.client, "utf8"), stranger, "and the file is untouched");
	const status = await apply(script, install, "status");
	assert.equal(status.code, 1, "status exits 1 on drift so a script can gate on it");
	assert.match(status.out, /UNKNOWN BUILD/);
});

test("apply leaves a genuine upstream landing alone", { skip }, async (t) => {
	const install = await fakeInstall(t);
	const script = await seamCopy(t);
	// the seam, declared by upstream: the string is present, the marker is not
	const landed = (await pristine()) + '\nvar upstreamDeclares = "sidebar.workspaces.sessionRow";\n';
	await writeFile(install.client, landed);
	await writeFile(install.index, "// index\n");
	const status = await apply(script, install, "status");
	assert.match(status.out, /SEAM PRESENT, but not an artifact of ours/);
	assert.equal(status.code, 0);
	const result = await apply(script, install, "apply");
	assert.match(result.out, /upstream appears to declare it/);
	assert.equal(await readFile(install.client, "utf8"), landed, "nothing is overwritten");
});

test("apply then revert lands on UPSTREAM, not on the older patch", { skip }, async (t) => {
	const install = await fakeInstall(t);
	const script = await seamCopy(t);
	const upstream = await pristine();
	await writeFile(install.client, upstream);
	await writeFile(install.index, "// index\n");
	assert.match((await apply(script, install, "apply")).out, /applied seam patch/);
	assert.notEqual(await readFile(install.client, "utf8"), upstream, "the patch is installed");
	const reverted = await apply(script, install, "revert");
	assert.match(reverted.out, /reverted client\.js/);
	assert.equal(await readFile(install.client, "utf8"), upstream, "revert restores the upstream baseline");
	// idempotent: a second revert is a no-op, not a refusal
	assert.equal((await apply(script, install, "revert")).code, 0);
});

test("the artifact declares the session-row seams and not the workspace-row pair", { skip }, async () => {
	const patched = await readFile(join(SEAM, "patched-client.js"), "utf8");
	assert.match(patched, /"sidebar\.workspaces\.sessionRow"/);
	assert.match(patched, /"sidebar\.workspaces\.sessionRow\.detail"/);
	// the badge moved off the workspace row: leaving the old pair declared would
	// keep advertising a seam nothing renders
	assert.ok(!patched.includes('"sidebar.workspaces.row"'), "the workspace-row seam must be gone");
});
