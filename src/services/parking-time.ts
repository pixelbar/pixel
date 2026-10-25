import { formatMinutes, parseDurationMinutes } from "../core/duration.ts";
import { toInstant, toLocal } from "../core/recurrence.ts";
import { addDays, describeWhen, formatTimeOfDay, type TimeOfDay } from "../core/when.ts";

/**
 * Time rules for parking, shared by `/admin parking` and `/park`. Everything is
 * wall-clock in `PIXEL_TIMEZONE`: the daily reset (23:59 by default) ends every
 * booking, and no window or closure runs past the reset on the day it starts.
 * Durations and times of day are read by the core parsers (`core/duration.ts`,
 * `core/when.ts`); only "rest of day" is parking's own.
 */

/** A wall-clock time of day, e.g. the reset. */
export type Clock = TimeOfDay;

/** The first reset strictly after `after`: today's if it's still ahead, otherwise tomorrow's. */
export function nextReset(after: Date, reset: Clock, zone: string): Date {
	const local = toLocal(after, zone);
	const today = toInstant({ ...local, ...reset }, zone);
	return today > after ? today : toInstant({ ...addDays(local, 1), ...reset }, zone);
}

/** "17:00" when it's on the same day as `now` in `zone`, otherwise "Sat 25 Oct 2026, 08:00". */
export function describeInstant(instant: Date, now: Date, zone: string): string {
	const local = toLocal(instant, zone);
	const today = toLocal(now, zone);
	const sameDay =
		local.year === today.year && local.month === today.month && local.day === today.day;
	return sameDay ? formatTimeOfDay(local) : describeWhen(local);
}

/** How long someone asks to park for. */
export type ParkingDuration = { kind: "minutes"; minutes: number } | { kind: "rest-of-day" };

/** A day: nothing can be longer, because the reset ends every booking. */
export const MAX_DURATION_MINUTES = 24 * 60;

const REST_OF_DAY = new Set(["rest of day", "rest of the day"]);

/**
 * Reads how long someone wants to park: any duration `core/duration.ts` reads
 * ("30m", "90 min", "2h30", "an hour"), or "rest of day". Undefined for anything
 * else, and for more than a day.
 */
export function parseDuration(typed: string): ParkingDuration | undefined {
	if (REST_OF_DAY.has(typed.trim().toLowerCase().replace(/\s+/g, " "))) {
		return { kind: "rest-of-day" };
	}
	const minutes = parseDurationMinutes(typed);
	if (minutes === undefined || minutes > MAX_DURATION_MINUTES) return undefined;
	return { kind: "minutes", minutes };
}

/** The usual way to write a duration: "30m", "1h", "2h30", "rest of day". */
export function formatParkingDuration(duration: ParkingDuration): string {
	return duration.kind === "rest-of-day" ? "rest of day" : formatMinutes(duration.minutes);
}
