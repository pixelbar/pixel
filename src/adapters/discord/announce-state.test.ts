import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileLivePostStore, LivePostStateError } from "./announce-state.ts";

// Snowflakes are bigger than JavaScript's safe integers: they must stay strings.
const CHANNEL = "1555937478266064977";
const MESSAGE = "1556000000000000001";

let dir: string;
let path: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pixel-live-"));
	path = join(dir, "data", "announcements.state");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function writeRaw(contents: string) {
	new FileLivePostStore(path, CHANNEL).save(MESSAGE); // creates the directory
	writeFileSync(path, contents);
}

describe("FileLivePostStore", () => {
	it("has nothing before anything is saved", () => {
		expect(new FileLivePostStore(path, CHANNEL).load()).toBeUndefined();
	});

	it("round-trips a message ID exactly", () => {
		const store = new FileLivePostStore(path, CHANNEL);
		store.save(MESSAGE);
		expect(store.load()).toBe(MESSAGE);
	});

	it("writes the IDs quoted, so they can't be misread as numbers", () => {
		new FileLivePostStore(path, CHANNEL).save(MESSAGE);
		expect(readFileSync(path, "utf8")).toBe(
			[
				"# Pixel's record of its live Discord status post. Safe to delete or edit.",
				`channelId: "${CHANNEL}"`,
				`messageId: "${MESSAGE}"`,
				"",
			].join("\n"),
		);
	});

	it("creates the directory, overwrites earlier saves and leaves no temp file", () => {
		const store = new FileLivePostStore(path, CHANNEL);
		store.save(MESSAGE);
		store.save("1556000000000000002");
		expect(store.load()).toBe("1556000000000000002");
		expect(readdirSync(join(dir, "data"))).toEqual(["announcements.state"]);
	});

	it("forgets by removing the file, and forgetting nothing is fine", () => {
		const store = new FileLivePostStore(path, CHANNEL);
		store.save(MESSAGE);
		store.save(undefined);
		expect(store.load()).toBeUndefined();
		expect(readdirSync(join(dir, "data"))).toEqual([]);
		expect(() => store.save(undefined)).not.toThrow();
	});

	it("ignores a post remembered for a different channel", () => {
		new FileLivePostStore(path, "1555937478266064999").save(MESSAGE);
		expect(new FileLivePostStore(path, CHANNEL).load()).toBeUndefined();
	});

	describe("rejects unusable files", () => {
		it.each([
			["invalid YAML", "channelId: [", /not valid YAML/],
			["an empty file", "", /unexpected shape/],
			["a missing message ID", `channelId: "${CHANNEL}"\n`, /unexpected shape/],
			[
				"an unquoted number",
				`channelId: "${CHANNEL}"\nmessageId: ${MESSAGE}\n`,
				/unexpected shape/,
			],
			["a malformed ID", `channelId: "${CHANNEL}"\nmessageId: "abc"\n`, /unexpected shape/],
			[
				"unknown keys",
				`channelId: "${CHANNEL}"\nmessageId: "${MESSAGE}"\nextra: 1\n`,
				/unexpected shape/,
			],
		])("%s", (_label, contents, message) => {
			writeRaw(contents);
			const attempt = () => new FileLivePostStore(path, CHANNEL).load();
			expect(attempt).toThrow(LivePostStateError);
			expect(attempt).toThrow(message);
		});
	});

	it("reports a directory in the file's place as unreadable", () => {
		writeRaw(`channelId: "${CHANNEL}"\nmessageId: "${MESSAGE}"\n`);
		expect(() => new FileLivePostStore(join(dir, "data"), CHANNEL).load()).toThrow(
			/cannot read .* \(EISDIR\)/,
		);
	});
});
