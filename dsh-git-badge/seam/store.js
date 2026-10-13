/**
 * The session-checkout store — one keyed file under dataDir():
 *
 *   session-checkouts.json  which checkout a SESSION is working in — the one
 *                           fact dsh cannot supply (a session's cwd is immutable
 *                           creation metadata and always the main checkout, so a
 *                           session working in a linked worktree is invisible
 *                           without an explicit registration)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The stable store directory — SEAM_DATA_DIR overrides. */
function dataDir() {
	if (process.env.SEAM_DATA_DIR) return process.env.SEAM_DATA_DIR;
	return join(process.env.DSH_HOME || join(process.env.HOME || "", ".dsh"), "git-badge-seam");
}

/** How long a session-checkout registration stays trustworthy. */
export const SESSION_CHECKOUT_TTL_MS = 24 * 60 * 60 * 1000;

function sessionCheckoutsPath() {
	return join(dataDir(), "session-checkouts.json");
}

const SCHEMA = "dsh-git-badge/session-checkout/v1";

/** Write the whole store in one place — the schema lives beside this call. */
function persist(sessions) {
	writeFileSync(sessionCheckoutsPath(), JSON.stringify({ schema: SCHEMA, sessions }), "utf8");
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
 *
 * Returns the OUTCOME rather than a boolean, because the reason matters here more
 * than anywhere else in this file. A registration that cannot be written is the
 * one failure the badge CANNOT show: the session quietly keeps its inferred
 * checkout, which looks identical to a session with nothing to follow. The caller
 * gets `error`/`code` so it can say what went wrong and where, instead of
 * reporting a bare failure that the next reader has to rediscover the hard way.
 */
export function writeSessionCheckout(sessionId, path) {
	const file = sessionCheckoutsPath();
	try {
		mkdirSync(dataDir(), { recursive: true });
		const sessions = readSessionCheckouts();
		sessions[sessionId] = { path, at: new Date().toISOString() };
		persist(sessions);
		return { ok: true, file };
	} catch (error) {
		return { ok: false, file, error: String(error?.message ?? error), code: String(error?.code ?? "") };
	}
}

/** Forget one session's registration (worktree removed, or the session left). */
export function clearSessionCheckout(sessionId) {
	try {
		const sessions = readSessionCheckouts();
		if (!(sessionId in sessions)) return;
		delete sessions[sessionId];
		persist(sessions);
	} catch {
		// forgetting is best-effort: the registration expires on its own
	}
}
