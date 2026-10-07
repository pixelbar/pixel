/**
 * When scheduled posts happen. Everything is wall-clock time in one time zone
 * (`PIXEL_TIMEZONE`), so "every Wednesday at 19:00" stays 19:00 through the clock
 * changes. Pure functions, no timers.
 */

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const WEEKDAY_NAMES: Record<Weekday, string> = {
	mon: "Monday",
	tue: "Tuesday",
	wed: "Wednesday",
	thu: "Thursday",
	fri: "Friday",
	sat: "Saturday",
	sun: "Sunday",
};

/** A date and time on the wall clock, with no zone: "2026-10-14T19:00". */
export type LocalDateTime = {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
};

export type Recurrence =
	| { kind: "once" }
	/** On these days, every week or every other week (counted from the start's week). */
	| { kind: "weekly"; everyWeeks: 1 | 2; days: readonly Weekday[] }
	/** On the start's day of the month (or the month's last day), every month or every other month. */
	| { kind: "monthly"; everyMonths: 1 | 2 };

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

export function formatLocal(t: LocalDateTime): string {
	return `${pad(t.year, 4)}-${pad(t.month)}-${pad(t.day)}T${pad(t.hour)}:${pad(t.minute)}`;
}

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** Reads "2026-10-14T19:00", or undefined if it isn't a real date and time. */
export function parseLocal(text: string): LocalDateTime | undefined {
	const match = LOCAL.exec(text);
	if (!match) return undefined;
	const [year, month, day, hour, minute] = match.slice(1).map(Number) as [
		number,
		number,
		number,
		number,
		number,
	];
	if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return undefined;
	if (hour > 23 || minute > 59) return undefined;
	return { year, month, day, hour, minute };
}

export function daysInMonth(year: number, month: number): number {
	return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Day of the week of a calendar date. */
export function weekdayOf(t: Pick<LocalDateTime, "year" | "month" | "day">): Weekday {
	// getUTCDay: 0 = Sunday.
	return WEEKDAYS[(new Date(Date.UTC(t.year, t.month - 1, t.day)).getUTCDay() + 6) % 7] as Weekday;
}

/** Days since 1970-01-01 for a calendar date: for counting days and weeks. */
const dayNumber = (t: Pick<LocalDateTime, "year" | "month" | "day">) =>
	Math.floor(Date.UTC(t.year, t.month - 1, t.day) / 86_400_000);

const fromDayNumber = (n: number) => {
	const d = new Date(n * 86_400_000);
	return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
};

/** The wall-clock date and time in `zone` at an instant. */
export function toLocal(instant: Date, zone: string): LocalDateTime {
	const parts = new Intl.DateTimeFormat("en-GB", {
		timeZone: zone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).formatToParts(instant);
	const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
	return {
		year: get("year"),
		month: get("month"),
		day: get("day"),
		hour: get("hour"),
		minute: get("minute"),
	};
}

/**
 * The instant a wall-clock time happens in `zone`. A time that doesn't exist (skipped
 * when the clocks go forward) moves on by the gap; a time that happens twice (when
 * they go back) is the first one.
 */
export function toInstant(t: LocalDateTime, zone: string): Date {
	const asUtc = Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute);
	const offsetAt = (ms: number) => {
		const local = toLocal(new Date(ms), zone);
		return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) - ms;
	};
	// The zone's offset a day before and a day after: they differ only around a change.
	const before = offsetAt(asUtc - 86_400_000);
	const after = offsetAt(asUtc + 86_400_000);
	const matches = [asUtc - before, asUtc - after].filter((ms) => {
		const local = toLocal(new Date(ms), zone);
		return local.hour === t.hour && local.minute === t.minute && local.day === t.day;
	});
	// Happens twice: the first. Doesn't happen: as if the clocks hadn't changed yet, which
	// lands just after the gap.
	return new Date(matches.length > 0 ? Math.min(...matches) : asUtc - before);
}

/**
 * The first time the schedule happens strictly after `after`, or undefined if it
 * never will again (a one-off that has passed, or a weekly one with no days).
 */
export function nextOccurrence(
	start: LocalDateTime,
	recurrence: Recurrence,
	zone: string,
	after: Date,
): Date | undefined {
	const at = (date: { year: number; month: number; day: number }) =>
		toInstant({ ...date, hour: start.hour, minute: start.minute }, zone);
	const startInstant = at(start);

	if (recurrence.kind === "once") return startInstant > after ? startInstant : undefined;

	if (recurrence.kind === "weekly") {
		if (recurrence.days.length === 0) return undefined;
		const startDay = dayNumber(start);
		const startWeek = Math.floor((startDay + 3) / 7); // weeks start on Monday (1970-01-01 was a Thursday)
		const fromDay = Math.max(startDay, dayNumber(toLocal(after, zone)) - 1);
		for (let n = fromDay; n < fromDay + 7 * recurrence.everyWeeks * 2 + 7; n++) {
			const date = fromDayNumber(n);
			if (!recurrence.days.includes(weekdayOf(date))) continue;
			if ((Math.floor((n + 3) / 7) - startWeek) % recurrence.everyWeeks !== 0) continue;
			const when = at(date);
			if (when > after && when >= startInstant) return when;
		}
		return undefined;
	}

	const local = toLocal(after, zone);
	let months = Math.max(0, (local.year - start.year) * 12 + (local.month - start.month) - 1);
	months -= months % recurrence.everyMonths;
	for (let i = 0; i < 6; i++, months += recurrence.everyMonths) {
		const index = start.month - 1 + months;
		const year = start.year + Math.floor(index / 12);
		const month = (index % 12) + 1;
		const when = at({ year, month, day: Math.min(start.day, daysInMonth(year, month)) });
		if (when > after && when >= startInstant) return when;
	}
	return undefined;
}

/** "every Wednesday and Saturday at 19:00", "every other month on the 14th at 19:00", "once". */
export function describeRecurrence(start: LocalDateTime, recurrence: Recurrence): string {
	const time = `${pad(start.hour)}:${pad(start.minute)}`;
	switch (recurrence.kind) {
		case "once":
			return `once, at ${time}`;
		case "weekly": {
			const days = listDays(recurrence.days);
			return `${recurrence.everyWeeks === 2 ? "every other week on" : "every"} ${days} at ${time}`;
		}
		case "monthly": {
			const day = `the ${ordinal(start.day)}`;
			return `${recurrence.everyMonths === 2 ? "every other month" : "every month"} on ${day} at ${time}`;
		}
	}
}

export function listDays(days: readonly Weekday[]): string {
	const names = WEEKDAYS.filter((d) => days.includes(d)).map((d) => WEEKDAY_NAMES[d]);
	if (names.length <= 1) return names.join("");
	return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function ordinal(n: number): string {
	const tens = n % 100;
	if (tens >= 11 && tens <= 13) return `${n}th`;
	return `${n}${{ 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th"}`;
}
