import { describe, expect, it } from "vitest";
import {
	describeInstant,
	formatClock,
	formatParkingDuration,
	MAX_DURATION_MINUTES,
	nextReset,
	parseClock,
	parseDuration,
} from "./parking-time.ts";

const ZONE = "Europe/Amsterdam";
const RESET = { hour: 23, minute: 59 };

describe("parseClock", () => {
	it("reads HH:MM", () => {
		expect(parseClock("23:59")).toEqual({ hour: 23, minute: 59 });
		expect(parseClock(" 07:05 ")).toEqual({ hour: 7, minute: 5 });
		expect(parseClock("00:00")).toEqual({ hour: 0, minute: 0 });
	});

	it("refuses anything else", () => {
		for (const text of ["", "7:00", "24:00", "23:60", "23.59", "11pm", "23:59:00"]) {
			expect(parseClock(text)).toBeUndefined();
		}
	});

	it("formats a clock", () => {
		expect(formatClock({ hour: 7, minute: 5 })).toBe("07:05");
	});
});

describe("nextReset", () => {
	it("is today's reset while it's still ahead", () => {
		// 10:00 in Amsterdam (summer time, UTC+2).
		expect(nextReset(new Date("2026-10-24T08:00:00Z"), RESET, ZONE)).toEqual(
			new Date("2026-10-24T21:59:00Z"),
		);
	});

	it("is tomorrow's once today's has passed, or right at it", () => {
		expect(nextReset(new Date("2026-10-24T21:59:00Z"), RESET, ZONE)).toEqual(
			// The clocks go back overnight, so tomorrow's 23:59 is UTC+1.
			new Date("2026-10-25T22:59:00Z"),
		);
		expect(nextReset(new Date("2026-10-24T21:59:30Z"), RESET, ZONE)).toEqual(
			new Date("2026-10-25T22:59:00Z"),
		);
	});

	it("rolls over the end of a month and a year", () => {
		expect(nextReset(new Date("2026-12-31T23:30:00Z"), { hour: 0, minute: 15 }, ZONE)).toEqual(
			new Date("2027-01-01T23:15:00Z"),
		);
	});
});

describe("describeInstant", () => {
	const now = new Date("2026-10-24T08:00:00Z");

	it("is just the time on the same day", () => {
		expect(describeInstant(new Date("2026-10-24T15:00:00Z"), now, ZONE)).toBe("17:00");
	});

	it("names the day otherwise", () => {
		expect(describeInstant(new Date("2026-10-25T07:00:00Z"), now, ZONE)).toBe(
			"Sun 25 Oct 2026, 08:00",
		);
	});
});

describe("parseDuration", () => {
	it.each([
		["30m", 30],
		["90 min", 90],
		["45 minutes", 45],
		["1h", 60],
		["2 hours", 120],
		["2h30", 150],
		["2h 30m", 150],
		["2H30M", 150],
		["24h", MAX_DURATION_MINUTES],
	])("reads %s", (typed, minutes) => {
		expect(parseDuration(typed)).toEqual({ kind: "minutes", minutes });
	});

	it("reads the rest of the day", () => {
		expect(parseDuration("rest of day")).toEqual({ kind: "rest-of-day" });
		expect(parseDuration("  Rest  of the  DAY ")).toEqual({ kind: "rest-of-day" });
	});

	it.each(["", "0m", "2h60", "25h", "1441m", "soon", "2", "h", "1.5h", "-1h"])(
		"refuses %j",
		(typed) => {
			expect(parseDuration(typed)).toBeUndefined();
		},
	);

	it("writes durations the usual way", () => {
		expect(formatParkingDuration({ kind: "minutes", minutes: 30 })).toBe("30m");
		expect(formatParkingDuration({ kind: "minutes", minutes: 60 })).toBe("1h");
		expect(formatParkingDuration({ kind: "minutes", minutes: 125 })).toBe("2h05");
		expect(formatParkingDuration({ kind: "rest-of-day" })).toBe("rest of day");
	});
});
