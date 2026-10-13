#!/usr/bin/env node
/**
 * dsh-git-badge CLI — the worktree-checkout registration command.
 *
 * The badge needs no patch, so this tool has ONE job: register the checkout a
 * session is working in. That is the one fact DSH cannot supply — a session's
 * cwd is immutable creation metadata and is always the main checkout, so a
 * session doing its work in a linked `git worktree` is invisible without an
 * explicit registration.
 *
 * The plugin ships this file as the package-name bin, because npx only auto-runs
 * a bin whose name matches the package:
 *
 *     npx dsh-git-badge checkout <path>
 *     npx dsh-git-badge checkout --clear
 *
 * The `dsh-git-badge-checkout` bin invokes checkout.js directly, for callers
 * that want the verb-less form. The `/gh` skill is installed by the plugin
 * itself at boot (see lib/index.js), not here.
 *
 * Usage: dsh-git-badge checkout <path|--clear>
 */
const verb = process.argv[2];
if (verb === "checkout") {
	// Strip the verb so checkout.js sees argv[2] = <path|--clear>.
	process.argv.splice(2, 1);
	await import("./checkout.js");
	process.exit(0); // checkout's success path returns; every failure path exits inside
}
console.error("usage: dsh-git-badge checkout <path|--clear>");
process.exit(1);
