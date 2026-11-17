import { describe, expect, it } from "vitest";
import {
	describeInstant,
	formatParkingDuration,
	MAX_DURATION_MINUTES,
	nextReset,
	parseDuration,
	previewParkingDuration,
	readParkingLength,
} from "../../src/services/parking-time.ts";

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

describe("previewParkingDuration", () => {
	// Saturday 24 Oct 2026, 22:30 in Amsterdam.
	const late = new Date("2026-10-24T20:30:00Z");

	it("says when a booking made now would end", () => {
		expect(previewParkingDuration("1h", late, RESET, ZONE)).toEqual({
			ok: true,
			label: "until 23:30",
		});
		expect(previewParkingDuration("rest of day", late, RESET, ZONE)).toEqual({
			ok: true,
			label: "until 23:59",
		});
		expect(previewParkingDuration("2h", late, RESET, ZONE)).toEqual({
			ok: true,
			label: "until Sun 25 Oct 2026, 00:30",
		});
	});

	it("shows how long an end time is", () => {
		expect(previewParkingDuration("until 23:00", late, RESET, ZONE)).toEqual({
			ok: true,
			label: "30m, until 23:00",
		});
	});

	it("says what to try for what it can't read", () => {
		expect(previewParkingDuration("ages", late, RESET, ZONE)).toEqual({
			ok: false,
			why: "Not understood yet. Try 30m, 2h30, until 17:00",
		});
	});
});

describe("readParkingLength", () => {
	// Saturday 24 Oct 2026, 10:00 in Amsterdam; the reset is 23:59.
	const now = new Date("2026-10-24T08:00:00Z");
	const reset = new Date("2026-10-24T21:59:00Z");
	const read = (typed: string, base = now) => readParkingLength(typed, base, reset, ZONE, { now });

	it("reads a duration, an end or rest of day", () => {
		expect(read("2h30")).toEqual({
			ok: true,
			value: { end: new Date("2026-10-24T10:30:00Z"), by: "duration" },
		});
		expect(read("until 17:00")).toEqual({
			ok: true,
			value: { end: new Date("2026-10-24T15:00:00Z"), by: "end" },
		});
		expect(read("Rest  of the day")).toEqual({
			ok: true,
			value: { end: reset, by: "rest-of-day" },
		});
	});

	it("counts from a later base, such as the end being extended", () => {
		const base = new Date("2026-10-24T09:00:00Z");
		expect(read("1h", base)).toMatchObject({ value: { end: new Date("2026-10-24T10:00:00Z") } });
		expect(read("until now+30m", base)).toEqual({
			ok: false,
			problem: {
				kind: "before-start",
				at: { year: 2026, month: 10, day: 24, hour: 10, minute: 30 },
			},
		});
	});

	it("says why it can't use what was typed", () => {
		expect(read("ages")).toEqual({ ok: false, problem: { kind: "unclear" } });
	});
});
