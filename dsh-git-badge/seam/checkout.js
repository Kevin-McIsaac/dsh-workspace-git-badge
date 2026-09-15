#!/usr/bin/env node
/**
 * dsh-git-badge-checkout — tell the badge which checkout THIS session is working
 * in.
 *
 * WHY THIS EXISTS: a dsh session's cwd is immutable creation metadata — it is
 * the main checkout forever, even after the agent does its work in a linked
 * worktree. The badge therefore cannot know, on its own, that a session moved
 * into `.wt/<name>`; it can only infer a worktree from an open pull request.
 * This command closes that gap: the agent registers the checkout explicitly, and
 * the node half prefers the registration over inference.
 *
 * The registration is advisory and self-expiring (24h) — never let it fail the
 * work that earned it:
 *
 *   usage:  npx dsh-git-badge-checkout <path>     register this session
 *           npx dsh-git-badge-checkout --clear    forget this session
 *
 * The path is validated as a real worktree of its repository before it is
 * written, so a typo cannot point the badge at an unrelated directory.
 */
import { execFileSync } from "node:child_process";
import { basename, resolve } from "node:path";
import { clearSessionCheckout, writeSessionCheckout } from "./store.js";

function usage(message) {
	if (message !== void 0) console.error(message);
	console.error("usage: dsh-git-badge-checkout <path> | --clear");
}

/** Worktree paths git lists for the repo containing `dir`. */
function worktreePaths(dir) {
	const out = execFileSync("git", ["-C", dir, "worktree", "list", "--porcelain"], { encoding: "utf8" });
	return out
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => resolve(line.slice("worktree ".length).trim()));
}

function branchOf(dir) {
	try {
		return execFileSync("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
	} catch {
		return "unknown";
	}
}

const sessionId = process.env.DSH_SESSION_ID;
if (sessionId === void 0 || sessionId === "") {
	usage("no DSH_SESSION_ID in the environment — run this from inside a dsh session.");
	process.exit(2);
}

const arg = process.argv[2];
if (arg === "--clear") {
	clearSessionCheckout(sessionId);
	console.log("[dsh-git-badge] checkout registration cleared for this session.");
	process.exit(0);
}
if (arg === void 0 || arg === "") {
	usage();
	process.exit(2);
}

const path = resolve(arg);
let paths;
try {
	paths = worktreePaths(path);
} catch (error) {
	console.error(`[dsh-git-badge] ${path} is not a git worktree: ${String(error?.message ?? error)}`);
	process.exit(1);
}
if (!paths.includes(path)) {
	console.error(`[dsh-git-badge] ${path} is not a worktree of its repository (git lists: ${paths.join(", ")})`);
	process.exit(1);
}

if (!writeSessionCheckout(sessionId, path)) {
	console.error("[dsh-git-badge] could not write the registration; the badge keeps its inferred checkout.");
	process.exit(1);
}
console.log(`[dsh-git-badge] this session's checkout is now ${basename(path)} (${branchOf(path)}).`);
