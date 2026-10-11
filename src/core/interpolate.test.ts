import { describe, expect, it } from "vitest";
import { escapeMarkdown } from "./format.ts";
import {
	createInterpolator,
	dateTokens,
	InterpolateError,
	Interpolator,
	interpolateChannelPost,
} from "./interpolate.ts";

const AMS = "Europe/Amsterdam";
/** Sunday 11 October 2026, 06:54 in Amsterdam (CEST). */
const SUNDAY = new Date("2026-10-11T04:54:00.000Z");
/** Sunday 11 January 2026, 11:00 in Amsterdam (CET). */
const WINTER = new Date("2026-01-11T10:00:00.000Z");

function interpolator(now: Date = SUNDAY, timezone = AMS) {
	return createInterpolator({ timezone, now: () => now });
}

describe("date tokens", () => {
	it("fills the date family at the given instant in Amsterdam", () => {
		const fill = interpolator(SUNDAY);
		expect(fill.interpolate("{{date}}")).toBe("11 October 2026");
		expect(fill.interpolate("{{day}}")).toBe("Sunday");
		expect(fill.interpolate("{{month}}")).toBe("October");
		expect(fill.interpolate("{{year}}")).toBe("2026");
		expect(fill.interpolate("{{dateWithTime}}")).toBe("11 October 2026, 06:54 CEST");
	});

	it("uses winter time when the clocks have gone back", () => {
		expect(interpolator(WINTER).interpolate("{{dateWithTime}}")).toBe("11 January 2026, 11:00 CET");
		expect(interpolator(WINTER).interpolate("{{day}} {{date}}")).toBe("Sunday 11 January 2026");
	});

	it("uses the instant passed to interpolate, not the clock it was built with", () => {
		const fill = interpolator(SUNDAY);
		expect(fill.interpolate("{{date}}", WINTER)).toBe("11 January 2026");
	});

	it("uses the configured time zone, not the host's", () => {
		expect(interpolator(SUNDAY, "UTC").interpolate("{{dateWithTime}}")).toBe(
			"11 October 2026, 04:54 UTC",
		);
	});

	it("lists the built-in names", () => {
		expect(interpolator().names()).toEqual(["date", "day", "month", "year", "dateWithTime"]);
		expect(dateTokens().map((t) => t.name)).toEqual([
			"date",
			"day",
			"month",
			"year",
			"dateWithTime",
		]);
	});
});

describe("interpolate", () => {
	it("fills every occurrence, and trims spaces inside the braces", () => {
		expect(interpolator().interpolate("On {{ date }} ({{date}}) — {{ day }}")).toBe(
			"On 11 October 2026 (11 October 2026) — Sunday",
		);
	});

	it("leaves an unknown token as written, including empty and expressions", () => {
		const fill = interpolator();
		expect(fill.interpolate("see {{unknown}} and {{spaceState}}")).toBe(
			"see {{unknown}} and {{spaceState}}",
		);
		expect(fill.interpolate("{{}} {{ date + 1 }} {{constructor}} {{DATE}}")).toBe(
			"{{}} {{ date + 1 }} {{constructor}} {{DATE}}",
		);
	});

	it("leaves a stray {{ or }} alone", () => {
		expect(interpolator().interpolate("keep {{ and }} and {{date}}")).toBe(
			"keep {{ and }} and 11 October 2026",
		);
	});

	it("does not treat token values as templates", () => {
		const fill = new Interpolator({
			timezone: AMS,
			now: () => SUNDAY,
			tokens: [
				{
					name: "nested",
					resolve: () => "look {{date}}",
				},
			],
		});
		expect(fill.interpolate("{{nested}}")).toBe("look {{date}}");
	});

	it("lets a later token be registered, and refuses a duplicate or a bad name", () => {
		const fill = interpolator();
		fill.register({ name: "spaceState", resolve: () => "open" });
		expect(fill.interpolate("The space is {{spaceState}} on {{day}}.")).toBe(
			"The space is open on Sunday.",
		);
		expect(() => fill.register({ name: "date", resolve: () => "nope" })).toThrow(InterpolateError);
		expect(() => fill.register({ name: "space-state", resolve: () => "x" })).toThrow(
			/simple identifier/,
		);
		expect(() => fill.register({ name: "date + 1", resolve: () => "x" })).toThrow(InterpolateError);
	});
});

describe("escapeMarkdown after interpolate", () => {
	it("escapes user markup once and leaves a date readable", () => {
		const filled = interpolator().interpolate("Please tidy **before** {{date}}");
		expect(filled).toBe("Please tidy **before** 11 October 2026");
		expect(escapeMarkdown(filled)).toBe("Please tidy \\*\\*before\\*\\* 11 October 2026");
	});
});

describe("interpolateChannelPost", () => {
	it("fills a message body", () => {
		const fill = interpolator();
		expect(
			interpolateChannelPost({ kind: "message", text: "Open {{day}}", mentions: false }, (t) =>
				fill.interpolate(t),
			),
		).toEqual({ kind: "message", text: "Open Sunday", mentions: false });
	});

	it("fills a poll question and every answer", () => {
		const fill = interpolator();
		expect(
			interpolateChannelPost(
				{
					kind: "poll",
					question: "Open {{date}}?",
					answers: ["Yes {{day}}", "No"],
					durationHours: 24,
					multiple: false,
				},
				(t) => fill.interpolate(t),
			),
		).toEqual({
			kind: "poll",
			question: "Open 11 October 2026?",
			answers: ["Yes Sunday", "No"],
			durationHours: 24,
			multiple: false,
		});
	});
});
