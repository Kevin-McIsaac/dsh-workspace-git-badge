#!/usr/bin/env node
/**
 * postinstall hook — best-effort seam apply at plugin-install time.
 *
 * WHY THIS EXISTS: a market install activates the input chip immediately, but
 * the sidebar session-row badges additionally need the seam patch on the DSH
 * package itself, and nothing in the install flow told the user so. When pnpm
 * allows this script (the user approves it under `allowBuilds` — DSH's plugin
 * installer prints exactly that instruction when pnpm blocks it), the seam is
 * applied right here; otherwise the plugin's boot log and the chip tooltip name
 * the same one manual command.
 *
 * The mechanics live once in patch.js, shared with the apply CLI — the state
 * gate below reads the same inspect() report the CLI acts on, so the hook and
 * the tool cannot disagree about what a file's state is. This file only decides
 * what to print for each state at install time.
 *
 * GUARDRAILS — this script may never break an install:
 *   - it runs ONLY when the installed DSH client.js is pristine upstream AND
 *     every anchor resolves exactly once (`patchable`); any other state —
 *     already patched, drifted, upstream-landed, DSH not found — just prints
 *   - it never throws: every failure path prints the manual command and exits 0
 *   - it cannot restart dsh web; the printed message says to
 *
 * The restart is deliberately manual: the running dsh web process rebuilds its
 * client bundle at boot, and an install script restarting the host that is
 * installing it is not safe to automate.
 */
import { existsSync, readFileSync } from "node:fs";
import { firstFailure } from "./anchors.js";
import { doPatch, installPaths, inspect } from "./patch.js";
import { installSkill } from "./skill.js";

const HINT = "Sidebar session-row badges need one manual step: `npx dsh-git-badge apply`, then restart dsh web.";

function main() {
	// The skill does not depend on the DSH install — install it before any
	// client-shaped early return, so a market install always gets /gh.
	console.log(`[dsh-git-badge] gh skill: ${installSkill()} — /gh in the input's commands menu.`);
	const paths = installPaths();
	if (paths === null || !existsSync(paths.client)) {
		console.log(`[dsh-git-badge] DSH install not found; skipping seam setup. ${HINT}`);
		return;
	}
	const state = inspect(paths).state;
	switch (state) {
		// Already ours (any rev): nothing to do here; apply.js upgrade rules govern.
		case "ours-current":
		case "ours-stale":
		case "ours-corrupt":
			console.log("[dsh-git-badge] seam already applied — sidebar session-row badges active after restart.");
			return;
		// Upstream landed the seam: the patch is retired.
		case "upstream-landed":
			console.log("[dsh-git-badge] DSH declares the seam itself — no patch needed.");
			return;
		// Pristine, but the anchors no longer resolve: a DSH update moved anchored
		// code. Never patch half of anything — print, and let a patched anchors.js
		// do it.
		case "drift": {
			const fail = firstFailure(readFileSync(paths.client, "utf8"));
			console.log(`[dsh-git-badge] DSH build drifted from the patch anchors (${fail?.name}); skipping. ${HINT}`);
			return;
		}
		case "patchable":
			// The one state we act on: pristine upstream, anchors resolve.
			doPatch(paths, "postinstall");
			console.log("[dsh-git-badge] seam applied — RESTART dsh web to get sidebar session-row badges.");
			return;
		default:
			// missing / unreadable / ours-corrupt: nothing this hook can do safely.
			console.log(`[dsh-git-badge] DSH install state '${state}'; skipping seam setup. ${HINT}`);
	}
}

try {
	main();
} catch (error) {
	// An install hook must never fail the install over the seam.
	console.log(`[dsh-git-badge] seam setup skipped (${String(error && error.message ? error.message : error)}). ${HINT}`);
}
process.exit(0);
