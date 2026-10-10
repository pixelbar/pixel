/**
 * Fail unless this branch updates CHANGELOG.md.
 * Usage: just check-changelog [--base <ref>] [--skip]
 */
import { execFileSync } from "node:child_process";
import {
	CHANGELOG_FILE,
	changelogGate,
	collectChangedFiles,
	DEFAULT_CHANGELOG_BASE,
	SKIP_CHANGELOG_LABEL,
	truthyFlag,
} from "./changelog.ts";

const args = parseArgs(process.argv.slice(2));
const skip = args.skip || truthyFlag(process.env.SKIP_CHANGELOG);
const base = args.base ?? process.env.CHANGELOG_BASE ?? DEFAULT_CHANGELOG_BASE;

try {
	const changedFiles = args.files ?? collectChangedFiles(runGit, base);
	const result = changelogGate({ changedFiles, skipChangelog: skip });
	if (result.ok) {
		const why = skip
			? `${SKIP_CHANGELOG_LABEL} is set; ${CHANGELOG_FILE} is not required.`
			: `${CHANGELOG_FILE} is in this change.`;
		process.stdout.write(`${why}\n`);
		process.exit(0);
	}
	process.stderr.write(`${result.reason}\n`);
	process.exit(1);
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`${message}\n`);
	process.exit(1);
}

function parseArgs(argv: string[]): { base?: string; skip: boolean; files?: string[] } {
	let base: string | undefined;
	let skip = false;
	let files: string[] | undefined;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--skip") {
			skip = true;
			continue;
		}
		if (arg === "--base" || arg === "--files") {
			const value = argv[i + 1];
			if (value === undefined) throw new Error(`${arg} needs a value.`);
			i += 1;
			if (arg === "--base") base = value;
			else
				files = value
					.split(",")
					.map((file) => file.trim())
					.filter(Boolean);
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}
	return { base, skip, files };
}

function runGit(args: readonly string[]): string {
	return execFileSync("git", args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}
