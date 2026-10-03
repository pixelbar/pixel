import { describe, expect, it, vi } from "vitest";
import {
	Calendar,
	type CalendarEvent,
	type CalendarSource,
	CalendarUnavailableError,
} from "./calendar.ts";
import { silentLogger } from "./logger.ts";
import type { ErrorReporter } from "./ports/error-reporter.ts";

const event = (id: string): CalendarEvent => ({
	id,
	title: `Event ${id}`,
	startsAt: new Date("2026-10-04T18:00:00Z"),
	endsAt: null,
	location: null,
	url: `https://discord.com/events/1/${id}`,
	repeats: null,
});

/** A source whose answers are scripted: events to return, or an error to throw. */
function setup() {
	let now = 1_000_000;
	const reporter = {
		capture: vi.fn(),
		captureBackground: vi.fn<ErrorReporter["captureBackground"]>(),
	};
	const calendar = new Calendar({
		logger: silentLogger,
		reporter,
		now: () => now,
		ttlMs: 60_000,
		maxStaleMs: 600_000,
	});
	const answers: (CalendarEvent[] | Error)[] = [];
	const source = {
		upcoming: vi.fn(async () => {
			const next = answers.shift();
			if (!next) throw new Error("unexpected load");
			if (next instanceof Error) throw next;
			return next;
		}),
	} satisfies CalendarSource;
	calendar.use(source);
	return {
		calendar,
		source,
		reporter,
		answer: (...next: (CalendarEvent[] | Error)[]) => answers.push(...next),
		advance: (ms: number) => {
			now += ms;
		},
	};
}

describe("Calendar", () => {
	it("is unavailable until a source is plugged in", async () => {
		const calendar = new Calendar({
			logger: silentLogger,
			reporter: { capture() {}, captureBackground() {} },
		});
		await expect(calendar.events()).rejects.toThrow(CalendarUnavailableError);
	});

	it("only takes one source", () => {
		const { calendar, source } = setup();
		expect(() => calendar.use(source)).toThrow(/already has a source/);
	});

	it("returns the source's events", async () => {
		const { calendar, answer } = setup();
		answer([event("a"), event("b")]);
		expect((await calendar.events()).map((e) => e.id)).toEqual(["a", "b"]);
	});

	describe("caching", () => {
		it("reuses a fresh list instead of asking again", async () => {
			const { calendar, source, answer, advance } = setup();
			answer([event("a")]);
			await calendar.events();
			advance(59_999);
			await calendar.events();
			expect(source.upcoming).toHaveBeenCalledOnce();
		});

		it("asks again once the list is no longer fresh", async () => {
			const { calendar, source, answer, advance } = setup();
			answer([event("a")], [event("b")]);
			await calendar.events();
			advance(60_000);
			expect((await calendar.events()).map((e) => e.id)).toEqual(["b"]);
			expect(source.upcoming).toHaveBeenCalledTimes(2);
		});

		it("shares one request between overlapping calls", async () => {
			const { calendar, source, answer } = setup();
			answer([event("a")]);
			const [first, second] = await Promise.all([calendar.events(), calendar.events()]);
			expect(first).toBe(second);
			expect(source.upcoming).toHaveBeenCalledOnce();
		});
	});

	describe("when the source fails", () => {
		it("is unavailable if there's nothing earlier to fall back on", async () => {
			const { calendar, answer } = setup();
			const boom = new Error("Discord is down");
			answer(boom);
			const error = await calendar.events().catch((e: unknown) => e);
			expect(error).toBeInstanceOf(CalendarUnavailableError);
			expect((error as Error).cause).toBe(boom);
		});

		it("shows an earlier list that's recent enough", async () => {
			const { calendar, answer, advance } = setup();
			answer([event("a")], new Error("Discord is down"));
			await calendar.events();
			advance(600_000);
			expect((await calendar.events()).map((e) => e.id)).toEqual(["a"]);
		});

		it("gives up on an earlier list that's too old", async () => {
			const { calendar, answer, advance } = setup();
			answer([event("a")], new Error("Discord is down"));
			await calendar.events();
			advance(600_001);
			await expect(calendar.events()).rejects.toThrow(CalendarUnavailableError);
		});

		it("reports an outage once, not on every failed load, and again after recovering", async () => {
			const { calendar, reporter, answer, advance } = setup();
			const down = new Error("Discord is down");
			answer(down, down, [event("a")], down);
			for (let i = 0; i < 2; i++) {
				await calendar.events().catch(() => {});
				advance(60_000);
			}
			expect(reporter.captureBackground).toHaveBeenCalledOnce();
			expect(reporter.captureBackground).toHaveBeenCalledWith(down, "calendar");

			await calendar.events(); // recovers
			advance(60_000);
			await calendar.events().catch(() => {});
			expect(reporter.captureBackground).toHaveBeenCalledTimes(2);
		});
	});
});
