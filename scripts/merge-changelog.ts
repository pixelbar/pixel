/**
 * Resolve a CHANGELOG.md conflict by keeping both sides' [Unreleased] entries
 * (see changelog-merge.ts for when it refuses).
 *
 * Usage:
 *   just changelog-merge
 *     In a merge or rebase that stopped on CHANGELOG.md: resolve it from the
 *     index stages and `git add` it.
 *   node scripts/merge-changelog.ts <base> <current> <other>
 *     As a git merge driver (`just changelog-merge-driver` sets it up). On a
 *     refusal it leaves the usual conflict markers and exits 1.
 *
 * In a merge the current side is the branch and the other is main; in a
 * rebase onto main it is the other way round, so the rebase is detected.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { CHANGELOG_FILE } from "./changelog.ts";
import { mergeChangelogs } from "./changelog-merge.ts";

const git = (...args: string[]) =>
	execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function rebasing(): boolean {
	return ["rebase-merge", "rebase-apply"].some((dir) =>
		existsSync(git("rev-parse", "--git-path", dir).trim()),
	);
}

/** The branch and main sides, given git's current and other. */
function sides(current: string, other: string): { branch: string; main: string } {
	return rebasing() ? { branch: other, main: current } : { branch: current, main: other };
}

const args = process.argv.slice(2);

if (args.length === 3) {
	const [basePath = "", currentPath = "", otherPath = ""] = args;
	const base = readFileSync(basePath, "utf8");
	const current = readFileSync(currentPath, "utf8");
	const other = readFileSync(otherPath, "utf8");
	const result = mergeChangelogs({ base, ...sides(current, other) });
	if (result.ok) {
		writeFileSync(currentPath, result.text);
		process.exit(0);
	}
	process.stderr.write(`${CHANGELOG_FILE}: ${result.reason} Resolve it by hand.\n`);
	try {
		// Leave the usual conflict markers, as git's own merge would.
		execFileSync("git", [
			"merge-file",
			"-L",
			"current",
			"-L",
			"base",
			"-L",
			"other",
			currentPath,
			basePath,
			otherPath,
		]);
	} catch {
		// merge-file exits non-zero when it wrote conflicts, which is the point.
	}
	process.exit(1);
}

if (args.length === 0 || (args.length === 1 && args[0] === "--git")) {
	const stage = (n: 1 | 2 | 3) => {
		try {
			return git("show", `:${n}:${CHANGELOG_FILE}`);
		} catch {
			return undefined;
		}
	};
	const [base, current, other] = [stage(1), stage(2), stage(3)];
	if (base === undefined || current === undefined || other === undefined) {
		process.stderr.write(`${CHANGELOG_FILE} is not in conflict (or was added on both sides).\n`);
		process.exit(1);
	}
	const result = mergeChangelogs({ base, ...sides(current, other) });
	if (!result.ok) {
		process.stderr.write(`${CHANGELOG_FILE}: ${result.reason} Resolve it by hand.\n`);
		process.exit(1);
	}
	writeFileSync(CHANGELOG_FILE, result.text);
	git("add", CHANGELOG_FILE);
	process.stdout.write(`${CHANGELOG_FILE}: kept both sides' [Unreleased] entries.\n`);
	process.exit(0);
}

process.stderr.write("Usage: node scripts/merge-changelog.ts [--git] | <base> <current> <other>\n");
process.exit(2);
