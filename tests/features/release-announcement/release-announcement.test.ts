import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Announcement, BuildInfo } from "../../../src/core/announcement.ts";
import type { AnnounceOptions, AnnounceResult } from "../../../src/core/announcer.ts";
import { silentLogger } from "../../../src/core/logger.ts";
import {
	createReleaseAnnouncementFeature,
	isReleasePublisher,
} from "../../../src/features/release-announcement/index.ts";

const CHANGELOG = `# Changelog

## [Unreleased]

## [0.28.0] - 2026-11-16

### Added

- New feature A
- New feature B

### Changed

- Changed behavior C

## [0.27.1] - 2026-11-15

### Fixed

- Fixed bug X
`;

const build: BuildInfo = {
	version: "0.28.0",
	commit: "abc1234",
	branch: "main",
	env: "prod",
	runtime: "cloud",
};

const now = new Date("2026-11-16T12:00:00Z");

describe("isReleasePublisher", () => {
	it("matches the fixed and per-channel release publisher ids", () => {
		expect(isReleasePublisher("discord:release")).toBe(true);
		expect(isReleasePublisher("discord:release:111111111111111111")).toBe(true);
		expect(isReleasePublisher("discord:bot-status")).toBe(false);
		expect(isReleasePublisher("discord:live:111111111111111111")).toBe(false);
	});
});

describe("release announcement", () => {
	let tempDir: string;
	let changelogFile: string;
	let stateFile: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pixel-release-test-"));
		changelogFile = join(tempDir, "CHANGELOG.md");
		stateFile = join(tempDir, "release-announced.yaml");
		writeFileSync(changelogFile, CHANGELOG);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function setup(
		overrides: Partial<BuildInfo> = {},
		announcerOverrides: {
			announce?: (a: Announcement, options?: AnnounceOptions) => Promise<AnnounceResult>;
			publisherIds?: string[];
		} = {},
	) {
		const announced: Announcement[] = [];
		const announce = vi.fn(
			announcerOverrides.announce ??
				(async (a: Announcement, options?: AnnounceOptions) => {
					announced.push(a);
					const ok = options?.only ? [...options.only] : ["discord:release"];
					return { failed: 0, ok };
				}),
		);
		const feature = createReleaseAnnouncementFeature({
			announcer: {
				announce,
				publisherIds: announcerOverrides.publisherIds ?? ["discord:release"],
			},
			build: { ...build, ...overrides },
			logger: silentLogger,
			changelogFile,
			stateFile,
			now: () => now,
		});
		return { feature, announced, announce };
	}

	it("announces a new version with its changelog entries", async () => {
		const { feature, announced, announce } = setup();
		const stop = feature.start?.();
		await vi.waitFor(() => expect(announced).toHaveLength(1), { timeout: 1000 });
		stop?.();

		expect(announce).toHaveBeenCalledWith(expect.objectContaining({ kind: "release" }), {
			only: ["discord:release"],
		});
		expect(announced).toEqual([
			{
				kind: "release",
				version: "0.28.0",
				build,
				notes:
					"### Added\n\n- New feature A\n- New feature B\n\n### Changed\n\n- Changed behavior C",
				at: now,
				text: "📣 Pixel 0.28.0 is now live",
			},
		]);
	});

	it("records the announced version and publisher so it isn't posted again", async () => {
		const { feature } = setup();
		const stop = feature.start?.();
		await vi.waitFor(() => readFileSync(stateFile, "utf8").includes("0.28.0"), { timeout: 1000 });
		stop?.();

		const content = readFileSync(stateFile, "utf8");
		expect(content).toContain("version: 0.28.0");
		expect(content).toContain("at: 2026-11-16T12:00:00.000Z");
		expect(content).toContain("discord:release");
	});

	it("doesn't announce the same version twice (legacy whole-version mark)", async () => {
		writeFileSync(stateFile, "version: 0.28.0\nat: 2026-11-16T11:00:00.000Z\n");
		const { feature, announced } = setup();
		const stop = feature.start?.();
		await new Promise((resolve) => setTimeout(resolve, 100));
		stop?.();

		expect(announced).toEqual([]);
	});

	it("doesn't announce again when every current release publisher is recorded", async () => {
		writeFileSync(
			stateFile,
			"version: 0.28.0\nat: 2026-11-16T11:00:00.000Z\npublishers:\n  - discord:release:111\n  - discord:release:222\n",
		);
		const { feature, announced } = setup(
			{},
			{ publisherIds: ["discord:release:111", "discord:release:222"] },
		);
		const stop = feature.start?.();
		await new Promise((resolve) => setTimeout(resolve, 100));
		stop?.();

		expect(announced).toEqual([]);
	});

	it("only retries channels that haven't received this version yet", async () => {
		writeFileSync(
			stateFile,
			"version: 0.28.0\nat: 2026-11-16T11:00:00.000Z\npublishers:\n  - discord:release:111\n",
		);
		const { feature, announce } = setup(
			{},
			{ publisherIds: ["discord:release:111", "discord:release:222"] },
		);
		const stop = feature.start?.();
		await vi.waitFor(() => expect(announce).toHaveBeenCalledOnce(), { timeout: 1000 });
		stop?.();

		expect(announce).toHaveBeenCalledWith(expect.objectContaining({ kind: "release" }), {
			only: ["discord:release:222"],
		});
		const content = readFileSync(stateFile, "utf8");
		expect(content).toContain("discord:release:111");
		expect(content).toContain("discord:release:222");
	});

	it("remembers successful channels when another fails", async () => {
		const { feature, announce } = setup(
			{},
			{
				publisherIds: ["discord:release:111", "discord:release:222"],
				announce: async (_a, options) => ({
					failed: 1,
					ok: (options?.only ?? []).filter((id) => id === "discord:release:111"),
				}),
			},
		);
		const stop = feature.start?.();
		await vi.waitFor(() => expect(announce).toHaveBeenCalledOnce(), { timeout: 1000 });
		stop?.();

		const content = readFileSync(stateFile, "utf8");
		expect(content).toContain("discord:release:111");
		expect(content).not.toContain("discord:release:222");
	});

	it("skips when no release publisher is registered", async () => {
		const { feature, announced, announce } = setup({}, { publisherIds: ["discord:bot-status"] });
		const stop = feature.start?.();
		await new Promise((resolve) => setTimeout(resolve, 100));
		stop?.();

		expect(announce).not.toHaveBeenCalled();
		expect(announced).toEqual([]);
		expect(() => readFileSync(stateFile, "utf8")).toThrow();
	});

	it("doesn't remember the version when every publisher failed", async () => {
		const { feature, announce } = setup(
			{},
			{
				announce: async () => ({ failed: 1, ok: [] }),
			},
		);
		const stop = feature.start?.();
		await vi.waitFor(() => expect(announce).toHaveBeenCalledOnce(), { timeout: 1000 });
		stop?.();

		expect(() => readFileSync(stateFile, "utf8")).toThrow();
	});

	it("skips dev versions", async () => {
		const { feature, announced } = setup({ version: "dev" });
		const stop = feature.start?.();
		await new Promise((resolve) => setTimeout(resolve, 100));
		stop?.();

		expect(announced).toEqual([]);
	});

	it("doesn't announce when the version has no changelog entry", async () => {
		const { feature, announced } = setup({ version: "0.99.0" });
		const stop = feature.start?.();
		await new Promise((resolve) => setTimeout(resolve, 100));
		stop?.();

		expect(announced).toEqual([]);
	});

	it("handles missing changelog file gracefully", async () => {
		rmSync(changelogFile, { force: true });
		const { feature, announced } = setup();
		const stop = feature.start?.();
		await new Promise((resolve) => setTimeout(resolve, 100));
		stop?.();

		expect(announced).toEqual([]);
	});

	it("handles unreadable state file gracefully", async () => {
		writeFileSync(stateFile, "invalid yaml: [unclosed");
		const { feature, announced } = setup();
		const stop = feature.start?.();
		await vi.waitFor(() => expect(announced).toHaveLength(1), { timeout: 1000 });
		stop?.();

		expect(announced[0]?.kind).toBe("release");
	});

	it("works in dev and local environments", async () => {
		const { feature, announced } = setup({ env: "dev", version: "0.28.0" });
		const stop = feature.start?.();
		await vi.waitFor(() => expect(announced).toHaveLength(1), { timeout: 1000 });
		stop?.();

		expect(announced[0]?.kind).toBe("release");
	});
});
