import { describe, expect, it } from "vitest";
import {
	describeInstant,
	formatParkingDuration,
	MAX_DURATION_MINUTES,
	nextReset,
	parseDuration,
} from "./parking-time.ts";

const ZONE = "Europe/Amsterdam";
const RESET = { hour: 23, minute: 59 };

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
	// The units and forms are core/duration.ts's; this is what parking adds and limits.
	it("reads a duration up to a day", () => {
		expect(parseDuration("2h30")).toEqual({ kind: "minutes", minutes: 150 });
		expect(parseDuration("1 day")).toEqual({ kind: "minutes", minutes: MAX_DURATION_MINUTES });
	});

	it("reads the rest of the day", () => {
		expect(parseDuration("rest of day")).toEqual({ kind: "rest-of-day" });
		expect(parseDuration("  Rest  of the  DAY ")).toEqual({ kind: "rest-of-day" });
	});

	it.each(["", "soon", "25h", "1441m", "2 days"])("refuses %j", (typed) => {
		expect(parseDuration(typed)).toBeUndefined();
	});

	it("writes durations the usual way", () => {
		expect(formatParkingDuration({ kind: "minutes", minutes: 125 })).toBe("2h05");
		expect(formatParkingDuration({ kind: "rest-of-day" })).toBe("rest of day");
	});
});
