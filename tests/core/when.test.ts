import { describe, expect, it } from "vitest";
import { formatLocal } from "../../src/core/recurrence.ts";
import {
	addDays,
	describeDate,
	describeWhen,
	formatDays,
	formatTimeOfDay,
	parseDays,
	parseTimeOfDay,
	parseWhen,
	readWhen,
	suggestDays,
	type WhenProblem,
} from "../../src/core/when.ts";

describe("parseTimeOfDay", () => {
	it.each([
		["23:59", 23, 59],
		[" 07:05 ", 7, 5],
		["2359", 23, 59],
		["23.59", 23, 59],
		["23u59", 23, 59],
		["19", 19, 0],
		["11pm", 23, 0],
		["11:59 pm", 23, 59],
		["12am", 0, 0],
		["noon", 12, 0],
		["Midday", 12, 0],
		["midnight", 0, 0],
	])("reads %j", (typed, hour, minute) => {
		expect(parseTimeOfDay(typed)).toEqual({ hour, minute });
	});

	it.each(["", "24:00", "23:60", "13pm", "tomorrow", "wed 19", "11 59 pm", "19 xx", "noon 12"])(
		"refuses %j",
		(typed) => {
			expect(parseTimeOfDay(typed)).toBeUndefined();
		},
	);

	it("writes a time of day as HH:MM", () => {
		expect(formatTimeOfDay({ hour: 7, minute: 5 })).toBe("07:05");
	});

	it("adds days across months and years", () => {
		expect(addDays({ year: 2026, month: 12, day: 31 }, 1)).toEqual({
			year: 2027,
			month: 1,
			day: 1,
		});
	});
});

const AMS = "Europe/Amsterdam";
// Monday 12 October 2026, 10:00 in Amsterdam.
const NOW = new Date("2026-10-12T08:00:00Z");
const parsed = (typed: string) => {
	const at = parseWhen(typed, NOW, AMS);
	return at ? formatLocal(at) : undefined;
};

describe("parseWhen: now", () => {
	// 10:00:30 in Amsterdam, half a minute past.
	const at = new Date("2026-10-12T08:00:30Z");
	const read = (typed: string, options?: { now?: Date }) => {
		const local = parseWhen(typed, at, AMS, options);
		return local ? formatLocal(local) : undefined;
	};

	it("reads now as the next whole minute, so it's still to come", () => {
		expect(read("now")).toBe("2026-10-12T10:01");
		expect(read(" NOW ")).toBe("2026-10-12T10:01");
		expect(parseWhen("now", NOW, AMS)).toEqual({
			year: 2026,
			month: 10,
			day: 12,
			hour: 10,
			minute: 1,
		});
	});

	it("adds any duration the duration parser reads", () => {
		expect(read("now+30m")).toBe("2026-10-12T10:30");
		expect(read("now + 2h30")).toBe("2026-10-12T12:30");
		expect(read("now+an hour")).toBe("2026-10-12T11:00");
		expect(read("now+1 day")).toBe("2026-10-13T10:00");
	});

	it("refuses a duration it can't read", () => {
		expect(read("now+soon")).toBeUndefined();
		expect(read("now+")).toBeUndefined();
		expect(read("nowish")).toBeUndefined();
	});

	it("counts from the real now when another reference is given, and refuses what's before it", () => {
		const later = new Date("2026-10-12T12:00:00Z");
		const local = parseWhen("now+5h", later, AMS, { now: at });
		expect(local ? formatLocal(local) : undefined).toBe("2026-10-12T15:00");
		expect(parseWhen("now+1h", later, AMS, { now: at })).toBeUndefined();
	});

	it("says a moment before a later reference is before it starts, not past", () => {
		const later = new Date("2026-10-12T12:00:00Z");
		expect(readWhen("now+1h", later, AMS, { now: at })).toEqual({
			ok: false,
			problem: {
				kind: "before-start",
				at: { year: 2026, month: 10, day: 12, hour: 11, minute: 0 },
			},
		});
		expect(readWhen("2026-10-01T19:00", later, AMS, { now: at })).toMatchObject({
			problem: { kind: "before-start" },
		});
		// With no other reference, it's simply past.
		expect(readWhen("today 9", at, AMS, { now: at })).toMatchObject({ problem: { kind: "past" } });
	});
});

describe("parseWhen", () => {
	it("reads a weekday and a time as the next one of those, not a list of dates", () => {
		expect(parsed("wed 19")).toBe("2026-10-14T19:00");
		expect(parsed("Wednesday 19:30")).toBe("2026-10-14T19:30");
		expect(parsed("19:00 sat")).toBe("2026-10-17T19:00");
		expect(parsed("on wed at 7pm")).toBe("2026-10-14T19:00");
		expect(parsed("this wed 19")).toBe("2026-10-14T19:00");
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

	it("reads four digits after a date as a time, and as a year only beside another time or when no clock reads them", () => {
		// The same whether the date has a month name or not.
		expect(parsed("14 nov 2030")).toBe("2026-11-14T20:30");
		expect(parsed("14-11 2030")).toBe("2026-11-14T20:30");
		expect(parsed("14 nov 1900")).toBe("2026-11-14T19:00");
		expect(parsed("nov 14 1900")).toBe("2026-11-14T19:00");
		// A year when another time is there too.
		expect(parsed("14 nov 2030 19:00")).toBe("2030-11-14T19:00");
		expect(parsed("14-11 2030 19:00")).toBe("2030-11-14T19:00");
		expect(parsed("14 nov 2030 1900")).toBe("2030-11-14T19:00");
		expect(parsed("14 nov 2027 7 pm")).toBe("2027-11-14T19:00");
		// A year when it can't be a time.
		expect(parsed("14 nov 2099")).toBe("2099-11-14T19:00");
		expect(parsed("14-11 2099")).toBe("2099-11-14T19:00");
		// An explicit past year is refused.
		expect(parsed("14 nov 2025 19:00")).toBeUndefined();
	});

	it("knows month names and their short forms, and refuses other words that start like one", () => {
		expect(parsed("14 sept 19:00")).toBe("2027-09-14T19:00");
		expect(parsed("14 september 19:00")).toBe("2027-09-14T19:00");
		expect(parsed("june 5")).toBe("2027-06-05T19:00");
		expect(parsed("5 jul")).toBe("2027-07-05T19:00");
		for (const nonsense of ["junk 5", "decent 3 19:00", "mars 3", "octopus 14", "novel 1 10"]) {
			expect(parsed(nonsense)).toBeUndefined();
		}
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

describe("parseWhen: in <duration>", () => {
	it("reads in and a duration as that long from now, to the minute", () => {
		expect(parsed("in 30 minutes")).toBe("2026-10-12T10:30");
		expect(parsed("in 2 hours")).toBe("2026-10-12T12:00");
		expect(parsed("In an hour")).toBe("2026-10-12T11:00");
		expect(parsed("in 1h30")).toBe("2026-10-12T11:30");
		expect(parsed("in 3 days")).toBe("2026-10-15T10:00");
	});

	it("leaves in before anything else to the day and time reader", () => {
		expect(parsed("in oct 14")).toBe("2026-10-14T19:00");
		expect(parsed("in 2 days at 8")).toBeUndefined();
		expect(parsed("in a while")).toBeUndefined();
	});
});

describe("parseWhen: ordinals", () => {
	it("reads a day of the month with st, nd, rd or th, beside a month", () => {
		expect(parsed("14th oct")).toBe("2026-10-14T19:00");
		expect(parsed("oct 14th 8pm")).toBe("2026-10-14T20:00");
		expect(parsed("22nd of october 19:30")).toBe("2026-10-22T19:30");
		expect(parsed("oct 1st")).toBe("2027-10-01T19:00");
		expect(parsed("the 3rd of nov")).toBe("2026-11-03T19:00");
	});

	it("reads one on its own as the next day with that number", () => {
		expect(parsed("the 3rd")).toBe("2026-11-03T19:00");
		expect(parsed("the 12th")).toBe("2026-10-12T19:00");
		expect(parsed("31st 20:00")).toBe("2026-10-31T20:00");
		// Today's, with a time that has gone, is refused like "today 9".
		expect(parsed("the 12th 9")).toBeUndefined();
		// No 31st in November: the next one is in December.
		const nov = new Date("2026-11-12T08:00:00Z");
		const at = parseWhen("the 31st", nov, AMS);
		expect(at ? formatLocal(at) : undefined).toBe("2026-12-31T19:00");
		// No 30th in February: the next one is in March.
		const feb = new Date("2027-02-01T08:00:00Z");
		const march = parseWhen("30th", feb, AMS);
		expect(march ? formatLocal(march) : undefined).toBe("2027-03-30T19:00");
	});

	it("refuses an ordinal that's no day of a month", () => {
		expect(parsed("the 32nd")).toBeUndefined();
		expect(parsed("0th")).toBeUndefined();
	});
});

describe("parseWhen: noon, midnight and the evening", () => {
	it("reads noon as 12:00 and midnight as the end of its day", () => {
		expect(parsed("noon")).toBe("2026-10-12T12:00");
		expect(parsed("tomorrow at noon")).toBe("2026-10-13T12:00");
		expect(parsed("midday wed")).toBe("2026-10-14T12:00");
		expect(parsed("midnight")).toBe("2026-10-13T00:00");
		expect(parsed("fri midnight")).toBe("2026-10-17T00:00");
		expect(parsed("mon midnight")).toBe("2026-10-13T00:00");
		expect(parsed("14 oct midnight")).toBe("2026-10-15T00:00");
	});

	it("reads tonight and an evening as 19:00, or the evening time given", () => {
		expect(parsed("tonight")).toBe("2026-10-12T19:00");
		expect(parsed("this evening")).toBe("2026-10-12T19:00");
		expect(parsed("evening")).toBe("2026-10-12T19:00");
		expect(parsed("tonight 8")).toBe("2026-10-12T20:00");
		expect(parsed("tonight at 8:30")).toBe("2026-10-12T20:30");
		expect(parsed("tonight 5")).toBe("2026-10-12T17:00");
		expect(parsed("tonight 930")).toBe("2026-10-12T21:30");
		expect(parsed("tonight 20:00")).toBe("2026-10-12T20:00");
		expect(parsed("8pm tonight")).toBe("2026-10-12T20:00");
		expect(parsed("midnight tonight")).toBe("2026-10-13T00:00");
		expect(parsed("fri evening 9")).toBe("2026-10-16T21:00");
		expect(parsed("sat night")).toBe("2026-10-17T19:00");
		expect(parsed("tomorrow evening")).toBe("2026-10-13T19:00");
	});

	it("refuses a time that isn't in the evening, rather than guess", () => {
		for (const typed of [
			"tonight 9am",
			"tonight 2",
			"tonight 12",
			"tonight noon",
			"tonight 0830",
			"tonight 16:00",
		]) {
			expect(readWhen(typed, NOW, AMS)).toEqual({ ok: false, problem: { kind: "not-evening" } });
		}
		expect(parsed("fri tonight")).toBeUndefined();
	});
});

describe("parseWhen: this and next", () => {
	it("reads next and a weekday as that day of next week, and this or none as the coming one", () => {
		// NOW is Monday 12 October.
		expect(parsed("next wed")).toBe("2026-10-21T19:00");
		expect(parsed("next mon 9")).toBe("2026-10-19T09:00");
		expect(parsed("next sunday")).toBe("2026-10-25T19:00");
		expect(parsed("wed")).toBe("2026-10-14T19:00");
		expect(parsed("this wed")).toBe("2026-10-14T19:00");
		// From a Sunday, next week starts the next day.
		const sunday = new Date("2026-10-18T08:00:00Z");
		const at = parseWhen("next mon", sunday, AMS);
		expect(at ? formatLocal(at) : undefined).toBe("2026-10-19T19:00");
	});

	it("refuses next before anything but a weekday", () => {
		expect(readWhen("next", NOW, AMS)).toEqual({ ok: false, problem: { kind: "unclear" } });
		expect(parsed("next 14 oct")).toBeUndefined();
		expect(parsed("next tomorrow")).toBeUndefined();
	});
});

describe("readWhen: why it refuses", () => {
	const problem = (typed: string): WhenProblem | undefined => {
		const read = readWhen(typed, NOW, AMS);
		return read.ok ? undefined : read.problem;
	};

	it("says so when nothing was typed or it isn't understood", () => {
		expect(problem("  ")).toEqual({ kind: "empty" });
		expect(problem("someday")).toEqual({ kind: "unclear" });
		expect(problem("now+soon")).toEqual({ kind: "unclear" });
		expect(problem("32-10")).toEqual({ kind: "unclear" });
		expect(problem("2026-13-01 10")).toEqual({ kind: "unclear" });
	});

	it("says what it understood when that has already passed", () => {
		expect(problem("today 9")).toEqual({
			kind: "past",
			at: { year: 2026, month: 10, day: 12, hour: 9, minute: 0 },
		});
		expect(problem("2026-10-01T19:00")).toMatchObject({ kind: "past" });
	});

	it("names a day and month that don't exist that year", () => {
		expect(problem("31 feb")).toEqual({ kind: "no-such-date", day: 31, month: 2, year: 2027 });
		expect(problem("29 feb")).toEqual({ kind: "no-such-date", day: 29, month: 2, year: 2027 });
		expect(problem("2026-02-30")).toEqual({
			kind: "no-such-date",
			day: 30,
			month: 2,
			year: 2026,
		});
		expect(problem("31-04 10:00")).toEqual({
			kind: "no-such-date",
			day: 31,
			month: 4,
			year: 2027,
		});
		// 29 Feb is fine in a leap year.
		const leap = readWhen("29 feb", new Date("2027-10-12T08:00:00Z"), AMS);
		expect(leap.ok && formatLocal(leap.at)).toBe("2028-02-29T19:00");
	});

	it("refuses words for a stretch of time as too vague", () => {
		expect(problem("tomorrow morning")).toEqual({ kind: "vague", word: "morning" });
		expect(problem("afternoon")).toEqual({ kind: "vague", word: "afternoon" });
		expect(problem("next week")).toEqual({ kind: "vague", word: "week" });
		expect(problem("this weekend")).toEqual({ kind: "vague", word: "weekend" });
		expect(problem("later")).toEqual({ kind: "vague", word: "later" });
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

	it("writes a date, even one that doesn't exist that year", () => {
		expect(describeDate({ year: 2027, month: 2, day: 31 })).toBe("31 Feb 2027");
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
