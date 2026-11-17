import { formatMinutes, parseDurationMinutes } from "../core/duration.ts";
import { readHowLong } from "../core/how-long.ts";
import { toInstant, toLocal } from "../core/recurrence.ts";
import { type Preview, whyNot } from "../core/time-suggest.ts";
import {
	addDays,
	describeWhen,
	formatTimeOfDay,
	type TimeOfDay,
	type WhenProblem,
} from "../core/when.ts";

/**
 * Time rules for parking, shared by `/admin` → Parking and `/park`. Everything is
 * wall-clock in `PIXEL_TIMEZONE`: the daily reset (23:59 by default) ends every
 * booking, and no window or closure runs past the reset on the day it starts.
 * Lengths and times are read by the core parsers (`core/how-long.ts`,
 * `core/duration.ts`, `core/when.ts`); only "rest of day" is parking's own.
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
 * Reads a duration offered by the settings (the buttons and suggestions): any
 * duration `core/duration.ts` reads ("30m", "90 min", "2h30", "an hour"), or
 * "rest of day". Undefined for anything else, and for more than a day. What
 * people type is read by `readParkingLength`, which also takes an end.
 */
export function parseDuration(typed: string): ParkingDuration | undefined {
	if (REST_OF_DAY.has(typed.trim().toLowerCase().replace(/\s+/g, " "))) {
		return { kind: "rest-of-day" };
	}
	const minutes = parseDurationMinutes(typed);
	if (minutes === undefined || minutes > MAX_DURATION_MINUTES) return undefined;
	return { kind: "minutes", minutes };
}

/** What people are shown as examples of a parking length. */
export const PARKING_LENGTH_EXAMPLES = ["30m", "2h30", "until 17:00", "rest of day"];

/** A typed parking length: when it ends, and how it was typed. */
export type ParkingLength = { end: Date; by: "duration" | "end" | "rest-of-day" };

/**
 * Reads how long someone wants to park, from `base` (now when booking, the
 * current end when extending): a duration ("2h30"), an end ("until 17:00",
 * "till 5pm", "17:00") or "rest of day" (`reset`). Limits, such as the reset or
 * when the spot closes, are the caller's.
 */
export function readParkingLength(
	typed: string,
	base: Date,
	reset: Date,
	zone: string,
	options: { now?: Date } = {},
): { ok: true; value: ParkingLength } | { ok: false; problem: WhenProblem } {
	if (REST_OF_DAY.has(typed.trim().toLowerCase().replace(/\s+/g, " "))) {
		return { ok: true, value: { end: reset, by: "rest-of-day" } };
	}
	const read = readHowLong(typed, base, zone, { now: options.now ?? base });
	return read.ok ? { ok: true, value: { end: read.value.end, by: read.value.by } } : read;
}

/**
 * What a typed length means if booked at `now`, for autocomplete: "until 12:30",
 * "7h, until 17:00", or why it can't be used. A spot that closes sooner
 * shortens it; the reply says so.
 */
export function previewParkingDuration(
	typed: string,
	now: Date,
	reset: Clock,
	zone: string,
): Preview {
	const read = readParkingLength(typed, now, nextReset(now, reset, zone), zone);
	if (!read.ok) return { ok: false, why: whyNot(read.problem, PARKING_LENGTH_EXAMPLES) };
	const { end, by } = read.value;
	const until = `until ${describeInstant(end, now, zone)}`;
	if (by !== "end") return { ok: true, label: until };
	const minutes = Math.ceil((end.getTime() - now.getTime()) / 60_000);
	return { ok: true, label: `${formatMinutes(minutes)}, ${until}` };
}

/** The usual way to write a duration: "30m", "1h", "2h30", "rest of day". */
export function formatParkingDuration(duration: ParkingDuration): string {
	return duration.kind === "rest-of-day" ? "rest of day" : formatMinutes(duration.minutes);
}
