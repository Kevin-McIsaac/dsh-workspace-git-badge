/**
 * The restart-pending marker — the bridge from install-time (node side) to the
 * running UI.
 *
 * WHY IT EXISTS: dshmarket's pending-restart banner tracks its own package
 * bookkeeping. A postinstall that patches the DSH HOST package
 * (dsh-client-ui-workspace) mutates files outside that bookkeeping, so the
 * market can complete "restart-free" while the host's composed client bundles
 * no longer match the files on disk. The marker is the out-of-band signal:
 *
 *   postinstall / apply / revert  → write the marker (seam changed on disk)
 *   plugin node half, at boot     → clear the marker (fresh boot composed the
 *                                   new bytes; the change is live)
 *   plugin client half            → while the marker is served on the status
 *                                   response, offer a Restart button calling
 *                                   dshmarket's public v1 restart endpoint
 *
 * The hot-mount path is what makes this work on a FIRST market install: the
 * freshly installed plugin's client half mounts into the running shell, reads
 * the marker through the status response, and can restart the host — even
 * though the process that installed the patch is gone.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The stable backup store — same default apply.js uses; SEAM_DATA_DIR overrides. */
export function dataDir() {
	if (process.env.SEAM_DATA_DIR) return process.env.SEAM_DATA_DIR;
	return join(process.env.DSH_HOME || join(process.env.HOME || "", ".dsh"), "git-badge-seam");
}

function markerPath() {
	return join(dataDir(), "restart-pending.json");
}

/**
 * Record that DSH files were changed on disk and a restart is needed to
 * compose them. `reason` is a one-word actor (postinstall | apply | revert).
 */
export function writeRestartMarker(reason) {
	try {
		mkdirSync(dataDir(), { recursive: true });
		writeFileSync(
			markerPath(),
			JSON.stringify({ schema: "dsh-git-badge/restart-pending/v1", by: reason, at: new Date().toISOString() }),
			"utf8",
		);
	} catch {
		// The marker is a UX nicety; never fail the operation that earned it.
	}
}

/** The pending marker, or null. Never throws. */
export function readRestartMarker() {
	try {
		if (!existsSync(markerPath())) return null;
		return JSON.parse(readFileSync(markerPath(), "utf8"));
	} catch {
		return null;
	}
}

/** The change is live — a new boot composed it. Clear the pending state. */
export function clearRestartMarker() {
	try {
		rmSync(markerPath(), { force: true });
	} catch {
		// Absent is the goal; any error leaves the marker to be cleared later.
	}
}