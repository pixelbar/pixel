import { parseDurationMinutes } from "./duration.ts";
import {
	daysInMonth,
	formatLocal,
	type LocalDateTime,
	listDays,
	parseLocal,
	toInstant,
	toLocal,
	WEEKDAYS,
	type Weekday,
	weekdayOf,
} from "./recurrence.ts";

/**
 * Understands what people type for a date and time. Discord has no date picker
 * and autocomplete would force picking from a short list of dates, so `when` is
 * free-form text. This module turns that into **one** future wall-clock moment
 * in `PIXEL_TIMEZONE`. The command then confirms it ("Wed 14 Oct 2026, 19:00").
 *
 * Accepted: a day ("today", "tomorrow", "wed", "wednesday", "14 oct", "oct 14",
 * "14-10", "14-10-2026", "2026-10-14") and/or a time ("19", "19:00", "1900",
 * "19.30", "19u", "19u30", "7pm", "7:30pm"), in either order. Or "now" (the next
 * whole minute) and "now+30m", "now + 2h30", "now+1 day". Months are
 * English names or their short forms ("oct", "october", "sep", "sept"). Four
 * digits right after a date ("14 oct 2027") are a year only when another time
 * is there too ("14 oct 2027 19:00") or no clock reads them ("14 oct 2099");
 * otherwise they are a time ("14 oct 1900" is 19:00). A day without a time is
 * 19:00 (Pixelbar's usual evening). A time without a day is the next time the
 * clock hits it. Unparsed strings are refused, not guessed.
 */

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_NAMES = [
	"january",
	"february",
	"march",
	"april",
	"may",
	"june",
	"july",
	"august",
	"september",
	"october",
	"november",
	"december",
];
/** Month words to their number (1-12): full names and short forms, nothing that merely starts like one. */
const MONTH_ALIASES: Record<string, number> = {
	...Object.fromEntries(MONTHS.map((m, i) => [m, i + 1])),
	...Object.fromEntries(MONTH_NAMES.map((m, i) => [m, i + 1])),
	sept: 9,
};
const DAY_ALIASES: Record<string, Weekday> = {
	mon: "mon",
	monday: "mon",
	tue: "tue",
	tues: "tue",
	tuesday: "tue",
	wed: "wed",
	weds: "wed",
	wednesday: "wed",
	thu: "thu",
	thur: "thu",
	thurs: "thu",
	thursday: "thu",
	fri: "fri",
	friday: "fri",
	sat: "sat",
	saturday: "sat",
	sun: "sun",
	sunday: "sun",
};

/** Words people type around a date that carry no meaning here. */
const FILLER = new Set(["at", "on", "the", "of", "in", "next", "uur"]);

type DayPart = { year: number; month: number; day: number };
/** A wall-clock time of day, such as 19:00. */
export type TimeOfDay = { hour: number; minute: number };
type TimePart = TimeOfDay;
type DaySpec = { kind: "date"; date: DayPart } | { kind: "weekday"; weekday: Weekday };

/** Pixelbar's usual evening, used when someone names a day but not a time. */
const DEFAULT_TIME: TimePart = { hour: 19, minute: 0 };

/** "now", or "now+30m" / "now + 2h30" with any duration `core/duration.ts` reads. */
const NOW = /^now(?:\s*\+\s*(.+))?$/i;

/**
 * The moment "now" or "now+<duration>" means, to the minute: `now` plus the
 * duration, rounded down, and never earlier than the next whole minute (so plain
 * "now" is still in the future). Undefined when it isn't one, or the duration
 * can't be read.
 */
function fromNow(typed: string, now: Date, zone: string): LocalDateTime | "invalid" | undefined {
	const match = NOW.exec(typed);
	if (!match) return undefined;
	const minutes = match[1] === undefined ? 0 : parseDurationMinutes(match[1]);
	if (minutes === undefined) return "invalid";
	let at = Math.floor((now.getTime() + minutes * 60_000) / 60_000) * 60_000;
	if (at <= now.getTime()) at += 60_000;
	return toLocal(new Date(at), zone);
}

/**
 * The single future moment `typed` means in `zone`, or undefined when it isn't
 * a time we understand or it's already gone. A day or a time on its own is read
 * relative to `now`. "now" and "now+<duration>" are relative to `options.now`
 * (default `now`): pass the real time when `now` is another reference, such as
 * the start of a window whose end is being read.
 */
export function parseWhen(
	typed: string,
	now: Date,
	zone: string,
	options: { now?: Date } = {},
): LocalDateTime | undefined {
	const trimmed = typed.trim();
	if (trimmed === "") return undefined;

	const relative = fromNow(trimmed, options.now ?? now, zone);
	if (relative === "invalid") return undefined;
	if (relative) return future(relative, now, zone);

	const exact = parseLocal(trimmed);
	if (exact) return future(exact, now, zone);

	const today = toLocal(now, zone);
	const tokens = trimmed
		.toLowerCase()
		.replace(/,/g, " ")
		.replace(/\s+/g, " ")
		.split(" ")
		.filter((t) => t !== "" && !FILLER.has(t));
	// The day first, so "14 oct" isn't read as 14:00.
	const day = takeDay(tokens, today);
	if (day === "invalid") return undefined;
	const time = takeTime(tokens);
	if (tokens.length > 0 || (day === undefined && time === undefined)) return undefined;

	const clock = time ?? DEFAULT_TIME;
	if (day === undefined) {
		const todayAt = { ...today, ...clock };
		return toInstant(todayAt, zone) > now ? todayAt : { ...addDays(today, 1), ...clock };
	}
	if (day.kind === "weekday") {
		const date = nextWeekdayOnOrAfter(today, day.weekday);
		let local = { ...date, ...clock };
		if (toInstant(local, zone) <= now) local = { ...addDays(date, 7), ...clock };
		return local;
	}
	return future({ ...day.date, ...clock }, now, zone);
}

function future(local: LocalDateTime, now: Date, zone: string): LocalDateTime | undefined {
	return toInstant(local, zone) > now ? local : undefined;
}

/** "Wed 14 Oct 2026, 19:00" */
export function describeWhen(t: LocalDateTime): string {
	const day = weekdayOf(t);
	const name = day.charAt(0).toUpperCase() + day.slice(1);
	const month = MONTHS[t.month - 1] as string;
	return `${name} ${t.day} ${month.charAt(0).toUpperCase()}${month.slice(1)} ${t.year}, ${formatTimeOfDay(t)}`;
}

/**
 * A time of day on its own, read the same way as in `parseWhen`: "23:59", "2359",
 * "23.59", "23u59", "11pm", "11:59 pm". Undefined for anything else.
 */
export function parseTimeOfDay(typed: string): TimeOfDay | undefined {
	const tokens = typed.trim().toLowerCase().split(/\s+/).filter(Boolean);
	const [first, second] = tokens;
	if (first === undefined || tokens.length > 2) return undefined;
	const time = readTime(first, second);
	return time && time.used === tokens.length ? time.value : undefined;
}

/** "07:05" */
export function formatTimeOfDay(t: TimeOfDay): string {
	return `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`;
}

/** Removes a time from the tokens and returns it. */
function takeTime(tokens: string[]): TimePart | undefined {
	for (let i = 0; i < tokens.length; i++) {
		const time = readTime(tokens[i] as string, tokens[i + 1]);
		if (time) {
			tokens.splice(i, time.used);
			return time.value;
		}
	}
	return undefined;
}

function readTime(
	token: string,
	next: string | undefined,
): { value: TimePart; used: number } | undefined {
	const ampm = /^(\d{1,2})(?:[:.](\d{2}))?(am|pm)$/.exec(token);
	const spaced = next === "am" || next === "pm" ? /^(\d{1,2})(?:[:.](\d{2}))?$/.exec(token) : null;
	const twelve = ampm ?? (spaced ? [...spaced, next] : null);
	if (twelve) {
		let hour = Number(twelve[1]);
		const minute = Number(twelve[2] ?? 0);
		if (hour < 1 || hour > 12 || minute > 59) return undefined;
		if (twelve[3] === "pm" && hour !== 12) hour += 12;
		if (twelve[3] === "am" && hour === 12) hour = 0;
		return { value: { hour, minute }, used: ampm ? 1 : 2 };
	}
	// Compact 24h (1900, 0930, 930) and Dutch "19u" / "19u30". Not a library:
	// chrono-style parsers guess (1900 as a year), and we refuse anything unclear.
	const compact = /^(\d{1,2})(\d{2})$/.exec(token);
	if (compact) {
		const value = clock(Number(compact[1]), Number(compact[2]));
		return value ? { value, used: 1 } : undefined;
	}
	const dutch = /^(\d{1,2})u(\d{2})?$/.exec(token);
	if (dutch) {
		const value = clock(Number(dutch[1]), Number(dutch[2] ?? 0));
		return value ? { value, used: 1 } : undefined;
	}
	const plain = /^(\d{1,2})(?:[:.h](\d{2}))?$/.exec(token);
	if (plain) {
		const value = clock(Number(plain[1]), Number(plain[2] ?? 0));
		return value ? { value, used: 1 } : undefined;
	}
	return undefined;
}

function clock(hour: number, minute: number): TimePart | undefined {
	if (hour > 23 || minute > 59) return undefined;
	return { hour, minute };
}

/** Removes a day (a date, today/tomorrow, or a weekday) from the tokens. */
function takeDay(tokens: string[], today: DayPart): DaySpec | "invalid" | undefined {
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i] as string;
		if (token === "today" || token === "tonight") {
			tokens.splice(i, 1);
			return { kind: "date", date: today };
		}
		if (token === "tomorrow") {
			tokens.splice(i, 1);
			return { kind: "date", date: addDays(today, 1) };
		}
		const weekday = DAY_ALIASES[token];
		if (weekday) {
			tokens.splice(i, 1);
			return { kind: "weekday", weekday };
		}
		const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(token);
		if (iso) {
			tokens.splice(i, 1);
			const date = valid(Number(iso[1]), Number(iso[2]), Number(iso[3]));
			return date ? { kind: "date", date } : "invalid";
		}
		const dmy = /^(\d{1,2})[-/](\d{1,2})(?:[-/](\d{4}))?$/.exec(token);
		if (dmy) {
			tokens.splice(i, 1);
			const year = dmy[3] ? Number(dmy[3]) : takeYear(tokens, i);
			const date = withYear(today, Number(dmy[2]), Number(dmy[1]), year);
			return date ? { kind: "date", date } : "invalid";
		}
		const month = MONTH_ALIASES[token];
		if (month !== undefined) {
			const before = tokens[i - 1];
			const after = tokens[i + 1];
			const dayToken =
				before && /^\d{1,2}$/.test(before)
					? before
					: after && /^\d{1,2}$/.test(after)
						? after
						: undefined;
			if (!dayToken) return undefined;
			const start = dayToken === before ? i - 1 : i;
			tokens.splice(start, 2);
			const date = withYear(today, month, Number(dayToken), takeYear(tokens, start));
			return date ? { kind: "date", date } : "invalid";
		}
	}
	return undefined;
}

/**
 * Removes and returns the year right after a date, at `at`. Four digits there
 * are a year only when another token is the time or no clock reads them, so
 * "14 nov 1900" is 19:00 and "14 nov 2030 19:00" is in 2030.
 */
function takeYear(tokens: string[], at: number): number | undefined {
	const token = tokens[at];
	if (token === undefined || !/^\d{4}$/.test(token)) return undefined;
	const otherTime = tokens.some((t, j) => j !== at && readTime(t, tokens[j + 1]) !== undefined);
	if (!otherTime && readTime(token, undefined) !== undefined) return undefined;
	tokens.splice(at, 1);
	return Number(token);
}

function valid(year: number, month: number, day: number): DayPart | undefined {
	if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return undefined;
	return { year, month, day };
}

/** A day and month: this year's, or next year's if it has passed. */
function withYear(today: DayPart, month: number, day: number, year?: number): DayPart | undefined {
	if (year !== undefined) return valid(year, month, day);
	const thisYear = valid(today.year, month, day);
	const passed =
		thisYear !== undefined &&
		formatLocal({ ...thisYear, hour: 0, minute: 0 }) <
			formatLocal({ ...today, hour: 0, minute: 0 });
	return passed ? valid(today.year + 1, month, day) : thisYear;
}

/** The calendar date `n` days after `day`. */
export function addDays(day: DayPart, n: number): DayPart {
	const d = new Date(Date.UTC(day.year, day.month - 1, day.day + n));
	return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function nextWeekdayOnOrAfter(today: DayPart, weekday: Weekday): DayPart {
	for (let i = 0; i < 7; i++) {
		const day = addDays(today, i);
		if (weekdayOf(day) === weekday) return day;
	}
	return today;
}

/**
 * Reads days of the week: "wed sat", "wed,sat", "Wednesday and Saturday",
 * "weekdays", "weekend". Undefined when something isn't a day.
 */
export function parseDays(typed: string): Weekday[] | undefined {
	const tokens = typed
		.toLowerCase()
		.replace(/[,&+/]/g, " ")
		.split(/\s+/)
		.filter((t) => t !== "" && t !== "and");
	if (tokens.length === 0) return undefined;
	const days = new Set<Weekday>();
	for (const token of tokens) {
		if (token === "weekdays") {
			for (const d of ["mon", "tue", "wed", "thu", "fri"] as const) days.add(d);
		} else if (token === "weekend" || token === "weekends") {
			for (const d of ["sat", "sun"] as const) days.add(d);
		} else {
			const day = DAY_ALIASES[token];
			if (!day) return undefined;
			days.add(day);
		}
	}
	return WEEKDAYS.filter((d) => days.has(d));
}

/** The canonical value for a set of days: "wed,sat". */
export const formatDays = (days: readonly Weekday[]): string => days.join(",");

/** Suggestions for a days option: what was typed, understood, plus common sets. */
export function suggestDays(typed: string): { name: string; value: string }[] {
	const out = new Map<string, string>();
	const parsed = parseDays(typed);
	if (parsed) out.set(formatDays(parsed), listDays(parsed));
	if (typed.trim() === "") {
		for (const days of [
			["wed", "sat"],
			["mon", "tue", "wed", "thu", "fri"],
			["sat", "sun"],
		] as Weekday[][]) {
			out.set(formatDays(days), listDays(days));
		}
		for (const day of WEEKDAYS) out.set(day, listDays([day]));
	}
	return [...out].map(([value, name]) => ({ name, value }));
}
