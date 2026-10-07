import { describe, expect, it } from "vitest";
import {
	daysInMonth,
	describeRecurrence,
	formatLocal,
	type LocalDateTime,
	listDays,
	nextOccurrence,
	parseLocal,
	type Recurrence,
	toInstant,
	toLocal,
	weekdayOf,
} from "./recurrence.ts";

const AMS = "Europe/Amsterdam";
const at = (iso: string) => new Date(iso);
const local = (text: string) => parseLocal(text) as LocalDateTime;

/** Every occurrence from `after`, in Amsterdam wall time, as "YYYY-MM-DDTHH:MM". */
function series(start: string, recurrence: Recurrence, after: string, count: number): string[] {
	const out: string[] = [];
	let from = at(after);
	for (let i = 0; i < count; i++) {
		const next = nextOccurrence(local(start), recurrence, AMS, from);
		if (!next) break;
		out.push(formatLocal(toLocal(next, AMS)));
		from = next;
	}
	return out;
}

describe("local dates and times", () => {
	it("read and write the canonical form, and refuse impossible dates", () => {
		expect(parseLocal("2026-10-14T19:05")).toEqual({
			year: 2026,
			month: 10,
			day: 14,
			hour: 19,
			minute: 5,
		});
		expect(formatLocal(local("2026-01-02T03:04"))).toBe("2026-01-02T03:04");
		for (const bad of [
			"2026-02-30T10:00",
			"2026-13-01T10:00",
			"2026-10-14T24:00",
			"2026-10-14T19:60",
			"14-10-2026 19:00",
			"",
		]) {
			expect(parseLocal(bad)).toBeUndefined();
		}
		expect(parseLocal("2028-02-29T10:00")).toBeDefined();
	});

	it("know the weekday and the length of a month", () => {
		expect(weekdayOf({ year: 2026, month: 10, day: 14 })).toBe("wed");
		expect(weekdayOf({ year: 2026, month: 10, day: 18 })).toBe("sun");
		expect(daysInMonth(2026, 2)).toBe(28);
		expect(daysInMonth(2028, 2)).toBe(29);
		expect(daysInMonth(2026, 12)).toBe(31);
	});
});

describe("wall-clock time in a zone", () => {
	it("is UTC+2 in summer and UTC+1 in winter in Amsterdam", () => {
		expect(toInstant(local("2026-07-01T19:00"), AMS).toISOString()).toBe(
			"2026-07-01T17:00:00.000Z",
		);
		expect(toInstant(local("2026-12-01T19:00"), AMS).toISOString()).toBe(
			"2026-12-01T18:00:00.000Z",
		);
		expect(toLocal(at("2026-12-01T18:00:00Z"), AMS)).toEqual(local("2026-12-01T19:00"));
	});

	it("moves a time skipped when the clocks go forward to just after the gap", () => {
		// 29 March 2026: 02:00 jumps to 03:00 in Amsterdam.
		expect(toInstant(local("2026-03-29T02:30"), AMS).toISOString()).toBe(
			"2026-03-29T01:30:00.000Z",
		);
		expect(formatLocal(toLocal(toInstant(local("2026-03-29T02:30"), AMS), AMS))).toBe(
			"2026-03-29T03:30",
		);
	});

	it("takes the first of a time that happens twice when the clocks go back", () => {
		// 25 October 2026: 03:00 goes back to 02:00, so 02:30 happens twice.
		expect(toInstant(local("2026-10-25T02:30"), AMS).toISOString()).toBe(
			"2026-10-25T00:30:00.000Z",
		);
	});

	it("works in a zone without clock changes", () => {
		expect(toInstant(local("2026-07-01T19:00"), "UTC").toISOString()).toBe(
			"2026-07-01T19:00:00.000Z",
		);
	});
});

describe("nextOccurrence", () => {
	it("happens once, and never again after", () => {
		const once: Recurrence = { kind: "once" };
		expect(series("2026-10-14T19:00", once, "2026-10-01T00:00Z", 3)).toEqual(["2026-10-14T19:00"]);
		expect(
			nextOccurrence(local("2026-10-14T19:00"), once, AMS, at("2026-10-14T17:00Z")),
		).toBeUndefined();
	});

	it("repeats every Wednesday and Saturday, at the same wall-clock time through the clock change", () => {
		const weekly: Recurrence = { kind: "weekly", everyWeeks: 1, days: ["wed", "sat"] };
		expect(series("2026-10-14T19:00", weekly, "2026-10-01T00:00Z", 6)).toEqual([
			"2026-10-14T19:00",
			"2026-10-17T19:00",
			"2026-10-21T19:00",
			"2026-10-24T19:00",
			"2026-10-28T19:00",
			"2026-10-31T19:00",
		]);
		// The instant moves by an hour when the clocks go back; the wall time doesn't.
		expect(
			nextOccurrence(
				local("2026-10-14T19:00"),
				weekly,
				AMS,
				at("2026-10-25T00:00Z"),
			)?.toISOString(),
		).toBe("2026-10-28T18:00:00.000Z");
	});

	it("starts on the first listed day on or after the start", () => {
		// A Monday start for a Wednesday-and-Saturday repeat begins that Wednesday.
		const weekly: Recurrence = { kind: "weekly", everyWeeks: 1, days: ["wed", "sat"] };
		expect(series("2026-10-12T19:00", weekly, "2026-10-01T00:00Z", 2)).toEqual([
			"2026-10-14T19:00",
			"2026-10-17T19:00",
		]);
	});

	it("repeats every other week, counted from the start's week", () => {
		const fortnightly: Recurrence = { kind: "weekly", everyWeeks: 2, days: ["wed", "sat"] };
		expect(series("2026-10-14T19:00", fortnightly, "2026-10-01T00:00Z", 6)).toEqual([
			"2026-10-14T19:00",
			"2026-10-17T19:00",
			"2026-10-28T19:00",
			"2026-10-31T19:00",
			"2026-11-11T19:00",
			"2026-11-14T19:00",
		]);
	});

	it("finds the next one from any point, not just from the start", () => {
		const weekly: Recurrence = { kind: "weekly", everyWeeks: 2, days: ["wed"] };
		expect(series("2026-01-07T19:00", weekly, "2026-10-15T00:00Z", 2)).toEqual([
			"2026-10-28T19:00",
			"2026-11-11T19:00",
		]);
	});

	it("goes on to the next occurrence once one has passed, including later the same day", () => {
		const weekly: Recurrence = { kind: "weekly", everyWeeks: 1, days: ["wed"] };
		expect(series("2026-10-14T19:00", weekly, "2026-10-14T17:00Z", 1)).toEqual([
			"2026-10-21T19:00",
		]);
		expect(series("2026-10-14T19:00", weekly, "2026-10-14T16:59Z", 1)).toEqual([
			"2026-10-14T19:00",
		]);
	});

	it("never happens with no days", () => {
		expect(
			nextOccurrence(
				local("2026-10-14T19:00"),
				{ kind: "weekly", everyWeeks: 1, days: [] },
				AMS,
				at("2026-10-01T00:00Z"),
			),
		).toBeUndefined();
	});

	it("repeats monthly on the start's day, using a shorter month's last day", () => {
		const monthly: Recurrence = { kind: "monthly", everyMonths: 1 };
		expect(series("2026-01-31T09:00", monthly, "2026-01-01T00:00Z", 5)).toEqual([
			"2026-01-31T09:00",
			"2026-02-28T09:00",
			"2026-03-31T09:00",
			"2026-04-30T09:00",
			"2026-05-31T09:00",
		]);
	});

	it("repeats every other month", () => {
		const every2: Recurrence = { kind: "monthly", everyMonths: 2 };
		expect(series("2026-10-14T19:00", every2, "2026-10-01T00:00Z", 4)).toEqual([
			"2026-10-14T19:00",
			"2026-12-14T19:00",
			"2027-02-14T19:00",
			"2027-04-14T19:00",
		]);
		// From well into the run, it stays on the right months.
		expect(series("2026-10-14T19:00", every2, "2027-03-01T00:00Z", 1)).toEqual([
			"2027-04-14T19:00",
		]);
	});
});

describe("describing a repeat", () => {
	it("says it in plain words", () => {
		const start = local("2026-10-14T19:00");
		expect(describeRecurrence(start, { kind: "once" })).toBe("once, at 19:00");
		expect(describeRecurrence(start, { kind: "weekly", everyWeeks: 1, days: ["sat", "wed"] })).toBe(
			"every Wednesday and Saturday at 19:00",
		);
		expect(
			describeRecurrence(start, { kind: "weekly", everyWeeks: 2, days: ["mon", "wed", "fri"] }),
		).toBe("every other week on Monday, Wednesday and Friday at 19:00");
		expect(describeRecurrence(start, { kind: "monthly", everyMonths: 1 })).toBe(
			"every month on the 14th at 19:00",
		);
		expect(describeRecurrence(local("2026-10-01T08:05"), { kind: "monthly", everyMonths: 2 })).toBe(
			"every other month on the 1st at 08:05",
		);
		expect(
			describeRecurrence(local("2026-10-22T08:05"), { kind: "monthly", everyMonths: 1 }),
		).toContain("22nd");
		expect(
			describeRecurrence(local("2026-10-23T08:05"), { kind: "monthly", everyMonths: 1 }),
		).toContain("23rd");
		expect(
			describeRecurrence(local("2026-10-11T08:05"), { kind: "monthly", everyMonths: 1 }),
		).toContain("11th");
		expect(listDays(["wed"])).toBe("Wednesday");
		expect(listDays([])).toBe("");
	});
});
