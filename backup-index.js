//#region lib/types/index.js
/**
* Workspace picker plugin, node half — PATCHED (feat/workspace-git-badge).
*
* Upstream this plugin is a pure UI plugin with an empty apply. This patch
* adds one host-side piece so the sidebar's workspace rows can show a git
* badge: an exact HTTP route on the loopback web server,
*
*   GET /api/workspace-git?path=<workspace path>
*     -> { git: false }                            (not a repository)
*     -> { git: true, branch, dirty }              (branch "" => detached HEAD)
*
* The route runs `git` in the requested directory. It only ever reads git
* metadata (rev-parse / branch / status --porcelain) — no checkout, no
* mutation — and the web server binds loopback only. Paths are not
* restricted to registered Workspaces; the browser only ever asks with
* paths the Host itself supplied as workspace cwd values.
*/
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";

const inject = ["webServer"];
const name = "@deepseek-ai/dsh-client-ui-workspace";

/** Run git in dir; resolve to stdout, or null on any failure / timeout. */
function runGit(dir, args) {
	return new Promise((resolve) => {
		execFile("git", args, { cwd: dir, timeout: 3000 }, (error, stdout) => {
			resolve(error ? null : String(stdout));
		});
	});
}

/** Branch + dirty for dir; { git: false } when dir is not inside a repository. */
async function gitStatus(dir) {
	const top = await runGit(dir, ["rev-parse", "--show-toplevel"]);
	if (top === null || top.trim() === "") return { git: false };
	const toplevel = top.trim();
	const [branchOut, statusOut] = await Promise.all([
		runGit(toplevel, ["branch", "--show-current"]),
		runGit(toplevel, ["status", "--porcelain"])
	]);
	if (branchOut === null || statusOut === null) return { git: false };
	return {
		git: true,
		branch: branchOut.trim() || "HEAD (detached)",
		dirty: statusOut.trim().length > 0
	};
}

/** Host plugin body — registers the /api/workspace-git route for the badge. */
function apply(ctx) {
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/api/workspace-git",
		handler: async (req, res) => {
			try {
				const url = new URL(req.url, "http://localhost");
				const path = url.searchParams.get("path") ?? "";
				if (path === "") throw new Error("missing path");
				const info = await stat(path).catch(() => null);
				if (info === null || !info.isDirectory()) throw new Error("not a directory");
				const body = JSON.stringify(await gitStatus(path));
				res.writeHead(200, { "content-type": "application/json" });
				res.end(body);
			} catch (error) {
				res.writeHead(400, { "content-type": "application/json" });
				res.end(JSON.stringify({ git: false, error: String(error?.message ?? error) }));
			}
		}
	}));
}
//#endregion
export { apply, inject, name };
