import { parseDurationMinutes } from "./duration.ts";
import {
	daysInMonth,
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
 * Accepted: a day ("today", "tomorrow", "wed", "wednesday", "next wed", "14 oct",
 * "oct 14", "14th oct", "oct 1st", "the 3rd", "14-10", "14-10-2026",
 * "2026-10-14") and/or a time ("19", "19:00", "1900", "19.30", "19u", "19u30",
 * "7pm", "7:30pm", "noon", "midnight"), in either order. "tonight" is today in
 * the evening, and "evening" or "night" after a day ("fri evening") is that
 * day's: 19:00 unless a time is given, and "tonight 8" is 20:00. An evening
 * is 17:00 to 23:59; "midnight" is the end of its day. Or "now" (the next
 * whole minute), and "now+30m", "now + 2h30", "now+1 day", "in 30 minutes",
 * "in 2 hours", "in 3 days" for that long from now. "next wed" is
 * Wednesday of next week (weeks start on Monday); "wed" or "this wed" is the
 * coming one. Months are English names or their short forms ("oct",
 * "october", "sep", "sept"). Four digits right after a date ("14 oct 2027")
 * are a year only when another time is there too ("14 oct 2027 19:00") or no
 * clock reads them ("14 oct 2099"); otherwise they are a time ("14 oct 1900"
 * is 19:00). A day without a time is 19:00 (Pixelbar's usual evening). A time
 * without a day is the next time the clock hits it. Words that name a stretch
 * of time ("morning", "next week") and anything unparsed are refused, not
 * guessed, and `readWhen` says why.
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
const FILLER = new Set(["at", "on", "the", "of", "in", "this", "uur"]);
/** Words for a stretch of time rather than a moment: refused, not guessed. */
const VAGUE = new Set([
	"morning",
	"afternoon",
	"week",
	"weekend",
	"month",
	"year",
	"soon",
	"later",
]);
/** Words that put the time in the evening of the day they're with. */
const EVENING = new Set(["evening", "night"]);
/** An evening runs from 17:00 to the end of the day. */
const EVENING_STARTS = 17;

type DayPart = { year: number; month: number; day: number };
/** A wall-clock time of day, such as 19:00. */
export type TimeOfDay = { hour: number; minute: number };
type TimePart = TimeOfDay;
/**
 * A time as typed. `bare` is an hour of 1 to 12 with no am/pm or leading zero,
 * which "tonight" may move to the evening. `endOfDay` is "midnight": 00:00
 * at the end of its day.
 */
type ReadTime = { value: TimePart; bare: boolean; endOfDay: boolean };
type DaySpec =
	| { kind: "date"; date: DayPart }
	| { kind: "weekday"; weekday: Weekday; nextWeek: boolean };

/** Why `readWhen` refused what was typed. */
export type WhenProblem =
	| { kind: "empty" }
	| { kind: "unclear" }
	/** Understood, but it has already passed. */
	| { kind: "past"; at: LocalDateTime }
	/** Understood, but not after a reference later than now, such as the start of a window. */
	| { kind: "before-start"; at: LocalDateTime }
	/** A day and month that don't exist that year, such as 31 Feb. */
	| { kind: "no-such-date"; day: number; month: number; year: number }
	/** A word for a stretch of time ("morning", "week"); one of a fixed set, never other input. */
	| { kind: "vague"; word: string }
	/** "tonight" with a time outside the evening, such as "tonight 9am". */
	| { kind: "not-evening" };

export type WhenResult = { ok: true; at: LocalDateTime } | { ok: false; problem: WhenProblem };

const refuse = (problem: WhenProblem): WhenResult => ({ ok: false, problem });
const accept = (at: LocalDateTime): WhenResult => ({ ok: true, at });

/** Pixelbar's usual evening, used when someone names a day but not a time. */
const DEFAULT_TIME: ReadTime = { value: { hour: 19, minute: 0 }, bare: false, endOfDay: false };

/** "now", "now+30m" / "now + 2h30", or "in 30 minutes", with any duration `core/duration.ts` reads. */
const NOW = /^(?:now(?:\s*\+\s*(.*))?|in\s+(.+))$/i;

/**
 * The moment "now", "now+<duration>" or "in <duration>" means, to the minute:
 * `now` plus the duration, rounded down, and never earlier than the next whole
 * minute (so plain "now" is still in the future). Undefined when it isn't one,
 * "invalid" when "now+" is followed by something that isn't a duration. "in"
 * followed by something else is left for the day and time reader ("in oct 14").
 */
function fromNow(typed: string, now: Date, zone: string): LocalDateTime | "invalid" | undefined {
	const match = NOW.exec(typed);
	if (!match) return undefined;
	const after = match[2];
	const minutes =
		after !== undefined
			? parseDurationMinutes(after)
			: match[1] === undefined
				? 0
				: parseDurationMinutes(match[1]);
	if (minutes === undefined) return after !== undefined ? undefined : "invalid";
	let at = Math.floor((now.getTime() + minutes * 60_000) / 60_000) * 60_000;
	if (at <= now.getTime()) at += 60_000;
	return toLocal(new Date(at), zone);
}

/**
 * The single future moment `typed` means in `zone`, or undefined when it isn't
 * a time we understand or it's already gone. See `readWhen`, which says why.
 */
export function parseWhen(
	typed: string,
	now: Date,
	zone: string,
	options: { now?: Date } = {},
): LocalDateTime | undefined {
	const read = readWhen(typed, now, zone, options);
	return read.ok ? read.at : undefined;
}

/**
 * The single moment after `now` that `typed` means in `zone`, or why it
 * can't be used. A day or a time on its own is read relative to `now`. "now",
 * "now+<duration>" and "in <duration>" are relative to `options.now` (default
 * `now`): pass the real time when `now` is another reference, such as the start
 * of a window whose end is being read. Then a moment that isn't after `now` is
 * "before-start" rather than "past".
 */
export function readWhen(
	typed: string,
	now: Date,
	zone: string,
	options: { now?: Date } = {},
): WhenResult {
	const trimmed = typed.trim();
	if (trimmed === "") return refuse({ kind: "empty" });

	const real = options.now ?? now;
	const future = (local: LocalDateTime): WhenResult =>
		toInstant(local, zone) > now
			? accept(local)
			: refuse({ kind: now > real ? "before-start" : "past", at: local });

	const relative = fromNow(trimmed, real, zone);
	if (relative === "invalid") return refuse({ kind: "unclear" });
	if (relative) return future(relative);

	const exact = parseLocal(trimmed);
	if (exact) return future(exact);

	const today = toLocal(now, zone);
	const tokens = trimmed
		.toLowerCase()
		.replace(/,/g, " ")
		.replace(/\s+/g, " ")
		.split(" ")
		.filter((t) => t !== "" && !FILLER.has(t));
	const vague = tokens.find((t) => VAGUE.has(t));
	if (vague !== undefined) return refuse({ kind: "vague", word: vague });
	const evening = takeEvening(tokens);
	// The day first, so "14 oct" isn't read as 14:00.
	const day = takeDay(tokens, today);
	if (day?.kind === "problem") return refuse(day.problem);
	const time = takeTime(tokens);
	if (tokens.length > 0 || (day === undefined && time === undefined && !evening)) {
		return refuse({ kind: "unclear" });
	}

	const clock = evening ? eveningTime(time) : (time ?? DEFAULT_TIME);
	if (!clock) return refuse({ kind: "not-evening" });
	const on = (date: DayPart): LocalDateTime =>
		clock.endOfDay ? { ...addDays(date, 1), hour: 0, minute: 0 } : { ...date, ...clock.value };
	const spec: DaySpec | undefined = day ?? (evening ? { kind: "date", date: today } : undefined);

	if (spec === undefined) {
		const todayAt = on(today);
		return accept(toInstant(todayAt, zone) > now ? todayAt : on(addDays(today, 1)));
	}
	if (spec.kind === "weekday") {
		if (spec.nextWeek) return future(on(weekdayNextWeek(today, spec.weekday)));
		const date = nextWeekdayOnOrAfter(today, spec.weekday);
		const local = on(date);
		return accept(toInstant(local, zone) > now ? local : on(addDays(date, 7)));
	}
	return future(on(spec.date));
}

/**
 * Removes the evening words. "tonight" becomes "today", so it's the day too.
 * True when there was one.
 */
function takeEvening(tokens: string[]): boolean {
	let evening = false;
	for (let i = tokens.length - 1; i >= 0; i--) {
		const token = tokens[i] as string;
		if (token === "tonight") {
			tokens[i] = "today";
			evening = true;
		} else if (EVENING.has(token)) {
			tokens.splice(i, 1);
			evening = true;
		}
	}
	return evening;
}

/**
 * The time in the evening: 19:00 when none was given, a bare 5 to 11 in the
 * afternoon ("tonight 8" is 20:00), and "midnight" as the end of the day.
 * Undefined when the time isn't in the evening, rather than guessing what
 * "tonight 9am" or "tonight 2" meant.
 */
function eveningTime(time: ReadTime | undefined): ReadTime | undefined {
	if (!time) return DEFAULT_TIME;
	if (time.endOfDay) return time;
	const { hour, minute } = time.value;
	const afternoon = time.bare && hour >= 5 && hour <= 11 ? hour + 12 : hour;
	return afternoon >= EVENING_STARTS
		? { value: { hour: afternoon, minute }, bare: false, endOfDay: false }
		: undefined;
}

/** "Wed 14 Oct 2026, 19:00" */
export function describeWhen(t: LocalDateTime): string {
	const day = weekdayOf(t);
	const name = day.charAt(0).toUpperCase() + day.slice(1);
	return `${name} ${describeDate(t)}, ${formatTimeOfDay(t)}`;
}

/** "14 Oct 2026", also for a day and month that don't exist that year ("31 Feb 2027"). */
export function describeDate(t: DayPart): string {
	const month = MONTHS[t.month - 1] as string;
	return `${t.day} ${month.charAt(0).toUpperCase()}${month.slice(1)} ${t.year}`;
}

/**
 * A time of day on its own, read the same way as in `parseWhen`: "23:59", "2359",
 * "23.59", "23u59", "11pm", "11:59 pm", "noon", "midnight" (00:00). Undefined
 * for anything else.
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
function takeTime(tokens: string[]): ReadTime | undefined {
	for (let i = 0; i < tokens.length; i++) {
		const time = readTime(tokens[i] as string, tokens[i + 1]);
		if (time) {
			tokens.splice(i, time.used);
			return time;
		}
	}
	return undefined;
}

function readTime(
	token: string,
	next: string | undefined,
): (ReadTime & { used: number }) | undefined {
	if (token === "noon" || token === "midday") {
		return { value: { hour: 12, minute: 0 }, bare: false, endOfDay: false, used: 1 };
	}
	if (token === "midnight") {
		return { value: { hour: 0, minute: 0 }, bare: false, endOfDay: true, used: 1 };
	}
	const ampm = /^(\d{1,2})(?:[:.](\d{2}))?(am|pm)$/.exec(token);
	const spaced = next === "am" || next === "pm" ? /^(\d{1,2})(?:[:.](\d{2}))?$/.exec(token) : null;
	const twelve = ampm ?? (spaced ? [...spaced, next] : null);
	if (twelve) {
		let hour = Number(twelve[1]);
		const minute = Number(twelve[2] ?? 0);
		if (hour < 1 || hour > 12 || minute > 59) return undefined;
		if (twelve[3] === "pm" && hour !== 12) hour += 12;
		if (twelve[3] === "am" && hour === 12) hour = 0;
		return { value: { hour, minute }, bare: false, endOfDay: false, used: ampm ? 1 : 2 };
	}
	// Compact 24h (1900, 0930, 930), Dutch "19u" / "19u30" and plain "19:00".
	// Not a library: chrono-style parsers guess (1900 as a year), and we refuse
	// anything unclear.
	const match =
		/^(\d{1,2})(\d{2})$/.exec(token) ??
		/^(\d{1,2})u(\d{2})?$/.exec(token) ??
		/^(\d{1,2})(?:[:.h](\d{2}))?$/.exec(token);
	if (!match) return undefined;
	const hourText = match[1] as string;
	const value = clock(Number(hourText), Number(match[2] ?? 0));
	if (!value) return undefined;
	const bare = !hourText.startsWith("0") && value.hour >= 1 && value.hour <= 12;
	return { value, bare, endOfDay: false, used: 1 };
}

function clock(hour: number, minute: number): TimePart | undefined {
	if (hour > 23 || minute > 59) return undefined;
	return { hour, minute };
}

/** A day of the month, with or without "st", "nd", "rd" or "th". */
const DAY_NUMBER = /^(\d{1,2})(?:st|nd|rd|th)?$/;
/** A day of the month written as an ordinal: "3rd", "14th". */
const ORDINAL = /^(\d{1,2})(?:st|nd|rd|th)$/;

type TakenDay = DaySpec | { kind: "problem"; problem: WhenProblem };

/**
 * Removes a day (a date, today/tomorrow, a weekday, "next" and a weekday, or
 * an ordinal day of the month) from the tokens.
 */
function takeDay(tokens: string[], today: DayPart): TakenDay | undefined {
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i] as string;
		if (token === "today") {
			tokens.splice(i, 1);
			return { kind: "date", date: today };
		}
		if (token === "tomorrow") {
			tokens.splice(i, 1);
			return { kind: "date", date: addDays(today, 1) };
		}
		if (token === "next") {
			const weekday = DAY_ALIASES[tokens[i + 1] ?? ""];
			if (!weekday) return { kind: "problem", problem: { kind: "unclear" } };
			tokens.splice(i, 2);
			return { kind: "weekday", weekday, nextWeek: true };
		}
		const weekday = DAY_ALIASES[token];
		if (weekday) {
			tokens.splice(i, 1);
			return { kind: "weekday", weekday, nextWeek: false };
		}
		const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(token);
		if (iso) {
			tokens.splice(i, 1);
			return dateOf(today, Number(iso[2]), Number(iso[3]), Number(iso[1]));
		}
		const dmy = /^(\d{1,2})[-/](\d{1,2})(?:[-/](\d{4}))?$/.exec(token);
		if (dmy) {
			tokens.splice(i, 1);
			const year = dmy[3] ? Number(dmy[3]) : takeYear(tokens, i);
			return dateOf(today, Number(dmy[2]), Number(dmy[1]), year);
		}
		const ordinal = ORDINAL.exec(token);
		if (ordinal && MONTH_ALIASES[tokens[i + 1] ?? ""] === undefined) {
			tokens.splice(i, 1);
			return dayOfMonth(today, Number(ordinal[1]));
		}
		const month = MONTH_ALIASES[token];
		if (month !== undefined) {
			const before = DAY_NUMBER.exec(tokens[i - 1] ?? "");
			const after = DAY_NUMBER.exec(tokens[i + 1] ?? "");
			const dayNumber = before ?? after;
			if (!dayNumber) return undefined;
			const start = before ? i - 1 : i;
			tokens.splice(start, 2);
			return dateOf(today, month, Number(dayNumber[1]), takeYear(tokens, start));
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

/**
 * A day and month in `year`, or without one this year's, or next year's if it
 * has passed. A day and month that never exist (32 Oct, month 13) are
 * unclear; one that doesn't exist that year (31 Feb, 29 Feb 2027) says so.
 */
function dateOf(today: DayPart, month: number, day: number, year?: number): TakenDay {
	if (month < 1 || month > 12 || day < 1 || day > 31) {
		return { kind: "problem", problem: { kind: "unclear" } };
	}
	const passed = month < today.month || (month === today.month && day < today.day);
	const y = year ?? (passed ? today.year + 1 : today.year);
	return day <= daysInMonth(y, month)
		? { kind: "date", date: { year: y, month, day } }
		: { kind: "problem", problem: { kind: "no-such-date", day, month, year: y } };
}

/** The next day numbered `day` from today on: this month's if it's still to come, otherwise a later month's. */
function dayOfMonth(today: DayPart, day: number): TakenDay {
	if (day < 1 || day > 31) return { kind: "problem", problem: { kind: "unclear" } };
	// Every day from 1 to 31 is in at least one month of the next three (31 is in
	// January or March, after February).
	for (let k = 0; ; k++) {
		const month = ((today.month - 1 + k) % 12) + 1;
		const year = today.year + Math.floor((today.month - 1 + k) / 12);
		if (day <= daysInMonth(year, month) && (k > 0 || day >= today.day)) {
			return { kind: "date", date: { year, month, day } };
		}
	}
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

/** `weekday` in the week after this one, with weeks starting on Monday. */
function weekdayNextWeek(today: DayPart, weekday: Weekday): DayPart {
	const monday = addDays(today, -WEEKDAYS.indexOf(weekdayOf(today)));
	return addDays(monday, 7 + WEEKDAYS.indexOf(weekday));
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
