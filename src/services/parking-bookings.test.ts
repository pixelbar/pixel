import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { silentLogger } from "../core/logger.ts";
import { ParkingBookingStore } from "./parking-bookings.ts";

let dir: string;
let file: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pixel-parking-bookings-"));
	file = join(dir, "parking-bookings.yaml");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const open = () => new ParkingBookingStore({ file, logger: silentLogger });
const NOW = new Date("2026-10-24T08:00:00Z");
const LATER = new Date("2026-10-24T10:00:00Z");
const alice = { ref: "discord:100000000000000002", name: "Alice" };
const bob = { ref: "discord:100000000000000003", name: "Bob" };

describe("ParkingBookingStore", () => {
	it("books the spot `pick` chooses, given the spots already taken, and saves it", () => {
		const store = open();
		const first = store.claim(alice, NOW, (taken) => {
			expect([...taken]).toEqual([]);
			return { spot: "ours", until: LATER };
		});
		expect(first).toMatchObject({
			kind: "booked",
			booking: { spot: "ours", by: alice, since: NOW, until: LATER, remindedAt: null },
		});
		store.claim(bob, NOW, (taken) => {
			expect([...taken]).toEqual(["ours"]);
			return { spot: "neighbour-1", until: LATER };
		});

		const text = readFileSync(file, "utf8");
		expect(text.startsWith("# Who is parked in Pixel's parking spots.")).toBe(true);
		expect(parse(text).bookings[0]).toMatchObject({
			spot: "ours",
			since: "2026-10-24T08:00:00.000Z",
			remindedAt: null,
		});
		const again = open();
		expect(again.all()).toEqual(store.all());
		expect(again.byPerson(bob.ref)?.spot).toBe("neighbour-1");
		expect(again.bySpot("ours")?.by).toEqual(alice);
	});

	it("never makes a second booking for someone, and says when nothing fits", () => {
		const store = open();
		store.claim(alice, NOW, () => ({ spot: "ours", until: LATER }));
		const again = store.claim(alice, NOW, () => {
			throw new Error("not asked");
		});
		expect(again).toMatchObject({ kind: "already", booking: { spot: "ours" } });
		expect(store.claim(bob, NOW, () => undefined)).toEqual({ kind: "none" });
		expect(store.all()).toHaveLength(1);
	});

	it("refuses to book a spot that's taken", () => {
		const store = open();
		store.claim(alice, NOW, () => ({ spot: "ours", until: LATER }));
		expect(() => store.claim(bob, NOW, () => ({ spot: "ours", until: LATER }))).toThrow(
			/already taken/,
		);
	});

	it("updates a booking, and ends bookings", () => {
		const store = new ParkingBookingStore({ logger: silentLogger });
		const claim = store.claim(alice, NOW, () => ({ spot: "ours", until: LATER }));
		const id = claim.kind === "booked" ? claim.booking.id : "";
		expect(store.update(id, { remindedAt: LATER })?.remindedAt).toEqual(LATER);
		expect(store.update("nope00", { remindedAt: LATER })).toBeUndefined();
		expect(store.end((b) => b.spot === "other")).toEqual([]);
		expect(store.end((b) => b.spot === "ours").map((b) => b.id)).toEqual([id]);
		expect(store.all()).toEqual([]);
	});

	it("moves a booking to the spot `pick` chooses, given the spots others hold", () => {
		const store = open();
		const claim = store.claim(alice, NOW, () => ({ spot: "ours", until: LATER }));
		store.claim(bob, NOW, () => ({ spot: "neighbour-1", until: LATER }));
		const id = claim.kind === "booked" ? claim.booking.id : "";
		const moved = store.move(id, (taken) => {
			expect([...taken]).toEqual(["neighbour-1"]);
			return "neighbour-2";
		});
		expect(moved).toMatchObject({ spot: "neighbour-2", by: alice, until: LATER });
		expect(open().byPerson(alice.ref)?.spot).toBe("neighbour-2");
		expect(store.move(id, () => undefined)).toBeUndefined();
		expect(store.move("nope00", () => "x")).toBeUndefined();
		expect(() => store.move(id, () => "neighbour-1")).toThrow(/already taken/);
	});

	it("reads a reminder back", () => {
		const store = open();
		const claim = store.claim(alice, NOW, () => ({ spot: "ours", until: LATER }));
		if (claim.kind === "booked") store.update(claim.booking.id, { remindedAt: NOW });
		expect(open().byPerson(alice.ref)?.remindedAt).toEqual(NOW);
	});

	describe("a file that can't be used", () => {
		const booking = (id: string, spot: string, ref: string) =>
			`  - id: ${id}\n    spot: ${spot}\n    by: { ref: "${ref}", name: x }\n    since: 2026-10-24T08:00:00Z\n    until: 2026-10-24T10:00:00Z\n    remindedAt: null\n`;
		it.each([
			["not YAML", "bookings: ["],
			["the wrong shape", "bookings:\n  - spot: ours\n"],
			[
				"a repeated spot",
				`bookings:\n${booking("aaaaaa", "a", "d:1")}${booking("bbbbbb", "a", "d:2")}`,
			],
			[
				"a repeated person",
				`bookings:\n${booking("aaaaaa", "a", "d:1")}${booking("bbbbbb", "b", "d:1")}`,
			],
		])("%s stops new bookings and is never overwritten", (_, text) => {
			writeFileSync(file, text);
			const store = open();
			expect(store.problem).toBeDefined();
			expect(() => store.claim(alice, NOW, () => ({ spot: "ours", until: LATER }))).toThrow(
				/no one can park/,
			);
			expect(() => store.end(() => true)).toThrow(/no one can park/);
			expect(() => store.update("aaaaaa", { remindedAt: NOW })).toThrow(/no one can park/);
			expect(readFileSync(file, "utf8")).toBe(text);
		});

		it("says so when it can't be read", () => {
			mkdirSync(file);
			expect(open().problem).toMatch(/\(EISDIR\)/);
		});
	});

	it("reads an empty file as nobody parked", () => {
		writeFileSync(file, "");
		expect(open().problem).toBeUndefined();
	});

	it("changes nothing when it can't save", () => {
		const store = new ParkingBookingStore({ file: join(dir, "x", "b.yaml"), logger: silentLogger });
		writeFileSync(join(dir, "x"), "");
		expect(() => store.claim(alice, NOW, () => ({ spot: "ours", until: LATER }))).toThrow(
			/Couldn't save/,
		);
		expect(store.all()).toEqual([]);
	});
});
