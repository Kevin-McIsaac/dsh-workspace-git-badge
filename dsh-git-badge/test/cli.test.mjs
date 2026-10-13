/**
 * The shipped CLI and the `/gh` skill installer.
 *
 * The plugin needs no patch, so `seam/cli.js` has one job: dispatch the
 * `checkout` verb to `seam/checkout.js` (the worktree registration that makes a
 * session badge follow the right checkout). These tests drive the REAL script
 * against a throwaway store, so nothing here can touch the machine's DSH package
 * or the repo's working files.
 *
 * The skill installer tests live here too: `installSkill` ships with this
 * package and is called by the plugin's `apply()`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { makeTempDir } from "../test-support/repo.mjs";

const exec = promisify(execFile);
const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEAM_SHIPPED = join(PACKAGE, "seam"); // ships in the npm package
const CLI = join(SEAM_SHIPPED, "cli.js");

test("the CLI ships in the package: files list and bins", async () => {
	const pkg = JSON.parse(await readFile(join(PACKAGE, "package.json"), "utf8"));
	for (const f of ["seam/cli.js", "seam/checkout.js", "seam/skill.js", "seam/store.js"]) {
		assert.ok(pkg.files.includes(f), `files must ship ${f}`);
		assert.ok(existsSync(join(PACKAGE, f)), `${f} exists`);
	}
	// npx only auto-runs a bin whose name matches the package, so the
	// package-name bin must exist even though the checkout bin does the work.
	assert.equal(pkg.bin?.["dsh-git-badge"], "seam/cli.js", "the package-name alias IS the CLI");
	assert.equal(pkg.bin?.["dsh-git-badge-checkout"], "seam/checkout.js", "the checkout bin stays for direct invocation");
	assert.equal(pkg.bin?.["dsh-git-badge-seam"], void 0, "the retired seam bin is gone");
	assert.equal(pkg.scripts?.postinstall, void 0, "no install-time hook: the plugin patches nothing");
	// the patcher is gone from the package
	for (const gone of ["seam/apply.js", "seam/anchors.js", "seam/patch.js", "seam/stub-index.js"]) {
		assert.ok(!pkg.files.includes(gone), `the retired patcher file ${gone} must not ship`);
	}
});

test("the package-name alias dispatches checkout to the checkout CLI", async (t) => {
	// npx dsh-git-badge checkout <path|--clear> — cli.js strips the verb and
	// delegates. Driven through the real script: this pins the argv splice (a
	// botched shift would point checkout at the verb instead of the path).
	const dataDir = await makeTempDir(t, "dsh-cli-data-");
	const runCli = async (args, env) => {
		try {
			const { stdout, stderr } = await exec(process.execPath, [CLI, ...args], {
				env: { ...process.env, ...env, SEAM_DATA_DIR: dataDir },
			});
			return { code: 0, out: stdout + stderr };
		} catch (error) {
			return { code: error.code ?? 1, out: String(error.stdout ?? "") + String(error.stderr ?? "") };
		}
	};
	const runCheckout = (args, env) => runCli(["checkout", ...args], env);

	// no session id: checkout's own usage error, exit 2 (not the CLI's usage, exit 1).
	// Forced empty — the test process itself runs inside a dsh session, whose
	// exported DSH_SESSION_ID would otherwise leak into the child env.
	const noSession = await runCheckout(["--clear"], { DSH_SESSION_ID: "" });
	assert.equal(noSession.code, 2, "the verb reached checkout.js: " + noSession.out);
	assert.match(noSession.out, /no DSH_SESSION_ID/);

	// --clear with a session id: full delegation, hermetic store, exit 0
	const cleared = await runCheckout(["--clear"], { DSH_SESSION_ID: "test-session" });
	assert.equal(cleared.code, 0, "clear succeeded: " + cleared.out);
	assert.match(cleared.out, /checkout registration cleared/);

	// a PATH argument lands as argv[2] — a non-worktree path must be rejected by
	// checkout's own validation, proving the splice shifted the argument not the verb
	const badPath = await runCheckout(["/definitely/not/a/worktree"], { DSH_SESSION_ID: "test-session" });
	assert.equal(badPath.code, 1, "the path reached checkout.js's validation: " + badPath.out);
	assert.match(badPath.out, /not a git worktree/);

	// no path at all is checkout's usage error too
	const noPath = await runCheckout([], { DSH_SESSION_ID: "test-session" });
	assert.equal(noPath.code, 2, "no path is checkout's usage error: " + noPath.out);

	// an unknown verb never reaches checkout: the CLI's own usage, exit 1
	const unknown = await runCli(["frobnicate"]);
	assert.equal(unknown.code, 1, "an unknown verb is a usage error: " + unknown.out);
	assert.match(unknown.out, /usage: dsh-git-badge checkout/);
});

test("a registration that cannot be written says WHY, and how to recover", async (t) => {
	// The failure the badge cannot show. `writeSessionCheckout` used to swallow the
	// cause and return false, so the whole report was "could not write the
	// registration" — no path, no reason, no recovery — and the caller's next step
	// was guesswork. That is how a session whose agent works in a worktree ends up
	// with a badge describing the main checkout and nobody knowing why.
	const dir = await makeTempDir(t, "dsh-cli-blocked-");
	// a FILE where the store needs a DIRECTORY, so mkdirSync cannot succeed
	const blocked = join(dir, "blocked");
	await writeFile(blocked, "not a directory\n");
	let result;
	try {
		// the WORKTREE ROOT (this repo), which git lists
		const { stdout, stderr } = await exec(process.execPath, [CLI, "checkout", join(PACKAGE, "..")], {
			env: { ...process.env, DSH_SESSION_ID: "session-blocked", SEAM_DATA_DIR: blocked }
		});
		result = { code: 0, out: stdout + stderr };
	} catch (error) {
		result = { code: error.code ?? 1, out: String(error.stdout ?? "") + String(error.stderr ?? "") };
	}
	assert.equal(result.code, 1, `a refused registration must fail loudly: ${result.out}`);
	assert.match(result.out, /could not write the registration to .*blocked/, "the target is named");
	assert.match(result.out, /reason: \S/, "the CAUSE is reported, not swallowed");
	assert.match(result.out, /EEXIST|ENOTDIR|EACCES|EROFS/, "and it is the real errno");
	assert.match(result.out, /re-run this command/, "the remedies are spelled out");
	assert.match(result.out, /add the worktree as its own dsh workspace/);
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
	assert.match(await readFile(target, "utf8"), /^name: gh$/m);
	assert.equal(installSkill(), "current", "reinstall is a no-op by content");
});

test("installSkill never throws on an unwritable catalog", async (t) => {
	// ENOTDIR, not /proc: a path that cannot be created fails IMMEDIATELY and
	// exercises the same contract. The original fixture pointed DSH_HOME at
	// /proc, where mkdirSync BLOCKS in this sandbox instead of raising — the
	// promise never settled and took the whole file's run down with it.
	const home = await makeTempDir(t, "dsh-git-badge-blocked-");
	await writeFile(join(home, "skills"), "a file where the catalog directory would go\n");
	process.env.DSH_HOME = home;
	t.after(() => { delete process.env.DSH_HOME; });
	const { installSkill } = await import(`${SEAM_SHIPPED}/skill.js`);
	const outcome = installSkill();
	assert.match(String(outcome), /^skipped \(/, "a reason, not a throw");
});
