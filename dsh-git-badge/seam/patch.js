/**
 * The seam-patch engine — the ONE copy of the mechanics both patch entry
 * points share: seam/apply.js (the shipped CLI) and seam/postinstall.js (the
 * install hook). Locating the install, inspecting its state, and writing the
 * patch each used to exist twice, once per entry point, with the guardrails
 * duplicated between them; now the entry points only decide what to SAY and
 * which exits to take. This module returns facts and never prints.
 *
 * The patch itself is defined once in anchors.js; see its header for the
 * anchor-not-hash design and the safety rails (own-artifact detection, backup
 * of the bytes as found, downgrade-guarded revert).
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appliedSignature, applyPatch, firstFailure, isCurrentRev, isOurs, seamPresent } from "./anchors.js";
import { dataDir, writeRestartMarker } from "./store.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// sha256 of the upstream build the anchors were last verified against. ADVISORY:
// status prints it for orientation; apply does NOT require it.
export const KNOWN_GOOD_HASH = "383b9ef779366c13d818500b6488896328b189f156addbaa480c835e902edd5f";

/** Locate the installed DSH package root; null when it cannot be found. */
export function dshRoot() {
	if (process.env.DSH_INSTALL) return process.env.DSH_INSTALL;
	try {
		return join(execSync("npm root -g", { encoding: "utf8" }).trim(), "@deepseek-ai", "dsh");
	} catch {
		return null;
	}
}

/**
 * The files one patch acts on, resolved against `root` (default: the located
 * DSH install). Null when there is no root — the entry points print their own
 * "cannot locate" advice. Backup paths resolve per call, so SEAM_DATA_DIR (and
 * DSH_INSTALL) are honoured whenever the process environment says so.
 */
export function installPaths(root = dshRoot()) {
	if (!root) return null;
	const pkg = join(root, "node_modules", "@deepseek-ai", "dsh-client-ui-workspace");
	const store = dataDir();
	return {
		root,
		client: join(pkg, "lib", "client.js"),
		index: join(pkg, "lib", "index.js"),
		stub: join(HERE, "stub-index.js"),
		backupClient: join(store, "backup-client.js"),
		backupIndex: join(store, "backup-index.js")
	};
}

export const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

const readText = (path) => readFileSync(path, "utf8");

/**
 * Inspect the installed client.js. Returns the key:value report the CLI's
 * `status` prints, with `state` one of: missing | unreadable | ours-current |
 * ours-stale | ours-corrupt | upstream-landed | patchable | drift.
 */
export function inspect(paths = installPaths()) {
	const report = {};
	let text;
	try {
		text = readText(paths.client);
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
	report.backup = existsSync(paths.backupClient) ? "yes" : "no";
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

/**
 * The backup's own patchability — the upgrade path validates it BEFORE
 * restoring, so re-patching can never overwrite the installed build with an
 * unpatchable older one. Returns "ours" | "upstream-landed" | "patchable" | "drift".
 */
export function backupState(paths) {
	const text = readText(paths.backupClient);
	return isOurs(text)
		? "ours"
		: seamPresent(text)
			? "upstream-landed"
			: firstFailure(text) === null
				? "patchable"
				: "drift";
}

/**
 * Backup the bytes AS FOUND, patch client.js in place, install the no-op host
 * half, and record the restart marker (`reason` names the actor: apply |
 * postinstall | revert). Callers gate on inspect() first — this writes
 * unconditionally.
 */
export function doPatch(paths, reason = "apply") {
	mkdirSync(dataDir(), { recursive: true });
	copyFileSync(paths.client, paths.backupClient);
	copyFileSync(paths.index, paths.backupIndex);
	writeFileSync(paths.client, applyPatch(readText(paths.client)));
	copyFileSync(paths.stub, paths.index);
	writeRestartMarker(reason);
}

/** Restore the backup over the installed files. The caller has already gated. */
export function doRestore(paths) {
	writeFileSync(paths.client, readText(paths.backupClient));
	copyFileSync(paths.backupIndex, paths.index);
}
