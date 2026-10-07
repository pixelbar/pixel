import { describe, expect, it } from "vitest";
import { formatLocal } from "./recurrence.ts";
import {
	describeWhen,
	formatDays,
	parseDays,
	parseWhen,
	suggestDays,
	suggestWhen,
} from "./when.ts";

const AMS = "Europe/Amsterdam";
// Monday 12 October 2026, 10:00 in Amsterdam.
const NOW = new Date("2026-10-12T08:00:00Z");
const suggest = (typed: string, limit = 5) => suggestWhen(typed, NOW, AMS, limit).map(formatLocal);

describe("suggestWhen", () => {
	it("understands a weekday and a time, offering the coming ones first", () => {
		expect(suggest("wed 19")).toEqual(["2026-10-14T19:00", "2026-10-21T19:00", "2026-10-28T19:00"]);
		expect(suggest("Wednesday 19:30", 1)).toEqual(["2026-10-14T19:30"]);
		expect(suggest("19:00 sat", 1)).toEqual(["2026-10-17T19:00"]);
		expect(suggest("on wed at 7pm", 1)).toEqual(["2026-10-14T19:00"]);
		expect(suggest("next wed 19", 1)).toEqual(["2026-10-14T19:00"]);
	});

	it("understands today and tomorrow, and leaves out times already gone", () => {
		expect(suggest("today 19")).toEqual(["2026-10-12T19:00"]);
		expect(suggest("today 9")).toEqual([]);
		expect(suggest("tomorrow 9.15")).toEqual(["2026-10-13T09:15"]);
		expect(suggest("tonight 8pm")).toEqual(["2026-10-12T20:00"]);
	});

	it("understands dates in several forms, rolling a past day and month into next year", () => {
		expect(suggest("14 oct 19:00")).toEqual(["2026-10-14T19:00"]);
		expect(suggest("oct 14 19:00")).toEqual(["2026-10-14T19:00"]);
		expect(suggest("14 october 2027 19:00")).toEqual(["2027-10-14T19:00"]);
		expect(suggest("14-10 19:00")).toEqual(["2026-10-14T19:00"]);
		expect(suggest("14/10/2026 19:00")).toEqual(["2026-10-14T19:00"]);
		expect(suggest("2026-10-14 19:00")).toEqual(["2026-10-14T19:00"]);
		expect(suggest("1 jan 12")).toEqual(["2027-01-01T12:00"]);
		expect(suggest("5 oct 12")).toEqual(["2027-10-05T12:00"]);
	});

	it("offers common times for a day without a time, and the next days for a time without a day", () => {
		expect(suggest("sat", 3)).toEqual(["2026-10-17T12:00", "2026-10-17T19:00", "2026-10-17T20:00"]);
		expect(suggest("19:00", 2)).toEqual(["2026-10-12T19:00", "2026-10-13T19:00"]);
		expect(suggest("", 2)).toEqual(["2026-10-12T12:00", "2026-10-12T19:00"]);
	});

	it("takes 12-hour times, with or without a space", () => {
		expect(suggest("wed 7:30pm", 1)).toEqual(["2026-10-14T19:30"]);
		expect(suggest("wed 7 pm", 1)).toEqual(["2026-10-14T19:00"]);
		expect(suggest("wed 12am", 1)).toEqual(["2026-10-14T00:00"]);
		expect(suggest("wed 12pm", 1)).toEqual(["2026-10-14T12:00"]);
	});

	it("accepts its own canonical value, but only in the future", () => {
		expect(suggest("2026-10-14T19:00")).toEqual(["2026-10-14T19:00"]);
		expect(suggest("2026-10-01T19:00")).toEqual([]);
	});

	it("offers nothing for what it doesn't understand, rather than guessing", () => {
		for (const nonsense of [
			"someday",
			"wed 25:00",
			"31 feb 10",
			"13pm wed",
			"wed 19 banana",
			"oct",
			"32-10 10",
			"2026-13-01 10",
		]) {
			expect(suggest(nonsense)).toEqual([]);
		}
	});
});

describe("parseWhen", () => {
	it("gives the first match, or nothing", () => {
		expect(formatLocal(parseWhen("wed 19", NOW, AMS) as never)).toBe("2026-10-14T19:00");
		expect(parseWhen("yesterday", NOW, AMS)).toBeUndefined();
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
