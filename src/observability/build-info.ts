import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { BuildInfo } from "../core/announcement.ts";

/**
 * What this copy of Pixel is: the package version, the git commit and branch it
 * was built from, and the environment. CI and the Docker build pass the commit and
 * branch in (`PIXEL_GIT_SHA`, `PIXEL_GIT_BRANCH`), since an image has no `.git`.
 * When running from a checkout without them, it asks git. Never throws: anything it
 * can't find is left out.
 */
export function loadBuildInfo(
	config: { env: string; gitSha: string | undefined; gitBranch: string | undefined },
	options: { git?: (args: string[]) => string | undefined; packageJson?: string } = {},
): BuildInfo {
	const git = options.git ?? runGit;
	const commit = config.gitSha ?? git(["rev-parse", "HEAD"]);
	const branch = config.gitBranch ?? git(["rev-parse", "--abbrev-ref", "HEAD"]);
	return {
		version: packageVersion(options.packageJson),
		commit: commit ? commit.slice(0, 7) : undefined,
		// "HEAD" means a detached checkout: there is no branch to name.
		branch: branch && branch !== "HEAD" ? branch : undefined,
		env: config.env,
	};
}

function packageVersion(
	path: string | URL = new URL("../../package.json", import.meta.url),
): string {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
		return typeof parsed.version === "string" ? parsed.version : "unknown";
	} catch {
		return "unknown";
	}
}

function runGit(args: string[]): string | undefined {
	try {
		const out = execFileSync("git", args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 2000,
		}).trim();
		return out === "" ? undefined : out;
	} catch {
		return undefined;
	}
}
