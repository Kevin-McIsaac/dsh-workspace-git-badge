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
 * anchors.js as [name, old, new] triples. `apply` locates each `old` block in
 * the INSTALLED client.js (each must occur exactly once) and replaces it in
 * place. A DSH update that changes anything else in the file no longer matters;
 * only a change that moves one of the anchors does, and the failure names the
 * anchor that moved instead of reporting an opaque hash mismatch.
 *
 * Safety:
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
 * Environment:
 *   DSH_INSTALL    the DSH package root. Default: `<global npm root>/@deepseek-ai/dsh`.
 *   SEAM_DATA_DIR  where revert backups are written. Default:
 *                  `$DSH_HOME/git-badge-seam` (else `~/.dsh/git-badge-seam`) —
 *                  a stable, user-level store shared by every way this tool
 *                  can run. See the note at the definition below.
 *
 * Usage: apply.js apply | apply.js revert | apply.js status
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	MARKER,
	applyPatch,
	appliedSignature,
	firstFailure,
	isCurrentRev,
	isOurs,
	seamPresent,
} from "./anchors.js";

import { dataDir, writeRestartMarker } from "./store.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * The stable backup store — shared with the postinstall hook and any future
 * invocation path, so an apply→revert round trip works across npx cache
 * entries. SEAM_DATA_DIR overrides (the test suite does, to stay hermetic).
 * See seam/store.js for the full rationale and the restart marker.
 */
const DATA_DIR = dataDir();

// sha256 of the upstream build the anchors were last verified against. ADVISORY:
// status prints it for orientation; apply does NOT require it.
const KNOWN_GOOD_HASH = "383b9ef779366c13d818500b6488896328b189f156addbaa480c835e902edd5f";

/** Locate the installed DSH package root; null when it cannot be found. */
function dshRoot() {
	if (process.env.DSH_INSTALL) return process.env.DSH_INSTALL;
	try {
		return join(execSync("npm root -g", { encoding: "utf8" }).trim(), "@deepseek-ai", "dsh");
	} catch {
		return null;
	}
}

const DSH = dshRoot();
if (!DSH) {
	console.error("ERROR: cannot locate the DSH package. Set DSH_INSTALL to its root");
	console.error("(e.g. the directory containing node_modules/@deepseek-ai/dsh).");
	process.exit(1);
}
const PKG = join(DSH, "node_modules", "@deepseek-ai", "dsh-client-ui-workspace");
const CLIENT = join(PKG, "lib", "client.js");
const INDEX = join(PKG, "lib", "index.js");
const STUB_INDEX = join(HERE, "stub-index.js"); // no-op host half; copied over index.js on apply
const BACKUP_CLIENT = join(DATA_DIR, "backup-client.js");
const BACKUP_INDEX = join(DATA_DIR, "backup-index.js");

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** Inspect the installed client.js. Returns the same key:value report apply.sh printed. */
function inspect() {
	const report = {};
	let text;
	try {
		text = readClient();
	} catch (error) {
		if (error.code === "ENOENT") {
			report.state = "missing";
			return report;
		}
		report.state = "unreadable";
		report.error = String(error.message ?? error);
		return report;
	}
	report.hash = sha256(text);
	report.known_good_match = report.hash === KNOWN_GOOD_HASH ? "yes" : "no";
	report.backup = existsSync(BACKUP_CLIENT) ? "yes" : "no";
	report.marker = isOurs(text) ? "yes" : "no";
	report.rev_current = isCurrentRev(text) ? "yes" : "no";
	report.seam_strings = seamPresent(text) ? "yes" : "no";

	const fail = firstFailure(text);
	if (fail === null) report.anchors = "all-resolve";
	else {
		report.anchors = "drift";
		report.anchor_fail = `${fail.name}:${fail.count}`;
	}

	if (isOurs(text)) {
		// A PATCHED file no longer contains the `old` anchor forms — that is the
		// point — so it is verified by its applied signature instead.
		report.applied_signature = appliedSignature(text) ? "yes" : "no";
		if (!isCurrentRev(text)) report.state = "ours-stale";
		else if (appliedSignature(text)) report.state = "ours-current";
		else report.state = "ours-corrupt";
	} else if (seamPresent(text)) report.state = "upstream-landed";
	else if (fail === null) report.state = "patchable";
	else report.state = "drift";
	return report;
}

function readClient() {
	return readText(CLIENT);
}

function readText(path) {
	return readFileSync(path, "utf8");
}

/** Backup the bytes AS FOUND, patch client.js in place, install the no-op host half. */
function doPatch() {
	mkdirSync(DATA_DIR, { recursive: true });
	copyFileSync(CLIENT, BACKUP_CLIENT);
	copyFileSync(INDEX, BACKUP_INDEX);
	const patched = applyPatch(readClient());
	writeText(CLIENT, patched);
	copyFileSync(STUB_INDEX, INDEX);
	console.log("patched lib/client.js in place (anchors applied); host half stubbed.");
	// dshmarket cannot see this host-file change; the plugin surfaces the
	// restart itself (marker → status response → chip button).
	writeRestartMarker("apply");
}

function writeText(path, text) {
	writeFileSync(path, text, "utf8");
}

const VERDICT_EXIT_1 = new Set(["drift", "unreadable", "missing", "ours-corrupt"]);

const verb = process.argv[2];
if (!verb || !["apply", "revert", "status"].includes(verb)) {
	console.error("usage: apply.js apply|revert|status");
	process.exit(1);
}

if (verb === "status") {
	const r = inspect();
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
	const r = inspect();
	for (const [k, v] of Object.entries(r)) {
		if (k !== "state") console.log(`  ${k}=${v}`);
	}
	console.log(`installed:  ${CLIENT}`);
	switch (r.state) {
		case "ours-current":
			console.log("verdict:    PATCHED (rev current) — nothing to do.");
			break;
		case "patchable":
			doPatch();
			console.log("verdict:    PATCHED.");
			break;
		case "ours-stale": {
			// Our older artifact. The re-patch target is the BACKUP (the bytes as we
			// found them pre-patch). Validate THAT before touching the installed
			// file: restoring a backup whose anchors no longer resolve would
			// overwrite the installed build with an unpatchable older one.
			if (!existsSync(BACKUP_CLIENT)) {
				console.error("REFUSING: installed file is an older artifact of ours but no backup");
				console.error("exists, so the original bytes are unknown. Reinstall the package or");
				console.error("restore the backup by hand, then re-run apply.");
				process.exit(1);
			}
			const backupText = readText(BACKUP_CLIENT);
			const bstate = isOurs(backupText)
				? "ours"
				: seamPresent(backupText)
					? "upstream-landed"
					: firstFailure(backupText) === null
						? "patchable"
						: "drift";
			if (bstate !== "patchable") {
				console.error(`REFUSING: the backup (bytes as found before patching) is '${bstate}',`);
				console.error("not patchable — the anchors no longer match the backed-up upstream.");
				console.error("Nothing was changed. Reinstall the DSH package, then re-run apply.");
				process.exit(1);
			}
			writeText(CLIENT, backupText);
			copyFileSync(BACKUP_INDEX, INDEX);
			doPatch();
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
			console.error("in anchors.js, then re-run: dsh-git-badge-seam status && dsh-git-badge-seam apply");
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
	if (existsSync(BACKUP_CLIENT)) {
		const r = inspect();
		const installedHash = r.hash;
		const backupHash = sha256(readText(BACKUP_CLIENT));
		if (installedHash === backupHash) {
			// Idempotent re-run: the installed bytes already ARE the backup.
			console.log("already reverted — installed client.js matches the backup; nothing to do.");
		} else if (r.state === "ours-current" || r.state === "ours-stale" || r.state === "ours-corrupt") {
			writeText(CLIENT, readText(BACKUP_CLIENT));
			copyFileSync(BACKUP_INDEX, INDEX);
			console.log("reverted client.js/index.js to the bytes as found before patching.");
			// A revert also changes bytes the running bundles were composed from.
			writeRestartMarker("revert");
		} else {
			// Installed file is not ours => upstream replaced it since patching.
			console.error("REFUSING to revert: the installed client.js is not this repo's");
			console.error(`artifact (state: ${r.state}), so upstream replaced it since the patch was`);
			console.error("applied. Restoring the backup would DOWNGRADE the package.");
			console.error("Nothing was changed. If the downgrade is really what you want, restore");
			console.error(`${BACKUP_CLIENT} by hand.`);
			process.exit(1);
		}
	} else {
		const r = inspect();
		if (r.state === "ours-current" || r.state === "ours-stale" || r.state === "ours-corrupt") {
			console.error("REFUSING: the installed file is patched but no backup exists in");
			console.error(`${DATA_DIR}, so the original bytes are unknown here. Options:`);
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
	if (!existsSync(BACKUP_INDEX)) copyFileSync(STUB_INDEX, INDEX);
	console.log("remember to remove the plugin:  dsh plugin --profile web remove dsh-git-badge");
}
