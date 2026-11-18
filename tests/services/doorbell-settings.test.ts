import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { silentLogger } from "../../src/core/logger.ts";
import { DoorbellSettings } from "../../src/services/doorbell-settings.ts";

const CHANNEL = "100000000000000050";

describe("DoorbellSettings", () => {
	let dir: string;
	let file: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pixel-doorbell-"));
		file = join(dir, "data", "doorbell.yaml");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("starts with no channel", () => {
		const settings = new DoorbellSettings({ file, logger: silentLogger });
		expect(settings.channelId).toBeUndefined();
		expect(settings.problem).toBeUndefined();
	});

	it("saves the channel and who set it, and reads it back after a restart", () => {
		const settings = new DoorbellSettings({ file, logger: silentLogger });
		expect(settings.set(CHANNEL, "discord:1")).toEqual({ changed: true, saved: true });
		expect(settings.set(CHANNEL, "discord:1")).toEqual({ changed: false, saved: true });
		expect(readFileSync(file, "utf8")).toMatch(/^# Where Pixel posts the doorbell/);
		expect(readFileSync(file, "utf8")).toContain("changedBy: discord:1");
		expect(new DoorbellSettings({ file, logger: silentLogger }).channelId).toBe(CHANNEL);
	});

	it("clears the channel", () => {
		const settings = new DoorbellSettings({ file, logger: silentLogger });
		settings.set(CHANNEL, "discord:1");
		expect(settings.set(undefined, "discord:1")).toEqual({ changed: true, saved: true });
		expect(new DoorbellSettings({ file, logger: silentLogger }).channelId).toBeUndefined();
	});

	it.each([
		["not YAML", "channelId: [unclosed"],
		["invalid", "channelId: general\n"],
		["something else", "extra: true\n"],
	])("posts nothing when the file is %s, until an admin sets a channel", (_label, body) => {
		const settings = (() => {
			writeFileSync(join(dir, "doorbell.yaml"), body);
			return new DoorbellSettings({ file: join(dir, "doorbell.yaml"), logger: silentLogger });
		})();
		expect(settings.channelId).toBeUndefined();
		expect(settings.problem).toMatch(/doorbell isn't posted/);
		settings.set(CHANNEL, "discord:1");
		expect(settings.problem).toBeUndefined();
	});

	it("reads an empty file as no channel", () => {
		writeFileSync(join(dir, "doorbell.yaml"), "");
		const settings = new DoorbellSettings({
			file: join(dir, "doorbell.yaml"),
			logger: silentLogger,
		});
		expect(settings.channelId).toBeUndefined();
		expect(settings.problem).toBeUndefined();
	});

	it("says when it can't read or save the file", () => {
		// A directory where the file should be: reading and writing both fail.
		const settings = new DoorbellSettings({ file: dir, logger: silentLogger });
		expect(settings.problem).toMatch(/unreadable/);
		expect(settings.set(CHANNEL, "discord:1")).toEqual({ changed: true, saved: false });
		expect(settings.channelId).toBe(CHANNEL);
	});

	it("keeps the channel in memory without a file", () => {
		const settings = new DoorbellSettings({ logger: silentLogger });
		expect(settings.set(CHANNEL, "discord:1")).toEqual({ changed: true, saved: true });
		expect(settings.channelId).toBe(CHANNEL);
	});

	it.skipIf(process.getuid?.() === 0)("ignores a file it isn't allowed to read", () => {
		const path = join(dir, "doorbell.yaml");
		writeFileSync(path, `channelId: "${CHANNEL}"\n`);
		chmodSync(path, 0o000);
		const settings = new DoorbellSettings({ file: path, logger: silentLogger });
		expect(settings.channelId).toBeUndefined();
		expect(settings.problem).toMatch(/unreadable/);
	});
});
