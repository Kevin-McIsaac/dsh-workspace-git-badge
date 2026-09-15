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
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPatch, firstFailure, isOurs, seamPresent } from "./anchors.js";
import { installSkill } from "./skill.js";
import { dataDir, writeRestartMarker } from "./store.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const HINT = "Sidebar session-row badges need one manual step: `npx dsh-git-badge apply`, then restart dsh web.";

function dshClientPath() {
	try {
		const root = process.env.DSH_INSTALL || join(execSync("npm root -g", { encoding: "utf8" }).trim(), "@deepseek-ai", "dsh");
		return join(root, "node_modules", "@deepseek-ai", "dsh-client-ui-workspace", "lib", "client.js");
	} catch {
		return null;
	}
}

function main() {
	// The skill does not depend on the DSH install — install it before any
	// client-shaped early return, so a market install always gets /gh.
	console.log(`[dsh-git-badge] gh skill: ${installSkill()} — /gh in the input's commands menu.`);
	const client = dshClientPath();
	if (client === null || !existsSync(client)) {
		console.log(`[dsh-git-badge] DSH install not found; skipping seam setup. ${HINT}`);
		return;
	}
	// the index stub is copied with the client on apply (see apply.js)
	const index = join(dirname(client), "index.js");
	const text = readFileSync(client, "utf8");

	// Already ours (any rev): nothing to do here; apply.js upgrade rules govern.
	if (isOurs(text)) {
		console.log("[dsh-git-badge] seam already applied — sidebar session-row badges active after restart.");
		return;
	}
	// Upstream landed the seam: the patch is retired.
	if (seamPresent(text)) {
		console.log("[dsh-git-badge] DSH declares the seam itself — no patch needed.");
		return;
	}
	// Pristine, but the anchors no longer resolve: a DSH update moved anchored
	// code. Never patch half of anything — print, and let a patched anchors.js
	// do it.
	const fail = firstFailure(text);
	if (fail !== null) {
		console.log(`[dsh-git-badge] DSH build drifted from the patch anchors (${fail.name}); skipping. ${HINT}`);
		return;
	}
	// The one state we act on: pristine upstream, anchors resolve.
	mkdirSync(dataDir(), { recursive: true });
	copyFileSync(client, join(dataDir(), "backup-client.js"));
	copyFileSync(index, join(dataDir(), "backup-index.js"));
	writeFileSync(client, applyPatch(text));
	copyFileSync(join(HERE, "stub-index.js"), index);
	console.log("[dsh-git-badge] seam applied — RESTART dsh web to get sidebar session-row badges.");
	// Tell the running UI: dshmarket cannot see this host-file change, so the
	// plugin offers the Restart button itself (marker → status response → chip).
	// Read/cleared by the plugin halves — see seam/store.js.
	writeRestartMarker("postinstall");
}

try {
	main();
} catch (error) {
	// An install hook must never fail the install over the seam.
	console.log(`[dsh-git-badge] seam setup skipped (${String(error && error.message ? error.message : error)}). ${HINT}`);
}
process.exit(0);
