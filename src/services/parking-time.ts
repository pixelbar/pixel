import { type LocalDateTime, toInstant, toLocal } from "../core/recurrence.ts";
import { describeWhen } from "../core/when.ts";

/**
 * Time rules for parking, shared by `/admin parking` and `/park`. Everything is
 * wall-clock in `PIXEL_TIMEZONE`: the daily reset (23:59 by default) ends every
 * booking, and no window or closure runs past the reset on the day it starts.
 */

/** A wall-clock time of day, e.g. the reset. */
export type Clock = { hour: number; minute: number };

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Reads "23:59". Undefined unless it's exactly HH:MM. */
export function parseClock(text: string): Clock | undefined {
	const match = CLOCK.exec(text.trim());
	if (!match) return undefined;
	return { hour: Number(match[1]), minute: Number(match[2]) };
}

export function formatClock(clock: Clock): string {
	return `${String(clock.hour).padStart(2, "0")}:${String(clock.minute).padStart(2, "0")}`;
}

function nextDay(t: LocalDateTime): LocalDateTime {
	const d = new Date(Date.UTC(t.year, t.month - 1, t.day + 1));
	return { ...t, year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** The first reset strictly after `after`: today's if it's still ahead, otherwise tomorrow's. */
export function nextReset(after: Date, reset: Clock, zone: string): Date {
	const local = toLocal(after, zone);
	const today = toInstant({ ...local, ...reset }, zone);
	return today > after ? today : toInstant({ ...nextDay(local), ...reset }, zone);
}

/** "17:00" when it's on the same day as `now` in `zone`, otherwise "Sat 25 Oct 2026, 08:00". */
export function describeInstant(instant: Date, now: Date, zone: string): string {
	const local = toLocal(instant, zone);
	const today = toLocal(now, zone);
	const sameDay =
		local.year === today.year && local.month === today.month && local.day === today.day;
	return sameDay ? formatClock(local) : describeWhen(local);
}

/** How long someone asks to park for. */
export type ParkingDuration = { kind: "minutes"; minutes: number } | { kind: "rest-of-day" };

/** A day: nothing can be longer, because the reset ends every booking. */
export const MAX_DURATION_MINUTES = 24 * 60;

const MINUTES = "(?:m|min|mins|minute|minutes)";
const HOURS = "(?:h|hr|hrs|hour|hours)";
const ONLY_MINUTES = new RegExp(`^(\\d{1,4}) ?${MINUTES}$`);
const HOURS_AND_MINUTES = new RegExp(`^(\\d{1,2}) ?${HOURS}(?: ?(\\d{1,2}) ?${MINUTES}?)?$`);
const REST_OF_DAY = new Set(["rest of day", "rest of the day"]);

/**
 * Reads what someone typed for a duration: "30m", "90 min", "1h", "2h30", "2h 30m",
 * "rest of day". Undefined for anything else, for zero, and for more than a day.
 */
export function parseDuration(typed: string): ParkingDuration | undefined {
	const text = typed.trim().toLowerCase().replace(/\s+/g, " ");
	if (REST_OF_DAY.has(text)) return { kind: "rest-of-day" };
	let minutes: number | undefined;
	const only = ONLY_MINUTES.exec(text);
	if (only) minutes = Number(only[1]);
	const both = HOURS_AND_MINUTES.exec(text);
	if (both) {
		const extra = both[2] === undefined ? 0 : Number(both[2]);
		if (extra >= 60) return undefined;
		minutes = Number(both[1]) * 60 + extra;
	}
	if (minutes === undefined || minutes < 1 || minutes > MAX_DURATION_MINUTES) return undefined;
	return { kind: "minutes", minutes };
}

/** The usual way to write a duration: "30m", "1h", "2h30", "rest of day". */
export function formatParkingDuration(duration: ParkingDuration): string {
	if (duration.kind === "rest-of-day") return "rest of day";
	const hours = Math.floor(duration.minutes / 60);
	const minutes = duration.minutes % 60;
	if (hours === 0) return `${minutes}m`;
	return minutes === 0 ? `${hours}h` : `${hours}h${String(minutes).padStart(2, "0")}`;
}
