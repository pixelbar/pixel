import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { silentLogger } from "../core/logger.ts";
import type { ParkingSpot } from "./parking-spots.ts";
import {
	openUntil,
	type ParkingEntries,
	type ParkingEntry,
	ParkingWindowStore,
} from "./parking-windows.ts";

let dir: string;
let file: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pixel-parking-windows-"));
	file = join(dir, "parking-windows.yaml");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const open = () => new ParkingWindowStore({ file, logger: silentLogger });
const setBy = { ref: "discord:100000000000000001", name: "Admin" };
const at = (time: string) => new Date(`2026-10-24T${time}:00Z`);
const entry = (spot: string, from: string, until: string): ParkingEntry => ({
	spot,
	from: at(from),
	until: at(until),
	setBy,
});
const NOW = at("08:00");

describe("ParkingWindowStore", () => {
	it("starts empty, and keeps entries in memory without a file", () => {
		expect(open().entries(NOW)).toEqual({ windows: [], blocks: [] });
		const store = new ParkingWindowStore({ logger: silentLogger });
		store.replace({ windows: [entry("a", "08:00", "15:00")], blocks: [] }, NOW);
		expect(store.entries(NOW).windows).toHaveLength(1);
	});

	it("saves entries, and reads them back after a restart", () => {
		const store = open();
		const next: ParkingEntries = {
			windows: [entry("neighbour-1", "08:00", "15:00")],
			blocks: [entry("ours", "09:00", "12:00")],
		};
		store.replace(next, NOW);
		const text = readFileSync(file, "utf8");
		expect(text.startsWith("# When Pixel's parking spots are open")).toBe(true);
		expect(parse(text).windows).toEqual([
			{
				spot: "neighbour-1",
				from: "2026-10-24T08:00:00.000Z",
				until: "2026-10-24T15:00:00.000Z",
				setBy,
			},
		]);
		expect(open().entries(NOW)).toEqual(next);
	});

	it("leaves out entries that have ended, and doesn't write them", () => {
		const store = open();
		store.replace(
			{ windows: [entry("a", "06:00", "08:00"), entry("b", "06:00", "09:00")], blocks: [] },
			NOW,
		);
		expect(parse(readFileSync(file, "utf8")).windows.map((w: ParkingEntry) => w.spot)).toEqual([
			"b",
		]);
		expect(store.entries(at("09:00")).windows).toEqual([]);
	});

	describe("a file that can't be read", () => {
		it.each([
			["not YAML", "windows: ["],
			["the wrong shape", "windows:\n  - spot: a\n"],
			[
				"an end before its start",
				"windows:\n  - spot: a\n    from: 2026-10-24T10:00:00Z\n    until: 2026-10-24T09:00:00Z\n    setBy: { ref: x, name: y }\n",
			],
		])("%s closes borrowed spots until the next change, which moves it aside", (_, text) => {
			writeFileSync(file, text);
			const store = open();
			expect(store.problem).toBeDefined();
			expect(store.entries(NOW)).toEqual({ windows: [], blocks: [] });

			store.replace({ windows: [entry("a", "08:00", "15:00")], blocks: [] }, NOW);
			expect(store.problem).toBeUndefined();
			expect(readFileSync(`${file}.broken`, "utf8")).toBe(text);
			expect(open().entries(NOW).windows).toHaveLength(1);
		});

		it("says so when it can't be read at all", () => {
			mkdirSync(file);
			expect(open().problem).toMatch(/\(EISDIR\)/);
		});

		it("still starts a new file if the broken one has gone meanwhile", () => {
			writeFileSync(file, "windows: [");
			const store = open();
			rmSync(file);
			store.replace({ windows: [], blocks: [] }, NOW);
			expect(existsSync(file)).toBe(true);
			expect(existsSync(`${file}.broken`)).toBe(false);
		});
	});

	it("reads an empty file as nothing set", () => {
		writeFileSync(file, "");
		expect(open().problem).toBeUndefined();
	});

	it("changes nothing when it can't save", () => {
		const store = new ParkingWindowStore({
			file: join(dir, "file", "x.yaml"),
			logger: silentLogger,
		});
		writeFileSync(join(dir, "file"), "");
		expect(() =>
			store.replace({ windows: [entry("a", "08:00", "15:00")], blocks: [] }, NOW),
		).toThrow(/Couldn't save/);
		expect(store.entries(NOW).windows).toEqual([]);
	});

	describe("reconcile", () => {
		const spots: ParkingSpot[] = [
			{ name: "ours", permanent: true },
			{ name: "borrowed", permanent: false },
		];

		it("drops entries for spots that are gone or the wrong kind, and saves", () => {
			const store = open();
			store.replace(
				{
					windows: [
						entry("borrowed", "08:00", "15:00"),
						entry("ours", "08:00", "15:00"),
						entry("gone", "08:00", "15:00"),
					],
					blocks: [entry("ours", "09:00", "10:00"), entry("borrowed", "09:00", "10:00")],
				},
				NOW,
			);
			expect(store.reconcile(spots, NOW)).toBe(3);
			const expected = {
				windows: [entry("borrowed", "08:00", "15:00")],
				blocks: [entry("ours", "09:00", "10:00")],
			};
			expect(store.entries(NOW)).toEqual(expected);
			expect(open().entries(NOW)).toEqual(expected);
		});

		it("does nothing when everything fits", () => {
			const store = open();
			expect(store.reconcile(spots, NOW)).toBe(0);
			expect(existsSync(file)).toBe(false);
		});

		it("still applies when it can't save", () => {
			const store = new ParkingWindowStore({ logger: silentLogger });
			store.replace({ windows: [entry("gone", "08:00", "15:00")], blocks: [] }, NOW);
			const broken = Object.assign(store, {
				replace: () => {
					throw new Error("disk full");
				},
			});
			expect(broken.reconcile(spots, NOW)).toBe(1);
			expect(broken.entries(NOW).windows).toEqual([]);
		});
	});
});

describe("openUntil", () => {
	const reset = at("21:59");
	const ours: ParkingSpot = { name: "ours", permanent: true };
	const borrowed: ParkingSpot = { name: "borrowed", permanent: false };

	it("keeps a permanent spot open until the reset", () => {
		expect(openUntil(ours, { windows: [], blocks: [] }, NOW, reset)).toEqual(reset);
	});

	it("closes a permanent spot during a closure, and stops before the next one", () => {
		const entries = {
			windows: [],
			blocks: [entry("ours", "12:00", "14:00"), entry("ours", "16:00", "17:00")],
		};
		expect(openUntil(ours, entries, NOW, reset)).toEqual(at("12:00"));
		expect(openUntil(ours, entries, at("13:00"), reset)).toBeUndefined();
		expect(openUntil(ours, entries, at("14:00"), reset)).toEqual(at("16:00"));
		expect(openUntil(ours, entries, at("17:00"), reset)).toEqual(reset);
	});

	it("opens a borrowed spot only in a window, and never past the reset", () => {
		const entries = {
			windows: [entry("borrowed", "09:00", "15:00"), entry("other", "06:00", "23:00")],
			blocks: [],
		};
		expect(openUntil(borrowed, entries, NOW, reset)).toBeUndefined();
		expect(openUntil(borrowed, entries, at("09:00"), reset)).toEqual(at("15:00"));
		expect(openUntil(borrowed, entries, at("15:00"), reset)).toBeUndefined();
		expect(openUntil(borrowed, entries, at("10:00"), at("12:00"))).toEqual(at("12:00"));
	});
});
