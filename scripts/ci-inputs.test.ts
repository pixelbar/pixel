import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

const SCRIPT = resolve("scripts/ci-inputs.sh");
const FILTERS = ".github/path-filters.yml";
/** What every input hash covers on top of its list (see scripts/ci-inputs.sh). */
const ALWAYS = [FILTERS, ".github/actions/**", "scripts/ci-inputs.sh"];

const read = (file: string) => readFileSync(file, "utf8");

function run(cwd: string, ...args: string[]): string {
	return execFileSync("bash", [SCRIPT, ...args], { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

const list = (cwd: string, filter: string) => run(cwd, "--list", filter).split("\n");

/** The lists in the real filter file. */
function filters(): Record<string, string[]> {
	return parse(read(FILTERS)) as Record<string, string[]>;
}

describe("ci-inputs.sh", () => {
	let dir: string;

	const write = (file: string, text: string) => {
		mkdirSync(dirname(join(dir, file)), { recursive: true });
		writeFileSync(join(dir, file), text);
	};
	const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
	const commit = () => {
		git("add", "-A");
		git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "x");
	};

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pixel-ci-inputs-"));
		git("init", "-q");
		write(
			FILTERS,
			[
				"# a comment",
				"app:",
				'  - "src/**"',
				'  - "!src/**/*.test.ts" # tests do not ship',
				"  # an indented comment",
				'  - "*.json"',
				"site:",
				'  - "docs/**"',
				"",
			].join("\n"),
		);
		write("src/a.ts", "a");
		write("src/deep/b.ts", "b");
		write("src/deep/b.test.ts", "test");
		write("package.json", "{}");
		write("config/x.json", "{}");
		write("docs/index.md", "docs");
		write("CHANGELOG.md", "changes");
		commit();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("lists a filter's files, its exclusions applied, plus the filter file", () => {
		expect(list(dir, "app").sort()).toEqual(
			[FILTERS, "package.json", "src/a.ts", "src/deep/b.ts"].sort(),
		);
		expect(list(dir, "site").sort()).toEqual([FILTERS, "docs/index.md"].sort());
	});

	it("keeps the hash when only files outside the filter change", () => {
		const before = run(dir, "app");
		write("CHANGELOG.md", "more changes");
		write("src/deep/b.test.ts", "another test");
		write("config/x.json", '{"a":1}');
		commit();
		expect(run(dir, "app")).toBe(before);
	});

	it("changes the hash when a matched file changes or moves", () => {
		const before = run(dir, "app");
		write("src/a.ts", "a2");
		commit();
		const edited = run(dir, "app");
		expect(edited).not.toBe(before);
		git("mv", "src/a.ts", "src/c.ts");
		commit();
		expect(run(dir, "app")).not.toBe(edited);
	});

	it("gives different filters with the same files different hashes", () => {
		write(FILTERS, `${read(join(dir, FILTERS))}same:\n  - "docs/**"\n`);
		commit();
		expect(run(dir, "same")).not.toBe(run(dir, "site"));
	});

	it("adds extra files, such as the workflow running the job", () => {
		write(".github/workflows/ci.yml", "on: push");
		commit();
		expect(run(dir, "--list", "site", ".github/workflows/ci.yml")).toContain(
			".github/workflows/ci.yml",
		);
		expect(run(dir, "site", ".github/workflows/ci.yml")).not.toBe(run(dir, "site"));
	});

	it("fails on a filter that does not exist", () => {
		expect(() => run(dir, "nope")).toThrow();
	});
});

describe(FILTERS, () => {
	it("is plain lists, so scripts/ci-inputs.sh can read it", () => {
		for (const [name, patterns] of Object.entries(filters())) {
			expect(name).toMatch(/^[A-Za-z0-9_-]+$/);
			expect(Array.isArray(patterns), name).toBe(true);
			expect(run(".", "--list", name).split("\n").length).toBeGreaterThan(1);
		}
	});

	it("puts everything the Dockerfile copies in from the repository in `image`", () => {
		const image = new Set(list(".", "image"));
		const copies = read("Dockerfile")
			.split("\n")
			.filter((line) => /^COPY\s/.test(line) && !line.includes("--from="))
			.flatMap((line) => line.trim().split(/\s+/).slice(1, -1));
		expect(copies.length).toBeGreaterThan(0);
		for (const source of copies) {
			const shipped = [...image].some((file) => file === source || file.startsWith(`${source}/`));
			expect(shipped, `${source} is copied into the image but not in the image list`).toBe(true);
		}
	});

	it("names only lists that exist in the workflows", () => {
		const known = new Set(Object.keys(filters()));
		for (const workflow of ["ci", "cd", "docs", "terraform"]) {
			const used = [...read(`.github/workflows/${workflow}.yml`).matchAll(/filter: (\S+)/g)];
			expect(used.length, workflow).toBeGreaterThan(0);
			for (const [, name] of used) expect(known.has(name ?? ""), `${workflow}: ${name}`).toBe(true);
		}
	});

	// A paths trigger that missed one of the list's files would never start the
	// workflow for a change to it.
	it.each([
		["docs", "docs"],
		["terraform", "terraform"],
	])("%s.yml starts for every file its `%s` list covers", (workflow, filter) => {
		const file = `.github/workflows/${workflow}.yml`;
		const on = (parse(read(file)) as { on: Record<string, { paths?: string[] } | null> }).on;
		const wanted = [
			...(filters()[filter] ?? []).filter((pattern) => !pattern.startsWith("!")),
			...ALWAYS,
			file,
		];
		for (const event of Object.values(on)) {
			if (!event?.paths) continue;
			expect([...event.paths].sort()).toEqual([...new Set(wanted)].sort());
		}
	});
});
