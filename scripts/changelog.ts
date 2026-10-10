/**
 * Keep a Changelog helpers: the PR gate and the 0.x version bump.
 * CLIs live in check-changelog.ts and bump-version.ts.
 */

export const CHANGELOG_FILE = "CHANGELOG.md";
export const PACKAGE_JSON_FILE = "package.json";
export const SKIP_CHANGELOG_LABEL = "skip-changelog";
export const DEFAULT_CHANGELOG_BASE = "origin/main";
export const REPO_URL = "https://github.com/pixelbar/pixel";

export const CHANGELOG_SECTIONS = [
	"Added",
	"Changed",
	"Deprecated",
	"Removed",
	"Fixed",
	"Security",
] as const;

export type ChangelogSection = (typeof CHANGELOG_SECTIONS)[number];
export type BumpKind = "minor" | "patch";

export type ChangelogGateInput = {
	changedFiles: readonly string[];
	skipChangelog: boolean;
};

export type ChangelogGateResult = { ok: true } | { ok: false; reason: string };

const UNRELEASED_HEADING = "## [Unreleased]";
const SECTION_HEADING = /^### (Added|Changed|Deprecated|Removed|Fixed|Security)\s*$/;
const LIST_ITEM = /^\s*[-*]\s+(\S.*)$/;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UNRELEASED_LINK = /^\[unreleased\]:\s+\S+/i;

export function truthyFlag(value: string | undefined): boolean {
	if (value === undefined) return false;
	const normalised = value.trim().toLowerCase();
	return normalised === "1" || normalised === "true" || normalised === "yes";
}

export function changelogPath(file: string): string {
	return file.replace(/^\.\//, "");
}

export function changelogGate(input: ChangelogGateInput): ChangelogGateResult {
	if (input.skipChangelog) return { ok: true };
	const touched = input.changedFiles.some((file) => changelogPath(file) === CHANGELOG_FILE);
	if (touched) return { ok: true };
	return {
		ok: false,
		reason:
			`This change must update ${CHANGELOG_FILE} under ## [Unreleased]. ` +
			`Pure chores (typos, CI-only, no user or operator impact) may use the ${SKIP_CHANGELOG_LABEL} label.`,
	};
}

export function collectChangedFiles(
	runGit: (args: readonly string[]) => string,
	base: string,
): string[] {
	const committed = lines(runGit(["diff", "--name-only", `${base}...HEAD`]));
	const vsHead = lines(runGit(["diff", "--name-only", "HEAD"]));
	const untracked = lines(runGit(["ls-files", "--others", "--exclude-standard"]));
	return unique([...committed, ...vsHead, ...untracked]);
}

export function parseUnreleasedSections(
	unreleasedBody: string,
): Partial<Record<ChangelogSection, string[]>> {
	const sections: Partial<Record<ChangelogSection, string[]>> = {};
	let current: ChangelogSection | undefined;
	for (const line of unreleasedBody.split("\n")) {
		const heading = SECTION_HEADING.exec(line);
		const name = heading?.[1];
		if (name && isChangelogSection(name)) {
			current = name;
			sections[current] ??= [];
			continue;
		}
		if (!current) continue;
		const item = LIST_ITEM.exec(line);
		const text = item?.[1];
		if (text) sections[current]?.push(text.trimEnd());
	}
	return sections;
}

export function bumpFromUnreleased(
	sections: Partial<Record<ChangelogSection, string[]>>,
): BumpKind | null {
	if (hasItems(sections, "Added")) return "minor";
	for (const section of CHANGELOG_SECTIONS) {
		if (hasItems(sections, section)) return "patch";
	}
	return null;
}

export function nextVersion(current: string, kind: BumpKind): string {
	const parsed = parseSemver(current);
	// Until 1.0 this never returns a 1.x version, even from 0.99.0.
	if (parsed.major === 0) {
		if (kind === "minor") return `0.${parsed.minor + 1}.0`;
		return `0.${parsed.minor}.${parsed.patch + 1}`;
	}
	if (kind === "minor") return `${parsed.major}.${parsed.minor + 1}.0`;
	return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

export function parseSemver(version: string): { major: number; minor: number; patch: number } {
	const match = SEMVER.exec(version);
	const major = match?.[1];
	const minor = match?.[2];
	const patch = match?.[3];
	if (!match || major === undefined || minor === undefined || patch === undefined) {
		throw new Error(`Expected a semver X.Y.Z version, got ${JSON.stringify(version)}.`);
	}
	return { major: Number(major), minor: Number(minor), patch: Number(patch) };
}

export function isIsoDate(value: string): boolean {
	return ISO_DATE.test(value);
}

export function todayUtc(): string {
	return new Date().toISOString().slice(0, 10);
}

export type ReleaseTag = { name: string; target: "parent" | "head" };

/** Tag the new version on HEAD. If the previous version was never tagged, tag the parent. */
export function releaseTags(
	previousVersion: string,
	newVersion: string,
	existingTags: readonly string[],
): ReleaseTag[] {
	const tags: ReleaseTag[] = [];
	const previous = `v${previousVersion}`;
	if (!existingTags.includes(previous)) tags.push({ name: previous, target: "parent" });
	tags.push({ name: `v${newVersion}`, target: "head" });
	return tags;
}

export function setPackageVersion(source: string, version: string): string {
	const parsed: unknown = JSON.parse(source);
	if (!isPackageJson(parsed)) {
		throw new Error("package.json has no string version.");
	}
	parsed.version = version;
	return `${JSON.stringify(parsed, null, "\t")}\n`;
}

export function readPackageVersion(source: string): string {
	const parsed: unknown = JSON.parse(source);
	if (!isPackageJson(parsed)) {
		throw new Error("package.json has no string version.");
	}
	return parsed.version;
}

export type ReleaseResult =
	| {
			bump: BumpKind;
			previousVersion: string;
			version: string;
			changelog: string;
	  }
	| { bump: null; version: string; changelog: string };

export function applyRelease(
	changelog: string,
	currentVersion: string,
	date: string,
	repoUrl: string = REPO_URL,
): ReleaseResult {
	if (!isIsoDate(date)) {
		throw new Error(`Release date must be YYYY-MM-DD, got ${JSON.stringify(date)}.`);
	}
	const doc = parseChangelog(changelog);
	const kind = bumpFromUnreleased(parseUnreleasedSections(doc.unreleased));
	if (!kind) {
		return { bump: null, version: currentVersion, changelog };
	}
	const version = nextVersion(currentVersion, kind);
	const releasedBody = doc.unreleased.trim();
	if (!releasedBody) {
		return { bump: null, version: currentVersion, changelog };
	}
	const nextSection = `## [${version}] - ${date}\n\n${releasedBody}\n`;
	const rest = doc.rest.trimStart();
	const rebuilt = `${doc.preamble}${UNRELEASED_HEADING}\n\n${nextSection}\n${rest}`;
	const withLinks = updateCompareLinks(rebuilt, doc.links, currentVersion, version, repoUrl);
	return { bump: kind, previousVersion: currentVersion, version, changelog: withLinks };
}

type ParsedChangelog = {
	preamble: string;
	unreleased: string;
	rest: string;
	links: string;
};

export function parseChangelog(text: string): ParsedChangelog {
	const linkStart = findLinkFooterStart(text);
	const main = linkStart === -1 ? text : text.slice(0, linkStart);
	const links = linkStart === -1 ? "" : text.slice(linkStart);
	const unreleasedIdx = main.indexOf(UNRELEASED_HEADING);
	if (unreleasedIdx === -1) {
		throw new Error(`${CHANGELOG_FILE} must contain a ${UNRELEASED_HEADING} section.`);
	}
	const preamble = main.slice(0, unreleasedIdx);
	const afterHeading = main.slice(unreleasedIdx + UNRELEASED_HEADING.length).replace(/^\n/, "");
	const nextHeading = afterHeading.search(/^## \[/m);
	if (nextHeading === -1) {
		return { preamble, unreleased: afterHeading.replace(/\s+$/, ""), rest: "", links };
	}
	return {
		preamble,
		unreleased: afterHeading.slice(0, nextHeading).replace(/\s+$/, ""),
		rest: afterHeading.slice(nextHeading),
		links,
	};
}

function updateCompareLinks(
	body: string,
	existingLinks: string,
	previous: string,
	next: string,
	repoUrl: string,
): string {
	const unreleasedLine = `[Unreleased]: ${repoUrl}/compare/v${next}...HEAD`;
	const nextLine = `[${next}]: ${repoUrl}/compare/v${previous}...v${next}`;
	const previousLine = `[${previous}]: ${repoUrl}/releases/tag/v${previous}`;

	if (!existingLinks.trim()) {
		return `${ensureTrailingNewline(body)}\n${unreleasedLine}\n${nextLine}\n${previousLine}\n`;
	}

	const lines = existingLinks.split("\n");
	const out: string[] = [];
	let replacedUnreleased = false;
	let insertedNext = false;
	for (const line of lines) {
		if (UNRELEASED_LINK.test(line)) {
			out.push(unreleasedLine);
			if (!insertedNext) {
				out.push(nextLine);
				insertedNext = true;
			}
			replacedUnreleased = true;
			continue;
		}
		out.push(line);
	}
	if (!replacedUnreleased) {
		out.unshift(nextLine);
		out.unshift(unreleasedLine);
		insertedNext = true;
	}
	if (!insertedNext) out.splice(1, 0, nextLine);
	if (!out.some((line) => line.startsWith(`[${previous}]:`))) {
		out.push(previousLine);
	}
	return `${ensureTrailingNewline(body)}${ensureTrailingNewline(out.join("\n"))}`;
}

function findLinkFooterStart(text: string): number {
	const match = /(?:^|\n)(\[[^\]]+\]:\s+\S+)/.exec(text);
	if (!match || match.index === undefined) return -1;
	return match[0].startsWith("\n") ? match.index + 1 : match.index;
}

function hasItems(
	sections: Partial<Record<ChangelogSection, string[]>>,
	section: ChangelogSection,
): boolean {
	return (sections[section] ?? []).some((item) => item.trim() !== "");
}

function isChangelogSection(value: string): value is ChangelogSection {
	return (CHANGELOG_SECTIONS as readonly string[]).includes(value);
}

function isPackageJson(value: unknown): value is { version: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		"version" in value &&
		typeof value.version === "string"
	);
}

function lines(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}

function ensureTrailingNewline(text: string): string {
	return text.endsWith("\n") ? text : `${text}\n`;
}
