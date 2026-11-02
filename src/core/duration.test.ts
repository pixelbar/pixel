import { describe, expect, it } from "vitest";
import { formatMinutes, parseDurationMinutes } from "./duration.ts";

describe("parseDurationMinutes", () => {
	it.each([
		["30m", 30],
		["90 min", 90],
		["45 minutes", 45],
		["1h", 60],
		["an hour", 60],
		["2 hours", 120],
		["2h30", 150],
		["2h 30m", 150],
		["2H30M", 150],
		["1 day", 1440],
		["a day", 1440],
		["3 days", 4320],
		["1 week", 10080],
		["2 weeks", 20160],
		["  8   hours ", 480],
	])("reads %j", (typed, minutes) => {
		expect(parseDurationMinutes(typed)).toBe(minutes);
	});

	it.each(["", "0m", "2h60", "soon", "2", "h", "1.5h", "-1h", "3 fortnights", "a", "1h 2d"])(
		"refuses %j",
		(typed) => {
			expect(parseDurationMinutes(typed)).toBeUndefined();
		},
	);
});

describe("formatMinutes", () => {
	it.each([
		[0, "0m"],
		[30, "30m"],
		[60, "1h"],
		[125, "2h05"],
		[1440, "1 day"],
		[4320, "3 days"],
		[10080, "1 week"],
		[20160, "2 weeks"],
		[1500, "25h"],
	])("writes %i minutes as %j", (minutes, text) => {
		expect(formatMinutes(minutes)).toBe(text);
	});

	it("writes what it reads", () => {
		for (const text of ["30m", "2h05", "1 day", "2 weeks"]) {
			expect(formatMinutes(parseDurationMinutes(text) as number)).toBe(text);
		}
	});
});
