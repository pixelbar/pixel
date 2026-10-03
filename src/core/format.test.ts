import { describe, expect, it } from "vitest";
import { escapeMarkdown, formatUntil, isValidTimeZone } from "./format.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("formatUntil", () => {
	it.each([
		[0, "starting now"],
		[59_999, "starting now"],
		[MINUTE, "in 1m"],
		[25 * MINUTE, "in 25m"],
		[59 * MINUTE + 59_000, "in 59m"],
		[HOUR, "in 1h"],
		[3 * HOUR + 20 * MINUTE, "in 3h 20m"],
		[23 * HOUR + 59 * MINUTE, "in 23h 59m"],
		[DAY, "in 1 day"],
		[DAY + 23 * HOUR, "in 1 day"],
		[2 * DAY, "in 2 days"],
		[9 * DAY + HOUR, "in 9 days"],
	])("%i ms → %s", (ms, expected) => {
		expect(formatUntil(ms)).toBe(expected);
	});
});

describe("isValidTimeZone", () => {
	it.each(["Europe/Amsterdam", "UTC", "America/New_York", "Asia/Kolkata"])("accepts %s", (zone) => {
		expect(isValidTimeZone(zone)).toBe(true);
	});

	it.each(["", "Amsterdam", "Europe/Atlantis", "not a zone", "CEST+2"])("rejects %j", (zone) => {
		expect(isValidTimeZone(zone)).toBe(false);
	});
});

describe("escapeMarkdown", () => {
	it("leaves ordinary text alone", () => {
		expect(escapeMarkdown("Soldering workshop, 2nd edition!")).toBe(
			"Soldering workshop, 2nd edition!",
		);
	});

	it("stops text being read as formatting, links or mention markers", () => {
		expect(escapeMarkdown("**bold** _it_ ~~x~~ `code` ||spoiler||")).toBe(
			"\\*\\*bold\\*\\* \\_it\\_ \\~\\~x\\~\\~ \\`code\\` \\|\\|spoiler\\|\\|",
		);
		expect(escapeMarkdown("[click](https://evil.example)")).toBe(
			"\\[click\\](https://evil.example)",
		);
		expect(escapeMarkdown("<@123> <#456> <t:1:R>")).toBe("\\<@123\\> \\<#456\\> \\<t:1:R\\>");
		expect(escapeMarkdown("> quote")).toBe("\\> quote");
		expect(escapeMarkdown("back\\slash")).toBe("back\\\\slash");
	});

	it("turns line breaks and runs of spaces into single spaces, and trims", () => {
		expect(escapeMarkdown("  one\n\ntwo \t three  ")).toBe("one two three");
	});
});
