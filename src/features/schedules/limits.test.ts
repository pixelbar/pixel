import { describe, expect, it } from "vitest";
import type { ChannelPost } from "../../core/channel-posts.ts";
import { UserFacingError } from "../../core/errors.ts";
import { createInterpolator } from "../../core/interpolate.ts";
import type { LocalDateTime, Recurrence } from "../../core/recurrence.ts";
import { checkFilledLength, clipToLimits, overLimit } from "./limits.ts";

const AMS = "Europe/Amsterdam";
// Mon 12 Oct 2026, 10:00 in Amsterdam.
const NOW = new Date("2026-10-12T08:00:00Z");
const interpolator = createInterpolator({ timezone: AMS, now: () => NOW });
const WED_19: LocalDateTime = { year: 2026, month: 10, day: 14, hour: 19, minute: 0 };
const ONCE: Recurrence = { kind: "once" };

const message = (text: string): ChannelPost => ({ kind: "message", text, mentions: false });
const poll = (question: string, answers: string[]): ChannelPost => ({
	kind: "poll",
	question,
	answers,
	durationHours: 24,
	multiple: false,
});
const check = (post: ChannelPost, start = WED_19, recurrence: Recurrence = ONCE) =>
	checkFilledLength(post, { start, recurrence }, AMS, NOW, interpolator);

describe("overLimit", () => {
	it("is nothing when everything fits, and names what's too long", () => {
		expect(overLimit(message("x".repeat(2000)))).toBeUndefined();
		expect(overLimit(message("x".repeat(2001)))).toMatch(/message .* 2000-character/);
		expect(overLimit(poll("x".repeat(300), ["a", "x".repeat(55)]))).toBeUndefined();
		expect(overLimit(poll("x".repeat(301), ["a", "b"]))).toMatch(/question .* 300-character/);
		expect(overLimit(poll("q", ["a", "x".repeat(56)]))).toMatch(/answer .* 55-character/);
	});

	it("counts characters, not UTF-16 units", () => {
		expect(overLimit(poll("q", ["a", "🍕".repeat(55)]))).toBeUndefined();
	});
});

describe("checkFilledLength", () => {
	it("accepts a post that still fits once its tokens are filled", () => {
		// "{{date}}" (8) becomes "14 October 2026" (15).
		expect(() => check(message(`${"x".repeat(1985)}{{date}}`))).not.toThrow();
	});

	it("refuses a message that only goes over the limit once tokens are filled, without echoing it", () => {
		const text = `${"x".repeat(1986)}{{date}}`;
		expect(() => check(message(text))).toThrow(UserFacingError);
		expect(() => check(message(text))).toThrow(
			/tokens filled in, the message would be over Discord's 2000-character limit on Wed 14 Oct 2026, 19:00/,
		);
		try {
			check(message(text));
		} catch (error) {
			expect((error as Error).message).not.toContain("xxxx");
		}
	});

	it("refuses a poll question or answer pushed over its limit", () => {
		// "{{dateWithTime}}" (16) becomes "14 October 2026, 19:00 CEST" (27).
		expect(() => check(poll(`${"x".repeat(290)}{{dateWithTime}}`, ["a", "b"]))).toThrow(
			/question would be over/,
		);
		expect(() => check(poll("q", ["a", `${"x".repeat(29)}{{dateWithTime}}`]))).toThrow(
			/answer would be over/,
		);
		expect(() => check(poll("q", ["a", `${"x".repeat(28)}{{dateWithTime}}`]))).not.toThrow();
	});

	it("checks later occurrences too, where a longer month name can push it over", () => {
		// Monthly from 14 October: "14 October 2026" (15) fits, "14 November 2026" (16) doesn't.
		const text = `${"x".repeat(1985)}{{date}}`;
		const monthly: Recurrence = { kind: "monthly", everyMonths: 1 };
		expect(() => check(message(text), WED_19, monthly)).toThrow(/Sat 14 Nov 2026/);
	});

	it("checks as of now when there's no occurrence left", () => {
		const past: LocalDateTime = { ...WED_19, day: 1 };
		// Monday 12 October 2026 as "{{date}}" is 15 characters, like the 14th.
		expect(() => check(message(`${"x".repeat(1985)}{{date}}`), past)).not.toThrow();
		expect(() => check(message(`${"x".repeat(1986)}{{date}}`), past)).toThrow(
			/Mon 12 Oct 2026, 10:00/,
		);
	});
});

describe("clipToLimits", () => {
	it("leaves a post that fits alone", () => {
		const post = message("Hello");
		expect(clipToLimits(post)).toEqual({ post, clipped: false });
	});

	it("cuts a message to the limit, ending in an ellipsis", () => {
		const { post, clipped } = clipToLimits(message("x".repeat(2010)));
		expect(clipped).toBe(true);
		expect(post.kind === "message" && [...post.text].length).toBe(2000);
		expect(post.kind === "message" && post.text.endsWith("x…")).toBe(true);
	});

	it("cuts a poll's question and long answers, and leaves the rest", () => {
		const { post, clipped } = clipToLimits(poll("q".repeat(310), ["Yes", "🍕".repeat(60)]));
		expect(clipped).toBe(true);
		expect(post).toEqual(poll(`${"q".repeat(299)}…`, ["Yes", `${"🍕".repeat(54)}…`]));
	});
});
