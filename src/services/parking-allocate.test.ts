import { describe, expect, it } from "vitest";
import { notConnectedGate } from "../core/ports/gate.ts";
import { principal } from "../testing/fixtures.ts";
import { cutBookings, freeSpots, longestFree, pickSpot } from "./parking-allocate.ts";
import type { ParkingBooking } from "./parking-bookings.ts";
import type { ParkingSpot } from "./parking-spots.ts";
import type { ParkingEntries, ParkingEntry } from "./parking-windows.ts";

const at = (time: string) => new Date(`2026-10-24T${time}:00Z`);
const NOW = at("08:00");
const RESET = at("21:59");
const setBy = { ref: "x", name: "y" };
const window = (spot: string, from: string, until: string): ParkingEntry => ({
	spot,
	from: at(from),
	until: at(until),
	setBy,
});

const ours: ParkingSpot = { name: "ours", permanent: true };
const early: ParkingSpot = { name: "early", permanent: false };
const late: ParkingSpot = { name: "late", permanent: false };
const shut: ParkingSpot = { name: "shut", permanent: false };
const SPOTS = [early, late, shut, ours];
const ENTRIES: ParkingEntries = {
	windows: [window("early", "07:00", "12:00"), window("late", "07:00", "16:00")],
	blocks: [],
};

describe("freeSpots", () => {
	it("lists the open spots nobody is in, with until when they're open", () => {
		expect(
			freeSpots(SPOTS, ENTRIES, new Set(["late"]), NOW, RESET).map((f) => [
				f.spot.name,
				f.openUntil,
			]),
		).toEqual([
			["early", at("12:00")],
			["ours", RESET],
		]);
	});

	it("leaves out a spot that closes right now", () => {
		const entries = { windows: [window("early", "07:00", "08:00")], blocks: [] };
		expect(freeSpots([early], entries, new Set(), NOW, RESET)).toEqual([]);
	});
});

describe("pickSpot", () => {
	const free = freeSpots(SPOTS, ENTRIES, new Set(), NOW, RESET);

	it("offers a permanent spot first", () => {
		expect(pickSpot(free, at("09:00"))?.spot).toBe(ours);
	});

	it("then the borrowed spot that closes soonest after the end", () => {
		const borrowed = free.filter((f) => !f.spot.permanent);
		expect(pickSpot(borrowed, at("09:00"))?.spot).toBe(early);
		expect(pickSpot(borrowed, at("12:00"))?.spot).toBe(early);
		expect(pickSpot(borrowed, at("13:00"))?.spot).toBe(late);
	});

	it("keeps the file's order for spots that close at the same time", () => {
		const twins = [
			{ spot: late, openUntil: at("16:00") },
			{ spot: early, openUntil: at("16:00") },
		];
		expect(pickSpot(twins, at("09:00"))?.spot).toBe(late);
	});

	it("finds nothing when no spot is open for the whole time", () => {
		expect(pickSpot(free, at("22:00"))).toBeUndefined();
		expect(pickSpot([], at("09:00"))).toBeUndefined();
	});

	it("suggests the spot open longest", () => {
		expect(longestFree(free)?.spot).toBe(ours);
		expect(longestFree([])).toBeUndefined();
	});
});

describe("cutBookings", () => {
	const booking = (spot: string, until: string): ParkingBooking => ({
		id: "aaaaaa",
		spot,
		by: setBy,
		since: NOW,
		until: at(until),
		remindedAt: null,
	});

	it("finds bookings whose spot is gone, closed, or closes before their end", () => {
		const bookings = [
			booking("early", "11:00"),
			booking("late", "17:00"),
			booking("gone", "09:00"),
			booking("shut", "09:00"),
		];
		expect(cutBookings(bookings, SPOTS, ENTRIES, NOW, RESET).map((b) => b.spot)).toEqual([
			"late",
			"gone",
			"shut",
		]);
	});
});

describe("notConnectedGate", () => {
	it("never opens", async () => {
		expect(await notConnectedGate.open({ principal: principal("member"), spot: "ours" })).toEqual({
			opened: false,
			reason: "not-connected",
		});
	});
});
