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
 * Understands what people type for a date and time, so autocomplete can offer the
 * exact moment it means ("wed 19" → "Wed 14 Oct 2026, 19:00"). Lenient on input,
 * exact on output: the value submitted is always "2026-10-14T19:00", and only
 * future times are offered.
 *
 * Accepted: a day ("today", "tomorrow", "wed", "wednesday", "14 oct", "oct 14",
 * "14-10", "14-10-2026", "2026-10-14") and/or a time ("19", "19:00", "19.30",
 * "7pm", "7:30pm"), in either order.
 */

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
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

type DayPart = { year: number; month: number; day: number };
type TimePart = { hour: number; minute: number };

/** Times offered when only a day was typed. */
const DEFAULT_TIMES: readonly TimePart[] = [
	{ hour: 19, minute: 0 },
	{ hour: 20, minute: 0 },
	{ hour: 12, minute: 0 },
];

/**
 * Up to `limit` future moments matching what was typed, soonest first. Empty when
 * nothing fits. With nothing typed, it offers a few common times.
 */
export function suggestWhen(typed: string, now: Date, zone: string, limit = 5): LocalDateTime[] {
	const text = typed.trim().toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ");
	const exact = parseLocal(typed.trim());
	if (exact) return toInstant(exact, zone) > now ? [exact] : [];

	const today = toLocal(now, zone);
	// Little words people type around a date ("on wed at 7pm") carry no meaning here.
	const tokens =
		text === "" ? [] : text.split(" ").filter((t) => !["at", "on", "the", "of"].includes(t));
	// The day first, so "14 oct" isn't read as 14:00.
	const days = takeDays(tokens, today);
	const time = takeTime(tokens);
	// Something was typed that we don't understand: offer nothing rather than a guess.
	if (tokens.length > 0) return [];

	const candidateDays = days ?? nextDays(today, 8);
	const times = time ? [time] : DEFAULT_TIMES;
	const out: LocalDateTime[] = [];
	for (const day of candidateDays) {
		for (const t of times) {
			const local = { ...day, ...t };
			if (toInstant(local, zone) > now) out.push(local);
		}
	}
	out.sort((a, b) => toInstant(a, zone).getTime() - toInstant(b, zone).getTime());
	return out.slice(0, limit);
}

/** What someone submitted, if it's a valid future moment: a suggestion's value, or text we understand on our own. */
export function parseWhen(typed: string, now: Date, zone: string): LocalDateTime | undefined {
	return suggestWhen(typed, now, zone, 1)[0];
}

/** "Wed 14 Oct 2026, 19:00" */
export function describeWhen(t: LocalDateTime): string {
	const day = weekdayOf(t);
	const name = day.charAt(0).toUpperCase() + day.slice(1);
	const month = MONTHS[t.month - 1] as string;
	return `${name} ${t.day} ${month.charAt(0).toUpperCase()}${month.slice(1)} ${t.year}, ${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`;
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
	const plain = /^(\d{1,2})(?:[:.h](\d{2}))?$/.exec(token);
	if (plain) {
		const hour = Number(plain[1]);
		const minute = Number(plain[2] ?? 0);
		if (hour > 23 || minute > 59) return undefined;
		return { value: { hour, minute }, used: 1 };
	}
	return undefined;
}

/** Removes a day (or a weekday, meaning its next few dates) from the tokens. */
function takeDays(tokens: string[], today: DayPart): DayPart[] | undefined {
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i] as string;
		if (token === "today" || token === "tonight") {
			tokens.splice(i, 1);
			return [today];
		}
		if (token === "tomorrow") {
			tokens.splice(i, 1);
			return [addDays(today, 1)];
		}
		const weekday = DAY_ALIASES[token];
		if (weekday) {
			tokens.splice(i, 1);
			// "next wed" means the one after the coming one is fine too: offer both.
			if (tokens[i - 1] === "next") tokens.splice(i - 1, 1);
			return nextDays(today, 21).filter((d) => weekdayOf(d) === weekday);
		}
		const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(token);
		if (iso) {
			tokens.splice(i, 1);
			return valid(Number(iso[1]), Number(iso[2]), Number(iso[3]));
		}
		const dmy = /^(\d{1,2})[-/](\d{1,2})(?:[-/](\d{4}))?$/.exec(token);
		if (dmy) {
			tokens.splice(i, 1);
			return withYear(today, Number(dmy[2]), Number(dmy[1]), dmy[3] ? Number(dmy[3]) : undefined);
		}
		const month = MONTHS.indexOf(token.slice(0, 3));
		if (month >= 0 && /^[a-z]+$/.test(token)) {
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
			const year =
				tokens[start] && /^\d{4}$/.test(tokens[start] as string)
					? Number(tokens.splice(start, 1)[0])
					: undefined;
			return withYear(today, month + 1, Number(dayToken), year);
		}
	}
	return undefined;
}

function valid(year: number, month: number, day: number): DayPart[] {
	if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return [];
	return [{ year, month, day }];
}

/** A day and month: this year's, or next year's if it has passed. */
function withYear(today: DayPart, month: number, day: number, year?: number): DayPart[] {
	if (year !== undefined) return valid(year, month, day);
	const thisYear = valid(today.year, month, day);
	const passed =
		thisYear[0] !== undefined &&
		formatLocal({ ...thisYear[0], hour: 0, minute: 0 }) <
			formatLocal({ ...today, hour: 0, minute: 0 });
	return passed ? valid(today.year + 1, month, day) : thisYear;
}

function addDays(day: DayPart, n: number): DayPart {
	const d = new Date(Date.UTC(day.year, day.month - 1, day.day + n));
	return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function nextDays(today: DayPart, count: number): DayPart[] {
	return Array.from({ length: count }, (_, i) => addDays(today, i));
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
