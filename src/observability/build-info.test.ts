import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadBuildInfo } from "./build-info.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pixel-build-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const config = { env: "dev", runtime: "local" as const, gitSha: undefined, gitBranch: undefined };

describe("loadBuildInfo", () => {
	it("reads the version from package.json", () => {
		expect(loadBuildInfo(config, { git: () => undefined }).version).toMatch(/^\d+\.\d+\.\d+/);
		const pkg = join(dir, "package.json");
		writeFileSync(pkg, JSON.stringify({ version: "9.8.7" }));
		expect(loadBuildInfo(config, { git: () => undefined, packageJson: pkg }).version).toBe("9.8.7");
	});

	it("says unknown when package.json is missing or has no version", () => {
		expect(
			loadBuildInfo(config, { git: () => undefined, packageJson: join(dir, "nope") }).version,
		).toBe("unknown");
		const pkg = join(dir, "package.json");
		writeFileSync(pkg, "{}");
		expect(loadBuildInfo(config, { git: () => undefined, packageJson: pkg }).version).toBe(
			"unknown",
		);
	});

	it("uses the commit and branch it was given, and doesn't ask git then", () => {
		const git = vi.fn(() => "ignored");
		expect(
			loadBuildInfo({ env: "prod", gitSha: "0123456789abcdef", gitBranch: "main" }, { git }),
		).toMatchObject({ commit: "0123456", branch: "main", env: "prod", runtime: "local" });
		expect(
			loadBuildInfo(
				{ env: "dev", runtime: "cloud", gitSha: "0123456789abcdef", gitBranch: "main" },
				{ git },
			),
		).toMatchObject({ runtime: "cloud", env: "dev" });
		expect(git).not.toHaveBeenCalled();
	});

	it("asks git when they weren't given", () => {
		const git = (args: string[]) =>
			args.includes("--abbrev-ref") ? "feature/doors" : "fedcba9876543210";
		expect(loadBuildInfo(config, { git })).toMatchObject({
			commit: "fedcba9",
			branch: "feature/doors",
		});
	});

	it("leaves out what it can't find, and a detached checkout's branch", () => {
		expect(loadBuildInfo(config, { git: () => undefined })).toMatchObject({
			commit: undefined,
			branch: undefined,
		});
		const detached = (args: string[]) => (args.includes("--abbrev-ref") ? "HEAD" : "abc1234");
		expect(loadBuildInfo(config, { git: detached }).branch).toBeUndefined();
	});

	it("asks the real git without throwing, whatever is installed", () => {
		expect(() => loadBuildInfo(config)).not.toThrow();
	});
});
