/**
 * Two out-of-band stores live here, both keyed files under dataDir():
 *
 *   restart-pending.json    install/applied a host patch → the UI offers a restart
 *   session-checkouts.json  which checkout a SESSION is working in — the one
 *                           fact dsh cannot supply (a session's cwd is immutable
 *                           creation metadata and always the main checkout, so a
 *                           session working in a linked worktree is invisible
 *                           without an explicit registration)
 *
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
/** How long a session-checkout registration stays trustworthy. */
export const SESSION_CHECKOUT_TTL_MS = 24 * 60 * 60 * 1000;

function sessionCheckoutsPath() {
	return join(dataDir(), "session-checkouts.json");
}

/** Every registration, `{ sessionId: { path, at } }`. Never throws.
 *
 * `file` overrides the store path — the test seam lib/index.js uses (its
 * `config.sessionCheckoutsFile`) — so the file's shape is parsed in ONE place.
 */
export function readSessionCheckouts(file = sessionCheckoutsPath()) {
	try {
		if (!existsSync(file)) return {};
		const raw = JSON.parse(readFileSync(file, "utf8"));
		return raw !== null && typeof raw === "object" && typeof raw.sessions === "object" && raw.sessions !== null
			? raw.sessions
			: {};
	} catch {
		return {};
	}
}

/**
 * Register the checkout a session is working in. Written by the agent (the
 * git-worktree and /gh checkout paths), read by the node half.
 */
export function writeSessionCheckout(sessionId, path) {
	try {
		mkdirSync(dataDir(), { recursive: true });
		const sessions = readSessionCheckouts();
		sessions[sessionId] = { path, at: new Date().toISOString() };
		writeFileSync(
			sessionCheckoutsPath(),
			JSON.stringify({ schema: "dsh-git-badge/session-checkout/v1", sessions }),
			"utf8",
		);
		return true;
	} catch {
		return false;
	}
}

/** Forget one session's registration (worktree removed, or the session left). */
export function clearSessionCheckout(sessionId) {
	try {
		const sessions = readSessionCheckouts();
		if (!(sessionId in sessions)) return true;
		delete sessions[sessionId];
		writeFileSync(
			sessionCheckoutsPath(),
			JSON.stringify({ schema: "dsh-git-badge/session-checkout/v1", sessions }),
			"utf8",
		);
		return true;
	} catch {
		return false;
	}
}
