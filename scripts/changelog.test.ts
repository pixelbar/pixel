import { describe, expect, it } from "vitest";
import {
	applyRelease,
	bumpFromUnreleased,
	CHANGELOG_FILE,
	changelogGate,
	changelogPath,
	collectChangedFiles,
	nextVersion,
	parseChangelog,
	parseSemver,
	parseUnreleasedSections,
	readPackageVersion,
	releaseTags,
	SKIP_CHANGELOG_LABEL,
	setPackageVersion,
	truthyFlag,
} from "./changelog.ts";

const SAMPLE = `# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A new command.

### Fixed

- A reply that lied.

## [0.1.0] - 2026-10-09

### Added

- Phase 1.

[Unreleased]: https://github.com/pixelbar/pixel/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/pixelbar/pixel/releases/tag/v0.1.0
`;

describe("changelogGate", () => {
	it("passes when CHANGELOG.md changed", () => {
		expect(
			changelogGate({ changedFiles: ["src/foo.ts", CHANGELOG_FILE], skipChangelog: false }),
		).toEqual({ ok: true });
	});

	it("accepts a ./ prefix on the changelog path", () => {
		expect(changelogPath("./CHANGELOG.md")).toBe(CHANGELOG_FILE);
		expect(changelogGate({ changedFiles: ["./CHANGELOG.md"], skipChangelog: false })).toEqual({
			ok: true,
		});
	});

	it("passes when the skip-changelog label is set, even without a changelog edit", () => {
		expect(changelogGate({ changedFiles: ["src/foo.ts"], skipChangelog: true })).toEqual({
			ok: true,
		});
	});

	it("fails when the changelog is untouched and the skip label is absent", () => {
		const result = changelogGate({
			changedFiles: ["src/foo.ts", "justfile"],
			skipChangelog: false,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain(CHANGELOG_FILE);
			expect(result.reason).toContain(SKIP_CHANGELOG_LABEL);
		}
	});
});

describe("truthyFlag", () => {
	it.each(["1", "true", "TRUE", " yes "])("treats %j as set", (value) => {
		expect(truthyFlag(value)).toBe(true);
	});

	it.each([undefined, "", "0", "false", "no"])("treats %j as unset", (value) => {
		expect(truthyFlag(value)).toBe(false);
	});
});

describe("collectChangedFiles", () => {
	it("unions committed, working-tree and untracked paths", () => {
		const runGit = (args: readonly string[]): string => {
			if (args[0] === "diff" && args[2] === "origin/main...HEAD") return "src/a.ts\n";
			if (args[0] === "diff" && args[2] === "HEAD") return "CHANGELOG.md\n";
			if (args[0] === "ls-files") return "notes.txt\nCHANGELOG.md\n";
			throw new Error(`unexpected git ${args.join(" ")}`);
		};
		expect(collectChangedFiles(runGit, "origin/main").sort()).toEqual([
			"CHANGELOG.md",
			"notes.txt",
			"src/a.ts",
		]);
	});
});

describe("parseUnreleasedSections", () => {
	it("collects list items under Keep a Changelog headings", () => {
		expect(
			parseUnreleasedSections("### Added\n\n- One.\n- Two.\n\n### Fixed\n\n- A bug.\n"),
		).toEqual({
			Added: ["One.", "Two."],
			Fixed: ["A bug."],
		});
	});

	it("ignores empty headings", () => {
		expect(parseUnreleasedSections("### Added\n\n### Changed\n")).toEqual({
			Added: [],
			Changed: [],
		});
	});
});

describe("bumpFromUnreleased", () => {
	it("maps Added to minor, even when Fixed is also present", () => {
		expect(bumpFromUnreleased({ Added: ["A feature."], Fixed: ["A bug."] })).toBe("minor");
	});

	it.each(["Changed", "Deprecated", "Removed", "Fixed", "Security"] as const)(
		"maps %s to patch",
		(section) => {
			expect(bumpFromUnreleased({ [section]: ["A note."] })).toBe("patch");
		},
	);

	it("returns null when Unreleased has no items", () => {
		expect(bumpFromUnreleased({ Added: [], Fixed: [] })).toBeNull();
		expect(bumpFromUnreleased({})).toBeNull();
	});
});

describe("nextVersion", () => {
	it("never bumps major before 1.0", () => {
		expect(nextVersion("0.1.0", "minor")).toBe("0.2.0");
		expect(nextVersion("0.1.0", "patch")).toBe("0.1.1");
		expect(nextVersion("0.9.0", "minor")).toBe("0.10.0");
		expect(nextVersion("0.99.3", "minor")).toBe("0.100.0");
	});

	it("bumps minor and patch after 1.0 without inventing a major", () => {
		expect(nextVersion("1.0.0", "minor")).toBe("1.1.0");
		expect(nextVersion("1.2.3", "patch")).toBe("1.2.4");
	});

	it("rejects a non-semver package version", () => {
		expect(() => parseSemver("1.0")).toThrow(/X\.Y\.Z/);
	});
});

describe("releaseTags", () => {
	it("tags the previous version on the parent when that tag is missing", () => {
		expect(releaseTags("0.1.0", "0.2.0", [])).toEqual([
			{ name: "v0.1.0", target: "parent" },
			{ name: "v0.2.0", target: "head" },
		]);
	});

	it("only tags the new version when the previous tag already exists", () => {
		expect(releaseTags("0.2.0", "0.2.1", ["v0.1.0", "v0.2.0"])).toEqual([
			{ name: "v0.2.1", target: "head" },
		]);
	});
});

describe("package.json version", () => {
	it("rewrites the version and keeps tab indentation", () => {
		const source = '{\n\t"name": "pixel",\n\t"version": "0.1.0"\n}\n';
		expect(readPackageVersion(source)).toBe("0.1.0");
		expect(setPackageVersion(source, "0.2.0")).toBe(
			'{\n\t"name": "pixel",\n\t"version": "0.2.0"\n}\n',
		);
	});
});

describe("applyRelease", () => {
	it("moves Unreleased into a dated version and rewrites compare links", () => {
		const result = applyRelease(SAMPLE, "0.1.0", "2026-10-10");
		expect(result.bump).toBe("minor");
		if (!result.bump) throw new Error("expected a bump");
		expect(result.version).toBe("0.2.0");
		expect(result.previousVersion).toBe("0.1.0");
		expect(result.changelog).toContain("## [Unreleased]\n\n## [0.2.0] - 2026-10-10\n");
		expect(result.changelog).toContain("### Added\n\n- A new command.");
		expect(result.changelog).toContain("### Fixed\n\n- A reply that lied.");
		expect(result.changelog).toContain("## [0.1.0] - 2026-10-09");
		expect(result.changelog).toContain(
			"[Unreleased]: https://github.com/pixelbar/pixel/compare/v0.2.0...HEAD",
		);
		expect(result.changelog).toContain(
			"[0.2.0]: https://github.com/pixelbar/pixel/compare/v0.1.0...v0.2.0",
		);
		expect(result.changelog).toContain(
			"[0.1.0]: https://github.com/pixelbar/pixel/releases/tag/v0.1.0",
		);
		expect(result.changelog).not.toMatch(/## \[Unreleased\][\s\S]*### Added[\s\S]*## \[0\.2\.0\]/);
	});

	it("is a no-op when Unreleased has no items", () => {
		const empty = SAMPLE.replace(
			"## [Unreleased]\n\n### Added\n\n- A new command.\n\n### Fixed\n\n- A reply that lied.\n",
			"## [Unreleased]\n",
		);
		const result = applyRelease(empty, "0.1.0", "2026-10-10");
		expect(result).toEqual({ bump: null, version: "0.1.0", changelog: empty });
	});

	it("maps a Fixed-only Unreleased to a patch", () => {
		const patchOnly = SAMPLE.replace("### Added\n\n- A new command.\n\n", "");
		const result = applyRelease(patchOnly, "0.1.0", "2026-10-10");
		expect(result.bump).toBe("patch");
		if (!result.bump) throw new Error("expected a bump");
		expect(result.version).toBe("0.1.1");
		expect(result.changelog).toContain("## [0.1.1] - 2026-10-10");
	});

	it("rejects a missing Unreleased heading", () => {
		expect(() => parseChangelog("# Changelog\n\n## [0.1.0] - 2026-10-09\n")).toThrow(/Unreleased/);
	});

	it("rejects a bad date", () => {
		expect(() => applyRelease(SAMPLE, "0.1.0", "10/10/2026")).toThrow(/YYYY-MM-DD/);
	});
});
