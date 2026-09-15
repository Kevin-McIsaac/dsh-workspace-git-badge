/**
 * The gh skill installer — copies the packaged skill into the user's skills
 * catalog so `/gh` exists in the input's commands menu.
 *
 * WHY A SKILL: the commands menu executes git through the AGENT, not through
 * this plugin — the agent owns the approval/sandbox semantics for mutating
 * commands. The skill is the knowledge; the `/gh` command contribution in the
 * client half is only the state-aware menu entry that invokes it.
 *
 * GUARDRAILS — a skill must never break an install: every failure path returns
 * a reason string instead of throwing, and a current target is a no-op (the
 * byte comparison makes reinstalls and updates idempotent).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export const SKILL_NAME = "gh";

/** The user-level skills catalog — DSH_HOME honours the harness override. */
export function skillsDir() {
	return join(process.env.DSH_HOME || join(process.env.HOME || "", ".dsh"), "skills");
}

export function skillSource() {
	return join(HERE, "..", "skill", "gh", "SKILL.md");
}

export function skillTarget() {
	return join(skillsDir(), SKILL_NAME, "SKILL.md");
}

/**
 * Install (or update) the gh skill. Never throws.
 * @returns {"installed"|"current"|"no packaged skill"|string} what happened.
 */
export function installSkill() {
	try {
		const source = skillSource();
		if (!existsSync(source)) return "no packaged skill";
		const target = skillTarget();
		mkdirSync(dirname(target), { recursive: true });
		if (existsSync(target) && readFileSync(target, "utf8") === readFileSync(source, "utf8")) {
			return "current";
		}
		copyFileSync(source, target);
		return "installed";
	} catch (error) {
		return "skipped (" + String(error?.message ?? error) + ")";
	}
}
