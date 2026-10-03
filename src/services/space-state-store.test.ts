import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileSpaceStateStore, SpaceStateFileError } from "./space-state-store.ts";

let dir: string;
let path: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pixel-state-"));
	path = join(dir, "data", "space.state");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function writeRaw(contents: string) {
	new FileSpaceStateStore(path).save({ state: "open", since: null }); // creates the directory
	writeFileSync(path, contents);
}

describe("FileSpaceStateStore", () => {
	it("has nothing to load before anything is saved", () => {
		expect(new FileSpaceStateStore(path).load()).toBeUndefined();
	});

	it("round-trips a state with a time", () => {
		const store = new FileSpaceStateStore(path);
		const since = new Date("2026-10-03T11:50:00.000Z");
		store.save({ state: "closed", since });
		expect(store.load()).toEqual({ state: "closed", since });
	});

	it("round-trips a state whose start time is unknown", () => {
		const store = new FileSpaceStateStore(path);
		store.save({ state: "open", since: null });
		expect(store.load()).toEqual({ state: "open", since: null });
	});

	it("creates the directory and overwrites earlier saves", () => {
		const store = new FileSpaceStateStore(path);
		store.save({ state: "open", since: null });
		store.save({ state: "closed", since: new Date("2026-10-03T12:00:00.000Z") });
		expect(store.load()?.state).toBe("closed");
	});

	it("leaves no temp file behind", () => {
		new FileSpaceStateStore(path).save({ state: "open", since: null });
		expect(readdirSync(join(dir, "data"))).toEqual(["space.state"]);
	});

	it("is a readable, commented YAML file that survives manual loading", () => {
		new FileSpaceStateStore(path).save({
			state: "open",
			since: new Date("2026-10-03T11:50:00.000Z"),
		});
		expect(readFileSync(path, "utf8")).toBe(
			[
				"# Pixel's record of the last space state it saw. Safe to delete or edit.",
				"state: open",
				"since: 2026-10-03T11:50:00.000Z",
				"",
			].join("\n"),
		);
	});

	describe("rejects unusable files", () => {
		it.each([
			["invalid YAML", "state: [", /not valid YAML/],
			["an empty file", "", /unexpected shape/],
			["a non-object", "- open\n", /unexpected shape/],
			["an unknown state", "state: ajar\nsince: null\n", /unexpected shape/],
			["a missing since", "state: open\n", /unexpected shape/],
			["a malformed time", "state: open\nsince: yesterday\n", /unexpected shape/],
			["a time without a zone", "state: open\nsince: 2026-10-03T11:50:00\n", /unexpected shape/],
			["unknown keys", "state: open\nsince: null\nextra: 1\n", /unexpected shape/],
			["a numeric time", "state: open\nsince: 12345\n", /unexpected shape/],
		])("%s", (_label, contents, message) => {
			writeRaw(contents);
			const attempt = () => new FileSpaceStateStore(path).load();
			expect(attempt).toThrow(SpaceStateFileError);
			expect(attempt).toThrow(message);
		});
	});

	it("reports an unreadable path without leaking its contents", () => {
		writeRaw("state: open\nsince: null\n");
		chmodSync(path, 0o000);
		try {
			// Running as root ignores file modes, so only assert when the read actually fails.
			let error: unknown;
			try {
				new FileSpaceStateStore(path).load();
			} catch (e) {
				error = e;
			}
			if (error) expect(String(error)).toMatch(/cannot read .*space\.state \(EACCES\)/);
		} finally {
			chmodSync(path, 0o600);
		}
	});

	it("reports a directory in the file's place as unreadable", () => {
		writeRaw("state: open\nsince: null\n");
		const asDirectory = new FileSpaceStateStore(join(dir, "data"));
		expect(() => asDirectory.load()).toThrow(/cannot read .* \(EISDIR\)/);
	});
});
