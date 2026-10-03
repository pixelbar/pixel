import { describe, expect, it, vi } from "vitest";
import {
	Calendar,
	type CalendarEvent,
	type CalendarSource,
	CalendarUnavailableError,
} from "./calendar.ts";
import { silentLogger } from "./logger.ts";
import type { ErrorReporter } from "./ports/error-reporter.ts";

const event = (id: string, title = `Event ${id}`): CalendarEvent => ({
	id,
	title,
	startsAt: new Date("2026-10-04T18:00:00Z"),
	endsAt: null,
	location: null,
	url: `https://discord.com/events/1/${id}`,
	repeats: null,
});

/** A source whose answers are scripted: events to return, or an error to throw. */
function setup() {
	const reporter = {
		capture: vi.fn(),
		captureBackground: vi.fn<ErrorReporter["captureBackground"]>(),
	};
	const calendar = new Calendar({ logger: silentLogger, reporter });
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

	describe("never serves anything out of date", () => {
		it("asks the source every time, so a renamed event shows its new name straight away", async () => {
			const { calendar, source, answer } = setup();
			answer([event("a", "Soldering workshop")], [event("a", "Soldering night")]);

			expect((await calendar.events())[0]?.title).toBe("Soldering workshop");
			expect((await calendar.events())[0]?.title).toBe("Soldering night");
			expect(source.upcoming).toHaveBeenCalledTimes(2);
		});

		it("doesn't reuse a recent list, however close together the calls are", async () => {
			const { calendar, source, answer } = setup();
			answer([event("a")], [event("a")], [event("a")]);
			await calendar.events();
			await calendar.events();
			await calendar.events();
			expect(source.upcoming).toHaveBeenCalledTimes(3);
		});

		it("gives an error rather than an earlier list when the source then fails", async () => {
			const { calendar, answer } = setup();
			answer([event("a")], new Error("Discord is down"));
			await calendar.events();
			await expect(calendar.events()).rejects.toThrow(CalendarUnavailableError);
		});
	});

	describe("when the source fails", () => {
		it("is unavailable, with the cause kept for the logs", async () => {
			const { calendar, answer } = setup();
			const boom = new Error("Discord is down");
			answer(boom);
			const error = await calendar.events().catch((e: unknown) => e);
			expect(error).toBeInstanceOf(CalendarUnavailableError);
			expect((error as Error).cause).toBe(boom);
		});

		it("recovers as soon as the source does", async () => {
			const { calendar, answer } = setup();
			answer(new Error("Discord is down"), [event("a")]);
			await expect(calendar.events()).rejects.toThrow(CalendarUnavailableError);
			expect((await calendar.events()).map((e) => e.id)).toEqual(["a"]);
		});

		it("reports an outage once, not on every failed command, and again after recovering", async () => {
			const { calendar, reporter, answer } = setup();
			const down = new Error("Discord is down");
			answer(down, down, down, [event("a")], down);
			for (let i = 0; i < 3; i++) await calendar.events().catch(() => {});
			expect(reporter.captureBackground).toHaveBeenCalledOnce();
			expect(reporter.captureBackground).toHaveBeenCalledWith(down, "calendar");

			await calendar.events(); // recovers
			await calendar.events().catch(() => {});
			expect(reporter.captureBackground).toHaveBeenCalledTimes(2);
		});
	});
});
