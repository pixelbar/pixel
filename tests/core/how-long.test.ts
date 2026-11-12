import { describe, expect, it } from "vitest";
import { readHowLong } from "../../src/core/how-long.ts";

const AMS = "Europe/Amsterdam";
// Monday 12 October 2026, 10:00 in Amsterdam.
const NOW = new Date("2026-10-12T08:00:00Z");
const at = (iso: string) => new Date(iso);

const length = (typed: string, start = NOW, now?: Date) => {
	const read = readHowLong(typed, start, AMS, now ? { now } : {});
	return read.ok ? read.value : read.problem;
};

describe("readHowLong", () => {
	it("reads a duration, with or without for", () => {
		expect(length("45m")).toEqual({ end: at("2026-10-12T08:45:00Z"), minutes: 45, by: "duration" });
		expect(length("2h30")).toMatchObject({ minutes: 150, by: "duration" });
		expect(length("for 2 hours")).toMatchObject({ minutes: 120, by: "duration" });
		expect(length("For  an hour")).toMatchObject({ minutes: 60, by: "duration" });
		expect(length("1 day")).toMatchObject({ minutes: 1440, by: "duration" });
	});

	it("reads when it ends, with until, till, til, to or nothing", () => {
		const five = { end: at("2026-10-12T15:00:00Z"), minutes: 420, by: "end" };
		for (const typed of ["until 17:00", "till 5pm", "Til 5pm", "to 17:00", "17:00", "1700"]) {
			expect(length(typed)).toEqual(five);
		}
		expect(length("until tomorrow 8")).toMatchObject({ minutes: 1320, by: "end" });
		expect(length("until fri")).toMatchObject({ end: at("2026-10-16T17:00:00Z"), by: "end" });
		expect(length("until in 2 hours")).toMatchObject({ minutes: 120, by: "end" });
	});

	it("rounds a part minute up, so the end it shows is the end it keeps", () => {
		const start = new Date("2026-10-12T08:00:30Z");
		expect(length("until 10:30", start)).toMatchObject({ minutes: 30, by: "end" });
	});

	it("reads an end after a later start, with now still the real now", () => {
		const tomorrow = new Date("2026-10-13T08:00:00Z");
		expect(length("until 17:00", tomorrow, NOW)).toMatchObject({
			end: at("2026-10-13T15:00:00Z"),
			minutes: 420,
		});
		expect(length("2h", tomorrow, NOW)).toMatchObject({ end: at("2026-10-13T10:00:00Z") });
		// Two hours from now is before it starts.
		expect(length("until now+2h", tomorrow, NOW)).toEqual({
			kind: "before-start",
			at: { year: 2026, month: 10, day: 12, hour: 12, minute: 0 },
		});
	});

	it("says why it can't use what was typed", () => {
		expect(length(" ")).toEqual({ kind: "empty" });
		expect(length("ages")).toEqual({ kind: "unclear" });
		expect(length("until")).toEqual({ kind: "unclear" });
		expect(length("until morning")).toEqual({ kind: "vague", word: "morning" });
		expect(length("until 31 feb")).toMatchObject({ kind: "no-such-date" });
		// From now, an end that has gone has passed.
		expect(length("until today 9")).toMatchObject({ kind: "past" });
	});
});
