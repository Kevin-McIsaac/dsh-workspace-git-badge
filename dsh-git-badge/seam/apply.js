#!/usr/bin/env node
/**
 * dsh-git-badge-seam — apply / revert / inspect the sidebar session-row seam
 * patch on an installed DSH package.
 *
 * WHY THIS EXISTS: the sidebar session-row badges need a slot the DSH workspace
 * browser does not declare upstream yet (proposed upstream — see PR.md in the
 * plugin's repository). The patch is SEAM-ONLY; all badge logic lives in the
 * dsh-git-badge plugin itself. This tool is shipped IN the package, so a market
 * install needs no clone:
 *
 *     dsh plugin --profile web add dsh-git-badge
 *     npx dsh-git-badge apply        # then restart the dsh web process
 *
 * HOW PATCHING WORKS — anchors, not hashes. The patch is defined once in
 * anchors.js as [name, old, new] triples; the mechanics (locating the install,
 * inspecting its state, writing the patch and its backup) live once in
 * patch.js, shared with the postinstall hook. This file is the CLI: it decides
 * what to print and which exit codes to take, per the states inspect() names.
 *
 * Safety (enforced in patch.js + anchors.js, surfaced here):
 *   - anchor assertion: every anchor must match exactly once; anything else is
 *     drift and NOTHING is written
 *   - own-artifact detection: every artifact carries the dsh-git-badge:seam-patch
 *     marker (with a rev number), so our stale patch can be upgraded in place
 *     while a genuine upstream landing (seam declared, no marker) is left alone
 *   - backup of the bytes as found: revert restores exactly what was installed
 *     before WE patched, guarded against downgrading a newer upstream build
 *   - the pinned KNOWN_GOOD_HASH is ADVISORY only: status reports whether the
 *     installed build is the one the anchors were verified against, but apply
 *     proceeds on any build whose anchors resolve
 *
 * Environment (read by patch.js):
 *   DSH_INSTALL    the DSH package root. Default: `<global npm root>/@deepseek-ai/dsh`.
 *   SEAM_DATA_DIR  where revert backups are written. Default:
 *                  `$DSH_HOME/git-badge-seam` (else `~/.dsh/git-badge-seam`) —
 *                  a stable, user-level store shared by every way this tool
 *                  can run. See seam/store.js for the restart marker.
 *
 * The package also declares this file under the package's own name
 * (bin "dsh-git-badge"), because npx only auto-runs a bin whose name matches
 * the package name: `npx dsh-git-badge apply` resolves, while
 * `npx dsh-git-badge-seam` 404s (no PACKAGE carries that name). The alias
 * multiplexes the checkout bin too — npx cannot reach a second bin by name,
 * so the checkout verb dispatches here:
 *
 * Usage: npx dsh-git-badge apply | revert | status | checkout <path|--clear>
 *        (equivalently apply.js <verb>; checkout delegates to checkout.js)
 */
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { MARKER } from "./anchors.js";
import { backupState, doPatch, doRestore, installPaths, inspect, KNOWN_GOOD_HASH, sha256 } from "./patch.js";
import { installSkill } from "./skill.js";
import { writeRestartMarker } from "./store.js";

const VERDICT_EXIT_1 = new Set(["drift", "unreadable", "missing", "ours-corrupt"]);

const verb = process.argv[2];
if (verb === "checkout") {
	// alias-bin multiplex: strip the verb so checkout.js sees argv[2] = <path|--clear>
	process.argv.splice(2, 1);
	await import("./checkout.js");
	process.exit(0); // checkout's success path returns; every failure path exits inside
}

const paths = installPaths();
if (paths === null) {
	console.error("ERROR: cannot locate the DSH package. Set DSH_INSTALL to its root");
	console.error("(e.g. the directory containing node_modules/@deepseek-ai/dsh).");
	process.exit(1);
}
const CLIENT = paths.client;

if (!verb || !["apply", "revert", "status"].includes(verb)) {
	console.error("usage: dsh-git-badge apply|revert|status   (or: dsh-git-badge checkout <path|--clear>)");
	process.exit(1);
}

// keep the /gh skill in step with the package on every patcher run
console.log(`[dsh-git-badge] gh skill: ${installSkill()}`);

if (verb === "status") {
	const r = inspect(paths);
	console.log(`installed:  ${CLIENT}`);
	console.log(`hash:       ${r.hash ?? r.error ?? "-"}`);
	if (r.known_good_match === "yes") console.log("pinned:     KNOWN-GOOD MATCH — the build the anchors were verified against");
	else console.log(`pinned:     ${KNOWN_GOOD_HASH} — differs (advisory only; anchors are the guard)`);
	console.log(`anchors:    ${r.anchors ?? "-"}`);
	if (r.anchors === "drift") console.log(`            ${r.anchor_fail}`);
	console.log(`marker:     ${r.marker ?? "-"} (rev current: ${r.rev_current ?? "-"}, applied signature: ${r.applied_signature ?? "n/a"})`);
	console.log(`backup:     ${r.backup ?? "-"}`);
	console.log(`state:      ${r.state}`);
	switch (r.state) {
		case "ours-current":
			console.log("verdict:    PATCHED — sidebar session-row badges come from this repo's patch.");
			break;
		case "ours-stale":
			console.log("verdict:    PATCHED, OUT OF DATE — our older artifact; 'apply' upgrades in place.");
			break;
		case "ours-corrupt":
			console.log("verdict:    BROKEN ARTIFACT — marker present but anchors/seam inconsistent. Inspect by hand.");
			break;
		case "upstream-landed":
			console.log("verdict:    UPSTREAM LANDED — 'apply' no-ops; the patch can be retired.");
			break;
		case "patchable":
			console.log("verdict:    PATCHABLE — 'apply' will patch it in place.");
			break;
		case "drift":
			console.log("verdict:    DRIFT — an anchor moved; update seam/anchors.js for the new upstream.");
			break;
		case "missing":
			console.log("verdict:    INSTALLED PACKAGE NOT FOUND — check DSH_INSTALL.");
			break;
		default:
			console.log(`verdict:    ${r.state.toUpperCase()} — see error above.`);
	}
	process.exit(VERDICT_EXIT_1.has(r.state) ? 1 : 0);
}

if (verb === "apply") {
	const r = inspect(paths);
	for (const [k, v] of Object.entries(r)) {
		if (k !== "state") console.log(`  ${k}=${v}`);
	}
	console.log(`installed:  ${CLIENT}`);
	switch (r.state) {
		case "ours-current":
			console.log("verdict:    PATCHED (rev current) — nothing to do.");
			break;
		case "patchable":
			doPatch(paths, "apply");
			console.log("patched lib/client.js in place (anchors applied); host half stubbed.");
			console.log("verdict:    PATCHED.");
			break;
		case "ours-stale": {
			// Our older artifact. The re-patch target is the BACKUP (the bytes as we
			// found them pre-patch). Validate THAT before touching the installed
			// file: restoring a backup whose anchors no longer resolve would
			// overwrite the installed build with an unpatchable older one.
			if (!existsSync(paths.backupClient)) {
				console.error("REFUSING: installed file is an older artifact of ours but no backup");
				console.error("exists, so the original bytes are unknown. Reinstall the package or");
				console.error("restore the backup by hand, then re-run apply.");
				process.exit(1);
			}
			const bstate = backupState(paths);
			if (bstate !== "patchable") {
				console.error(`REFUSING: the backup (bytes as found before patching) is '${bstate}',`);
				console.error("not patchable — the anchors no longer match the backed-up upstream.");
				console.error("Nothing was changed. Reinstall the DSH package, then re-run apply.");
				process.exit(1);
			}
			doRestore(paths);
			doPatch(paths, "apply");
			console.log("patched lib/client.js in place (anchors applied); host half stubbed.");
			console.log("verdict:    UPGRADED — older artifact replaced with the current patch.");
			break;
		}
		case "upstream-landed":
			console.error("verdict:    UPSTREAM LANDED — the installed client.js declares the seam");
			console.error("and is NOT this repo's artifact. Patch skipped (plugin only); the patch");
			console.error("can be retired.");
			break;
		case "drift": {
			const [name, count] = r.anchor_fail.split(":");
			console.error("REFUSING: anchor drift — nothing was written.");
			console.error(`  anchor:   ${name} (found ${count} times, need exactly 1)`);
			console.error("Upstream changed code this patch anchors on. Update the matching entry");
			console.error("in anchors.js, then re-run: dsh-git-badge status && dsh-git-badge apply");
			process.exit(1);
		}
		case "ours-corrupt":
			console.error("REFUSING: the installed file carries this repo's marker but is neither");
			console.error("the current revision nor a restorable state. Inspect by hand:");
			console.error(`  grep -n '${MARKER}' "${CLIENT}"`);
			process.exit(1);
			break;
		default:
			console.error(`REFUSING: installed client.js is '${r.state}'.`);
			process.exit(1);
	}
	console.log(`now install the plugin:  dsh plugin --profile web add dsh-git-badge`);
} else {
	// revert
	if (existsSync(paths.backupClient)) {
		const r = inspect(paths);
		const installedHash = r.hash;
		const backupHash = sha256(readFileSync(paths.backupClient, "utf8"));
		if (installedHash === backupHash) {
			// Idempotent re-run: the installed bytes already ARE the backup.
			console.log("already reverted — installed client.js matches the backup; nothing to do.");
		} else if (r.state === "ours-current" || r.state === "ours-stale" || r.state === "ours-corrupt") {
			doRestore(paths);
			console.log("reverted client.js/index.js to the bytes as found before patching.");
			// A revert also changes bytes the running bundles were composed from.
			writeRestartMarker("revert");
		} else {
			// Installed file is not ours => upstream replaced it since patching.
			console.error("REFUSING to revert: the installed client.js is not this repo's");
			console.error(`artifact (state: ${r.state}), so upstream replaced it since the patch was`);
			console.error("applied. Restoring the backup would DOWNGRADE the package.");
			console.error("Nothing was changed. If the downgrade is really what you want, restore");
			console.error(`${paths.backupClient} by hand.`);
			process.exit(1);
		}
	} else {
		const r = inspect(paths);
		if (r.state === "ours-current" || r.state === "ours-stale" || r.state === "ours-corrupt") {
			console.error("REFUSING: the installed file is patched but no backup exists in");
			console.error("the seam data dir, so the original bytes are unknown here. Options:");
			console.error("  1. If you applied from a clone of the plugin's repository, run its");
			console.error("     wrapper instead — it keeps its own backup:");
			console.error("       <clone>/seam/apply.sh revert");
			console.error("  2. Otherwise reinstall the package — pristine files, guaranteed:");
			console.error("       npm i -g @deepseek-ai/dsh@latest");
			process.exit(1);
		}
		console.log("no backup present and nothing of ours installed; client.js left untouched.");
	}
	// restore the no-op host half if no backup of the original exists
	if (!existsSync(paths.backupIndex)) copyFileSync(paths.stub, paths.index);
	console.log("remember to remove the plugin:  dsh plugin --profile web remove dsh-git-badge");
}
