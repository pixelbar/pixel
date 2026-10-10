/**
 * Move CHANGELOG [Unreleased] into a dated version and bump package.json.
 * Added → minor; Fixed/Changed/… → patch. Never major before 1.0.
 * Usage: just bump [--commit] [--date YYYY-MM-DD] [--dry-run]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import {
	applyRelease,
	CHANGELOG_FILE,
	isIsoDate,
	PACKAGE_JSON_FILE,
	readPackageVersion,
	releaseTags,
	setPackageVersion,
	todayUtc,
} from "./changelog.ts";

const args = parseArgs(process.argv.slice(2));

try {
	const changelogPath = CHANGELOG_FILE;
	const packagePath = PACKAGE_JSON_FILE;
	const currentVersion = readPackageVersion(readFileSync(packagePath, "utf8"));
	const result = applyRelease(
		readFileSync(changelogPath, "utf8"),
		currentVersion,
		args.date ?? todayUtc(),
	);

	if (!result.bump) {
		process.stdout.write(`No Unreleased notes; version stays ${result.version}.\n`);
		process.exit(0);
	}

	process.stdout.write(`Bump ${result.previousVersion} → ${result.version} (${result.bump}).\n`);
	if (args.dryRun) process.exit(0);

	writeFileSync(changelogPath, result.changelog);
	writeFileSync(packagePath, setPackageVersion(readFileSync(packagePath, "utf8"), result.version));

	if (!args.commit) process.exit(0);

	runGit(["add", "--", changelogPath, packagePath]);
	runGit(["commit", "-m", `Release v${result.version}`]);
	const existingTags = lines(
		execFileSync("git", ["tag", "--list", "v*"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}),
	);
	for (const tag of releaseTags(result.previousVersion, result.version, existingTags)) {
		if (tag.target === "parent") runGit(["tag", tag.name, "HEAD~1"]);
		else runGit(["tag", tag.name]);
	}
	process.stdout.write(`Committed and tagged v${result.version}.\n`);
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`${message}\n`);
	process.exit(1);
}

function parseArgs(argv: string[]): { commit: boolean; date?: string; dryRun: boolean } {
	let commit = false;
	let dryRun = false;
	let date: string | undefined;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--commit") {
			commit = true;
			continue;
		}
		if (arg === "--dry-run") {
			dryRun = true;
			continue;
		}
		if (arg === "--date") {
			const value = argv[i + 1];
			if (value === undefined) throw new Error("--date needs YYYY-MM-DD.");
			if (!isIsoDate(value)) throw new Error(`--date must be YYYY-MM-DD, got ${value}.`);
			date = value;
			i += 1;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}
	return { commit, date, dryRun };
}

function runGit(args: readonly string[]): void {
	execFileSync("git", args, { stdio: "inherit" });
}

function lines(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
}
