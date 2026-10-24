import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { silentLogger } from "../core/logger.ts";
import {
	DEFAULT_SETTINGS,
	MAX_SPOTS,
	normaliseDurations,
	ParkingError,
	ParkingSpotStore,
	resetClock,
} from "./parking-spots.ts";

let dir: string;
let file: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pixel-parking-spots-"));
	file = join(dir, "data", "parking-spots.yaml");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const open = () => new ParkingSpotStore({ file, logger: silentLogger });

function writeFile(text: string): void {
	mkdirSync(join(dir, "data"), { recursive: true });
	writeFileSync(file, text);
}

describe("ParkingSpotStore", () => {
	it("starts with no spots and the default settings", () => {
		const store = open();
		expect(store.problem).toBeUndefined();
		expect(store.all()).toEqual([]);
		expect(store.settings()).toEqual(DEFAULT_SETTINGS);
	});

	it("keeps spots in memory without a file", () => {
		const store = new ParkingSpotStore({ logger: silentLogger });
		store.add({ name: "ours", permanent: true });
		expect(store.get("ours")).toEqual({ name: "ours", permanent: true });
	});

	it("saves spots and settings, and reads them back after a restart", () => {
		const store = open();
		store.add({ name: "ours", permanent: true, description: "Next to the gate" });
		store.add({ name: "neighbour-1", permanent: false });
		store.setSettings({ remindMinutes: 10 });

		const text = readFileSync(file, "utf8");
		expect(text.startsWith("# Pixel's parking spots and settings.")).toBe(true);
		expect(parse(text).spots).toEqual([
			{ name: "ours", permanent: true, description: "Next to the gate" },
			{ name: "neighbour-1", permanent: false },
		]);

		const again = open();
		expect(again.all().map((s) => s.name)).toEqual(["ours", "neighbour-1"]);
		expect(again.settings().remindMinutes).toBe(10);
		expect(again.settings().graceMinutes).toBe(DEFAULT_SETTINGS.graceMinutes);
	});

	describe("add", () => {
		it("refuses a bad name, a repeat, too many spots, and a bad description", () => {
			const store = open();
			expect(() => store.add({ name: "Spot 1", permanent: false })).toThrow(ParkingError);
			expect(() => store.add({ name: "1-spot", permanent: false })).toThrow(/lowercase/);
			store.add({ name: "a", permanent: false });
			expect(() => store.add({ name: "a", permanent: true })).toThrow(/already a spot/);
			expect(() => store.add({ name: "b", permanent: false, description: " " })).toThrow(/1–100/);
			expect(() =>
				store.add({ name: "b", permanent: false, description: "x".repeat(101) }),
			).toThrow(/1–100/);
			for (let i = 1; i < MAX_SPOTS; i++) store.add({ name: `s${i}`, permanent: false });
			expect(() => store.add({ name: "one-more", permanent: false })).toThrow(/already 25/);
		});
	});

	describe("update", () => {
		it("changes and removes the description, and the kind", () => {
			const store = open();
			store.add({ name: "a", permanent: false, description: "Old" });
			expect(store.update("a", { description: "New" })?.after).toEqual({
				name: "a",
				permanent: false,
				description: "New",
			});
			expect(store.update("a", { permanent: true })?.after).toEqual({
				name: "a",
				permanent: true,
				description: "New",
			});
			const removed = store.update("a", { description: null });
			expect(removed?.before.description).toBe("New");
			expect(removed?.after).toEqual({ name: "a", permanent: true });
			expect(open().get("a")).toEqual({ name: "a", permanent: true });
		});

		it("is undefined for a spot that doesn't exist, and checks the description", () => {
			const store = open();
			expect(store.update("nope", { permanent: true })).toBeUndefined();
			store.add({ name: "a", permanent: false });
			expect(() => store.update("a", { description: "" })).toThrow(/1–100/);
		});
	});

	it("removes a spot", () => {
		const store = open();
		store.add({ name: "a", permanent: false });
		expect(store.remove("a")?.name).toBe("a");
		expect(store.remove("a")).toBeUndefined();
		expect(open().all()).toEqual([]);
	});

	describe("setSettings", () => {
		it("writes durations the usual way, without repeats", () => {
			const store = open();
			const next = store.setSettings({ durations: ["90 min", "1h30", "Rest of the day"] });
			expect(next.durations).toEqual(["1h30", "rest of day"]);
		});

		it("refuses values out of range", () => {
			const store = open();
			expect(() => store.setSettings({ remindMinutes: 121 })).toThrow(ParkingError);
			expect(() => store.setSettings({ graceMinutes: -1 })).toThrow(ParkingError);
			expect(() => store.setSettings({ resetAt: "24:00" })).toThrow(ParkingError);
			expect(() => store.setSettings({ durations: [] })).toThrow(ParkingError);
			expect(() => store.setSettings({ durations: ["soon"] })).toThrow(ParkingError);
			expect(store.settings()).toEqual(DEFAULT_SETTINGS);
		});
	});

	describe("a file that can't be used", () => {
		it.each([
			["not YAML", "spots: [", /not valid YAML/],
			["the wrong shape", "spots:\n  - name: Spot 1\n", /spots\.0\.name/],
			["an unknown key", "spot: []\n", /invalid/],
			["a bad setting", "settings:\n  resetAt: midnight\n", /settings\.resetAt/],
			["a repeated name", "spots:\n  - name: a\n  - name: a\n", /repeats a spot name/],
		])("%s switches parking off and is never overwritten", (_, text, problem) => {
			writeFile(text);
			const store = open();
			expect(store.problem).toMatch(problem);
			expect(store.all()).toEqual([]);
			expect(() => store.add({ name: "b", permanent: false })).toThrow(/invalid/);
			expect(() => store.update("a", { permanent: true })).toThrow(/invalid/);
			expect(() => store.remove("a")).toThrow(/invalid/);
			expect(() => store.setSettings({ remindMinutes: 1 })).toThrow(/invalid/);
			expect(readFileSync(file, "utf8")).toBe(text);
		});

		it("says so when it can't be read", () => {
			mkdirSync(file, { recursive: true });
			expect(open().problem).toMatch(/cannot read .* \(EISDIR\)/);
		});
	});

	it("reads an empty file as no spots and the defaults", () => {
		writeFile("");
		const store = open();
		expect(store.problem).toBeUndefined();
		expect(store.settings()).toEqual(DEFAULT_SETTINGS);
	});

	it("changes nothing when it can't save", () => {
		const store = open();
		// The data folder is a file, so nothing can be written under it.
		writeFileSync(join(dir, "data"), "");
		expect(() => store.add({ name: "a", permanent: false })).toThrow(/Couldn't save/);
		expect(store.all()).toEqual([]);
	});
});

describe("helpers", () => {
	it("reads the reset as a clock", () => {
		expect(resetClock({ resetAt: "22:30" })).toEqual({ hour: 22, minute: 30 });
		expect(resetClock({ resetAt: "nonsense" })).toEqual({ hour: 23, minute: 59 });
	});

	it("normalises durations, or says one doesn't parse", () => {
		expect(normaliseDurations(["60m", "1h", "2h"])).toEqual(["1h", "2h"]);
		expect(normaliseDurations(["1h", "later"])).toBeUndefined();
	});
});
