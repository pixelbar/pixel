import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mergeChangelogs, parseSections } from "./changelog-merge.ts";

const HEAD = `# Changelog

Intro.

`;
const RELEASED = `## [0.2.0] - 2026-01-02

### Added

- Old thing.

`;
const LINKS = `[Unreleased]: https://example.invalid/compare/v0.2.0...HEAD
[0.2.0]: https://example.invalid/releases/tag/v0.2.0
`;

/** A changelog with these [Unreleased] sections. */
function doc(unreleased: string, released = RELEASED, links = LINKS, head = HEAD): string {
	return `${head}## [Unreleased]\n\n${unreleased ? `${unreleased}\n\n` : ""}${released}${links}`;
}

const merge = (base: string, branch: string, main: string) =>
	mergeChangelogs({ base, branch, main });

function merged(base: string, branch: string, main: string): string {
	const result = merge(base, branch, main);
	if (!result.ok) throw new Error(result.reason);
	return result.text;
}

function refused(base: string, branch: string, main: string): string {
	const result = merge(base, branch, main);
	if (result.ok) throw new Error("expected a refusal");
	return result.reason;
}

describe("mergeChangelogs", () => {
	const base = doc("### Fixed\n\n- Base fix.");

	it("keeps both sides' entries in one section, main's first", () => {
		const branch = doc("### Fixed\n\n- Base fix.\n- Branch fix.");
		const main = doc("### Fixed\n\n- Base fix.\n- Main fix.");
		expect(merged(base, branch, main)).toBe(
			doc("### Fixed\n\n- Base fix.\n- Main fix.\n- Branch fix."),
		);
	});

	it("adds a section in Keep a Changelog order, never a second one", () => {
		const branch = doc("### Added\n\n- New command.\n\n### Fixed\n\n- Base fix.\n- Branch fix.");
		const main = doc("### Fixed\n\n- Base fix.\n- Main fix.\n\n### Security\n\n- Main hardening.");
		const text = merged(base, branch, main);
		expect(text).toBe(
			doc(
				"### Added\n\n- New command.\n\n### Fixed\n\n- Base fix.\n- Main fix.\n- Branch fix.\n\n### Security\n\n- Main hardening.",
			),
		);
		expect(text.match(/^### Fixed$/gm)).toHaveLength(1);
	});

	it("keeps an entry both sides added only once", () => {
		const branch = doc("### Fixed\n\n- Base fix.\n- Same fix.");
		const main = doc("### Fixed\n\n- Base fix.\n- Same fix.");
		expect(merged(base, branch, doc("### Fixed\n\n- Base fix.\n- Same fix.\n- Other."))).toBe(
			doc("### Fixed\n\n- Base fix.\n- Same fix.\n- Other."),
		);
		expect(merged(base, branch, main)).toBe(main);
	});

	it("keeps multi-line entries whole", () => {
		const entry = "- Branch fix that wraps\n  onto a second line.\n\n  And a second paragraph.";
		const branch = doc(`### Fixed\n\n- Base fix.\n${entry}`);
		const main = doc("### Fixed\n\n- Base fix.\n- Main fix.");
		expect(merged(base, branch, main)).toBe(doc(`### Fixed\n\n- Base fix.\n- Main fix.\n${entry}`));
	});

	it("applies the branch rewording an entry main left alone", () => {
		const branch = doc("### Fixed\n\n- Base fix, reworded.");
		const main = doc("### Fixed\n\n- Base fix.\n- Main fix.");
		expect(merged(base, branch, main)).toBe(doc("### Fixed\n\n- Main fix.\n- Base fix, reworded."));
	});

	it("puts the branch's entries in the new [Unreleased] after a release on main", () => {
		const released = `## [0.3.0] - 2026-02-01\n\n### Fixed\n\n- Base fix.\n\n${RELEASED}`;
		const links = `[Unreleased]: https://example.invalid/compare/v0.3.0...HEAD\n[0.3.0]: x\n[0.2.0]: y\n`;
		const main = doc("", released, links);
		const branch = doc("### Fixed\n\n- Base fix.\n\n### Added\n\n- Branch feature.");
		expect(merged(base, branch, main)).toBe(doc("### Added\n\n- Branch feature.", released, links));
	});

	it("takes the only side that changed the head, the released versions or the links", () => {
		const branch = doc(
			"### Fixed\n\n- Base fix.\n- Branch fix.",
			RELEASED,
			LINKS,
			"# Changelog\n\nNew intro.\n\n",
		);
		const main = doc(
			"### Fixed\n\n- Base fix.\n- Main fix.",
			`${RELEASED}## [0.1.0] - 2026-01-01\n\n`,
		);
		expect(merged(base, branch, main)).toBe(
			doc(
				"### Fixed\n\n- Base fix.\n- Main fix.\n- Branch fix.",
				`${RELEASED}## [0.1.0] - 2026-01-01\n\n`,
				LINKS,
				"# Changelog\n\nNew intro.\n\n",
			),
		);
	});

	it("short-cuts when only one side changed", () => {
		const changed = doc("### Fixed\n\n- Base fix.\n- More.");
		expect(merged(base, base, changed)).toBe(changed);
		expect(merged(base, changed, base)).toBe(changed);
		expect(merged(base, changed, changed)).toBe(changed);
	});

	describe("refuses", () => {
		it("when both sides changed the same entry", () => {
			const branch = doc("### Fixed\n\n- Base fix, branch wording.");
			const main = doc("### Fixed\n\n- Base fix, main wording.");
			expect(refused(base, branch, main)).toMatch(
				/changed or removed an \[Unreleased\] Fixed entry/,
			);
		});

		it("when the branch changed an entry main has since released", () => {
			const released = `## [0.3.0] - 2026-02-01\n\n### Fixed\n\n- Base fix.\n\n${RELEASED}`;
			const main = doc("", released);
			const branch = doc("### Fixed\n\n- Base fix, reworded.");
			expect(refused(base, branch, main)).toMatch(/has released/);
		});

		it("when a side has a section twice", () => {
			const branch = doc("### Fixed\n\n- Base fix.\n\n### Fixed\n\n- Branch fix.");
			const main = doc("### Fixed\n\n- Base fix.\n- Main fix.");
			expect(refused(base, branch, main)).toMatch(/### Fixed twice/);
		});

		it("when a heading is not a Keep a Changelog section", () => {
			const branch = doc("### Fixed\n\n- Base fix.\n\n### Misc\n\n- Branch thing.");
			const main = doc("### Fixed\n\n- Base fix.\n- Main fix.");
			expect(refused(base, branch, main)).toMatch(/isn't a Keep a Changelog section/);
		});

		it("when [Unreleased] has text that is not a list entry", () => {
			const branch = doc("Some prose.\n\n### Fixed\n\n- Base fix.");
			const main = doc("### Fixed\n\n- Base fix.\n- Main fix.");
			expect(refused(base, branch, main)).toMatch(/isn't a list entry/);
			expect(refused(base, doc("- Loose entry.\n\n### Fixed\n\n- Base fix."), main)).toMatch(
				/outside a ### section/,
			);
		});

		it("when both sides changed the released versions", () => {
			const branch = doc(
				"### Fixed\n\n- Base fix.\n- B.",
				RELEASED.replace("Old thing", "Branch edit"),
			);
			const main = doc(
				"### Fixed\n\n- Base fix.\n- M.",
				RELEASED.replace("Old thing", "Main edit"),
			);
			expect(refused(base, branch, main)).toBe("Both sides changed the released versions.");
		});

		it("when a side still has conflict markers", () => {
			const branch = doc("### Fixed\n\n<<<<<<< HEAD\n- Base fix.\n=======\n- x\n>>>>>>> main");
			expect(refused(base, branch, doc("### Fixed\n\n- Base fix.\n- M."))).toMatch(
				/conflict markers/,
			);
		});

		it("when a side has no [Unreleased]", () => {
			expect(refused(base, "# Changelog\n\nnothing\n", doc("### Fixed\n\n- M."))).toMatch(
				/must contain a ## \[Unreleased\]/,
			);
		});
	});

	// Shaped like the real CHANGELOG.md (not read from it: changelog-only
	// pushes skip `just check`, so a test must not depend on that file).
	it("keeps the head, released versions and links byte for byte", () => {
		const head =
			"# Changelog\n\nAll notable changes.\n\nThe format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).\n\n";
		const released =
			"## [0.2.0] - 2026-02-02\n\n### Added\n\n- One.\n\n- Two, after a blank line.\n\n## [0.1.0] - 2026-01-01\n\n### Fixed\n\n- `code` and [a link](https://example.invalid).\n\n";
		const links =
			"[Unreleased]: https://example.invalid/compare/v0.2.0...HEAD\n[0.2.0]: https://example.invalid/compare/v0.1.0...v0.2.0\n[0.1.0]: https://example.invalid/releases/tag/v0.1.0\n";
		const real = (unreleased: string) =>
			`${head}## [Unreleased]\n\n${unreleased}${released}${links}`;
		const text = merged(
			real("### Fixed\n\n- Base.\n\n"),
			real("### Fixed\n\n- Base.\n- Branch.\n\n"),
			real("### Fixed\n\n- Base.\n- Main.\n\n"),
		);
		expect(text).toBe(real("### Fixed\n\n- Base.\n- Main.\n- Branch.\n\n"));
	});
});

describe("parseSections", () => {
	it("reads whole entries per section", () => {
		expect(parseSections("### Added\n\n- One\n  more.\n\n- Two.\n\n### Fixed\n\n* Three.")).toEqual(
			new Map([
				["Added", ["- One\n  more.", "- Two."]],
				["Fixed", ["* Three."]],
			]),
		);
	});
});

describe("merge-changelog.ts", () => {
	const SCRIPT = resolve("scripts/merge-changelog.ts");
	let dir: string;
	const git = (...args: string[]) =>
		execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
			cwd: dir,
			encoding: "utf8",
			stdio: "pipe",
		});
	const node = (...args: string[]) =>
		execFileSync("node", [SCRIPT, ...args], { cwd: dir, encoding: "utf8", stdio: "pipe" });
	const write = (text: string) => writeFileSync(join(dir, "CHANGELOG.md"), text);
	const base = doc("### Fixed\n\n- Base fix.");

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pixel-changelog-merge-"));
		git("init", "-q", "-b", "main");
		write(base);
		git("add", "-A");
		git("commit", "-qm", "base");
		git("checkout", "-qb", "branch");
		write(doc("### Fixed\n\n- Base fix.\n- Branch fix."));
		git("commit", "-qam", "branch");
		git("checkout", "-q", "main");
		write(doc("### Fixed\n\n- Base fix.\n- Main fix."));
		git("commit", "-qam", "main");
		git("checkout", "-q", "branch");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const result = () => readFileSync(join(dir, "CHANGELOG.md"), "utf8");
	const expected = doc("### Fixed\n\n- Base fix.\n- Main fix.\n- Branch fix.");

	it("resolves a stopped merge from the index and stages it", () => {
		expect(() => git("merge", "main")).toThrow();
		expect(node("--git")).toContain("kept both sides");
		expect(result()).toBe(expected);
		expect(git("diff", "--name-only", "--diff-filter=U")).toBe("");
	});

	it("knows a rebase swaps the sides", () => {
		expect(() => git("rebase", "main")).toThrow();
		node("--git");
		expect(result()).toBe(expected);
	});

	it("works as a merge driver", () => {
		git("config", "merge.changelog.driver", `node ${SCRIPT} %O %A %B`);
		writeFileSync(join(dir, ".git/info/attributes"), "CHANGELOG.md merge=changelog\n");
		git("merge", "-q", "--no-edit", "main");
		expect(result()).toBe(expected);
	});

	it("leaves conflict markers as a driver when it refuses", () => {
		git("config", "merge.changelog.driver", `node ${SCRIPT} %O %A %B`);
		writeFileSync(join(dir, ".git/info/attributes"), "CHANGELOG.md merge=changelog\n");
		write(doc("### Fixed\n\n- Base fix, branch wording."));
		git("commit", "-qam", "reword");
		git("checkout", "-q", "main");
		write(doc("### Fixed\n\n- Base fix, main wording."));
		git("commit", "-qam", "reword");
		git("checkout", "-q", "branch");
		expect(() => git("merge", "main")).toThrow();
		expect(result()).toMatch(/^<{7} current$/m);
	});

	it("refuses when CHANGELOG.md is not in conflict", () => {
		expect(() => node("--git")).toThrow();
	});
});
