import { describe, expect, it } from "vitest";
import { formatLocal } from "./recurrence.ts";
import { describeWhen, formatDays, parseDays, parseWhen, suggestDays } from "./when.ts";

const AMS = "Europe/Amsterdam";
// Monday 12 October 2026, 10:00 in Amsterdam.
const NOW = new Date("2026-10-12T08:00:00Z");
const parsed = (typed: string) => {
	const at = parseWhen(typed, NOW, AMS);
	return at ? formatLocal(at) : undefined;
};

describe("parseWhen", () => {
	it("reads a weekday and a time as the next one of those, not a list of dates", () => {
		expect(parsed("wed 19")).toBe("2026-10-14T19:00");
		expect(parsed("Wednesday 19:30")).toBe("2026-10-14T19:30");
		expect(parsed("19:00 sat")).toBe("2026-10-17T19:00");
		expect(parsed("on wed at 7pm")).toBe("2026-10-14T19:00");
		expect(parsed("next wed 19")).toBe("2026-10-14T19:00");
	});

	it("defaults a day without a time to 19:00, and a time without a day to the next clock hit", () => {
		expect(parsed("sat")).toBe("2026-10-17T19:00");
		expect(parsed("wed")).toBe("2026-10-14T19:00");
		expect(parsed("19:00")).toBe("2026-10-12T19:00");
		expect(parsed("9")).toBe("2026-10-13T09:00");
	});

	it("understands today and tomorrow, and refuses times already gone", () => {
		expect(parsed("today 19")).toBe("2026-10-12T19:00");
		expect(parsed("today 9")).toBeUndefined();
		expect(parsed("tomorrow 9.15")).toBe("2026-10-13T09:15");
		expect(parsed("tonight 8pm")).toBe("2026-10-12T20:00");
	});

	it("understands dates in several forms, rolling a past day and month into next year", () => {
		expect(parsed("14 oct 19:00")).toBe("2026-10-14T19:00");
		expect(parsed("oct 14 19:00")).toBe("2026-10-14T19:00");
		expect(parsed("14 october 2027 19:00")).toBe("2027-10-14T19:00");
		expect(parsed("14-10 19:00")).toBe("2026-10-14T19:00");
		expect(parsed("14/10/2026 19:00")).toBe("2026-10-14T19:00");
		expect(parsed("2026-10-14 19:00")).toBe("2026-10-14T19:00");
		expect(parsed("1 jan 12")).toBe("2027-01-01T12:00");
		expect(parsed("5 oct 12")).toBe("2027-10-05T12:00");
	});

	it("takes 12-hour times, with or without a space", () => {
		expect(parsed("wed 7:30pm")).toBe("2026-10-14T19:30");
		expect(parsed("wed 7 pm")).toBe("2026-10-14T19:00");
		expect(parsed("wed 12am")).toBe("2026-10-14T00:00");
		expect(parsed("wed 12pm")).toBe("2026-10-14T12:00");
	});

	it("takes compact 24h and Dutch uur, without a colon", () => {
		expect(parsed("1900")).toBe("2026-10-12T19:00");
		expect(parsed("wed 1900")).toBe("2026-10-14T19:00");
		expect(parsed("1930")).toBe("2026-10-12T19:30");
		expect(parsed("0930")).toBe("2026-10-13T09:30");
		expect(parsed("930")).toBe("2026-10-13T09:30");
		expect(parsed("19u")).toBe("2026-10-12T19:00");
		expect(parsed("19u30")).toBe("2026-10-12T19:30");
		expect(parsed("wed 19 uur")).toBe("2026-10-14T19:00");
		expect(parsed("2400")).toBeUndefined();
		expect(parsed("1960")).toBeUndefined();
	});

	it("accepts its own canonical value, but only in the future", () => {
		expect(parsed("2026-10-14T19:00")).toBe("2026-10-14T19:00");
		expect(parsed("2026-10-01T19:00")).toBeUndefined();
	});

	it("uses today's weekday when the time is still ahead, otherwise next week", () => {
		// NOW is Monday 10:00. Monday 19:00 is still today; Monday 09:00 has gone.
		expect(parsed("mon 19")).toBe("2026-10-12T19:00");
		expect(parsed("mon 9")).toBe("2026-10-19T09:00");
	});

	it("offers nothing for empty input or what it doesn't understand, rather than guessing a date", () => {
		for (const nonsense of [
			"",
			"   ",
			"someday",
			"wed 25:00",
			"31 feb 10",
			"13pm wed",
			"wed 19 banana",
			"oct",
			"32-10 10",
			"2026-13-01 10",
			"yesterday",
		]) {
			expect(parsed(nonsense)).toBeUndefined();
		}
	});
});

describe("describeWhen", () => {
	it("reads like a date people say", () => {
		expect(describeWhen({ year: 2026, month: 10, day: 14, hour: 19, minute: 0 })).toBe(
			"Wed 14 Oct 2026, 19:00",
		);
		expect(describeWhen({ year: 2027, month: 1, day: 3, hour: 8, minute: 5 })).toBe(
			"Sun 3 Jan 2027, 08:05",
		);
	});
});

describe("days of the week", () => {
	it("understand several ways of writing them, in week order", () => {
		expect(parseDays("sat wed")).toEqual(["wed", "sat"]);
		expect(parseDays("Wednesday and Saturday")).toEqual(["wed", "sat"]);
		expect(parseDays("wed,sat")).toEqual(["wed", "sat"]);
		expect(parseDays("weds & sat")).toEqual(["wed", "sat"]);
		expect(parseDays("weekdays")).toEqual(["mon", "tue", "wed", "thu", "fri"]);
		expect(parseDays("weekend")).toEqual(["sat", "sun"]);
		expect(parseDays("wed wed")).toEqual(["wed"]);
	});

	it("refuse anything that isn't a day", () => {
		expect(parseDays("")).toBeUndefined();
		expect(parseDays("wed someday")).toBeUndefined();
	});

	it("suggest what was typed, understood, and common sets when nothing is typed", () => {
		expect(suggestDays("sat wed")).toEqual([{ name: "Wednesday and Saturday", value: "wed,sat" }]);
		expect(suggestDays("nonsense")).toEqual([]);
		const empty = suggestDays("");
		expect(empty[0]).toEqual({ name: "Wednesday and Saturday", value: "wed,sat" });
		expect(empty.map((s) => s.value)).toContain("mon,tue,wed,thu,fri");
		expect(empty.map((s) => s.value)).toContain("sun");
		expect(formatDays(["wed", "sat"])).toBe("wed,sat");
	});
});
