import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const FILTERS = ".github/path-filters.yml";

const read = (file: string) => readFileSync(file, "utf8");

function filters(): Record<string, string[]> {
	return parse(read(FILTERS)) as Record<string, string[]>;
}

/** Picomatch-style glob used by dorny/paths-filter: `*` stays in one directory, `**` crosses. */
function globToRegExp(glob: string): RegExp {
	let i = 0;
	let out = "^";
	while (i < glob.length) {
		if (glob.startsWith("**/", i)) {
			out += "(?:.*/)?";
			i += 3;
			continue;
		}
		if (glob.startsWith("**", i)) {
			out += ".*";
			i += 2;
			continue;
		}
		const c = glob[i] ?? "";
		if (c === "*") {
			out += "[^/]*";
		} else if (c === "?") {
			out += "[^/]";
		} else if (/[.+^$()|[\]\\{ }]/.test(c)) {
			out += `\\${c}`;
		} else {
			out += c;
		}
		i += 1;
	}
	return new RegExp(`${out}$`);
}

/** dorny `some-with-excludes`: match at least one positive pattern and no negated pattern. */
function matchesFilter(patterns: string[], file: string): boolean {
	const positives = patterns.filter((pattern) => !pattern.startsWith("!"));
	const negatives = patterns
		.filter((pattern) => pattern.startsWith("!"))
		.map((pattern) => pattern.slice(1));
	return (
		positives.some((pattern) => globToRegExp(pattern).test(file)) &&
		!negatives.some((pattern) => globToRegExp(pattern).test(file))
	);
}

const tracked = () =>
	execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);

describe("globToRegExp", () => {
	it("keeps * inside one directory and lets ** cross", () => {
		const rootJson = globToRegExp("*.json");
		expect(rootJson.test("package.json")).toBe(true);
		expect(rootJson.test("config/x.json")).toBe(false);
		const src = globToRegExp("src/**");
		expect(src.test("src/index.ts")).toBe(true);
		expect(src.test("src/core/access.ts")).toBe(true);
		expect(src.test("scripts/foo.ts")).toBe(false);
		const tests = globToRegExp("src/**/*.test.ts");
		expect(tests.test("src/core/access.test.ts")).toBe(true);
		expect(tests.test("src/access.test.ts")).toBe(true);
		expect(tests.test("src/core/access.ts")).toBe(false);
	});
});

describe(FILTERS, () => {
	it("is plain lists of glob patterns", () => {
		for (const [name, patterns] of Object.entries(filters())) {
			expect(name).toMatch(/^[A-Za-z0-9_-]+$/);
			expect(Array.isArray(patterns), name).toBe(true);
			expect(patterns.length, name).toBeGreaterThan(0);
			for (const pattern of patterns) {
				expect(typeof pattern, `${name}: ${pattern}`).toBe("string");
			}
		}
	});

	it("names the lists the workflows filter on", () => {
		const known = new Set(Object.keys(filters()));
		for (const name of ["check", "image", "docs", "terraform", "stack"]) {
			expect(known.has(name), name).toBe(true);
		}
		const used = [
			...read(".github/workflows/ci.yml").matchAll(/needs\.changes\.outputs\.(\w+)/g),
			...read(".github/workflows/cd.yml").matchAll(/needs\.changes\.outputs\.(\w+)/g),
			...read(".github/workflows/terraform.yml").matchAll(/needs\.changes\.outputs\.(\w+)/g),
		];
		expect(used.length).toBeGreaterThan(0);
		for (const [, name] of used) {
			expect(known.has(name ?? ""), name).toBe(true);
		}
	});

	it("fail-closes just check for src, lockfile, workflows, Dockerfile, justfile, config and content/info", () => {
		const check = filters().check ?? [];
		for (const file of [
			"src/index.ts",
			"pnpm-lock.yaml",
			".github/workflows/ci.yml",
			".github/workflows/cd.yml",
			"Dockerfile",
			"justfile",
			"config/admins.example.yaml",
			"content/info/visiting.md",
			".github/path-filters.yml",
		]) {
			expect(matchesFilter(check, file), file).toBe(true);
		}
	});

	it("does not run just check or Docker for skippable markdown", () => {
		const check = filters().check ?? [];
		const image = filters().image ?? [];
		for (const file of [
			"CHANGELOG.md",
			"README.md",
			"AGENTS.md",
			"docs/adr/0001-ports-and-adapters.md",
		]) {
			expect(matchesFilter(check, file), `check ${file}`).toBe(false);
			expect(matchesFilter(image, file), `image ${file}`).toBe(false);
		}
	});

	it("runs just check on tests but does not rebuild the image", () => {
		const check = filters().check ?? [];
		const image = filters().image ?? [];
		expect(matchesFilter(check, "tests/core/access.test.ts")).toBe(true);
		expect(matchesFilter(image, "tests/core/access.test.ts")).toBe(false);
		expect(matchesFilter(check, "src/testing/fixtures.ts")).toBe(true);
		expect(matchesFilter(image, "src/testing/fixtures.ts")).toBe(false);
		expect(matchesFilter(image, "src/index.ts")).toBe(true);
		expect(matchesFilter(image, "content/info/visiting.md")).toBe(true);
	});

	it("skips Azure plans for infra markdown but not for Terraform files", () => {
		const stack = filters().stack ?? [];
		const terraform = filters().terraform ?? [];
		expect(matchesFilter(stack, "infra/README.md")).toBe(false);
		expect(matchesFilter(terraform, "infra/README.md")).toBe(false);
		expect(matchesFilter(stack, "infra/modules/pixel/main.tf")).toBe(true);
		expect(matchesFilter(terraform, "infra/modules/pixel/main.tf")).toBe(true);
		expect(matchesFilter(terraform, "justfile")).toBe(true);
		expect(matchesFilter(stack, "justfile")).toBe(false);
	});

	/**
	 * Copied into the image but deliberately not in `image`. Only a release's dated
	 * CHANGELOG section is posted, and the Release workflow builds its image from the
	 * bump commit whatever the filters say, so an [Unreleased] edit never changes what
	 * a running Pixel posts. Keeping it out lets markdown-only PRs skip Docker.
	 */
	const COPIED_NOT_FILTERED = new Set(["CHANGELOG.md"]);

	it("puts everything the Dockerfile copies from the repository in `image`", () => {
		const image = filters().image ?? [];
		const copies = read("Dockerfile")
			.split("\n")
			.filter((line) => /^COPY\s/.test(line) && !line.includes("--from="))
			.flatMap((line) => line.trim().split(/\s+/).slice(1, -1));
		expect(copies.length).toBeGreaterThan(0);
		const files = tracked();
		for (const source of copies) {
			if (COPIED_NOT_FILTERED.has(source)) continue;
			const shipped = files.some(
				(file) => (file === source || file.startsWith(`${source}/`)) && matchesFilter(image, file),
			);
			expect(shipped, `${source} is copied into the image but not in the image list`).toBe(true);
		}
	});

	it("ships CHANGELOG.md in the image, so release notes can be posted", () => {
		const copies = read("Dockerfile")
			.split("\n")
			.filter((line) => /^COPY\s/.test(line) && !line.includes("--from="))
			.flatMap((line) => line.trim().split(/\s+/).slice(1, -1));
		expect(copies).toContain("CHANGELOG.md");
		// .dockerignore keeps markdown out of the build context; the last matching rule wins.
		const rules = read(".dockerignore")
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line !== "" && !line.startsWith("#"));
		const last = rules
			.filter((rule) => {
				const pattern = rule.startsWith("!") ? rule.slice(1) : rule;
				return globToRegExp(pattern).test("CHANGELOG.md");
			})
			.at(-1);
		expect(last).toBe("!CHANGELOG.md");
	});

	it.each([
		["docs", "docs"],
		["terraform", "terraform"],
	] as const)("%s.yml starts for every positive pattern of `%s`", (workflow, filter) => {
		const file = `.github/workflows/${workflow}.yml`;
		const on = (parse(read(file)) as { on: Record<string, { paths?: string[] } | null> }).on;
		const wanted = (filters()[filter] ?? []).filter((pattern) => !pattern.startsWith("!"));
		for (const event of Object.values(on)) {
			if (!event?.paths) continue;
			expect([...event.paths].sort()).toEqual([...new Set(wanted)].sort());
		}
	});
});
