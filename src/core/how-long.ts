import { parseDurationMinutes } from "./duration.ts";
import { toInstant } from "./recurrence.ts";
import { readWhen, type WhenProblem } from "./when.ts";

/**
 * Understands what people type for how long something lasts, from `start`:
 * either a duration ("45m", "2h30", "for 2 hours", "1 day", everything
 * `core/duration.ts` reads) or when it ends ("until 17:00", "till 5pm",
 * "to fri", "until tomorrow 8", or just "17:00"). The end is read like
 * `readWhen`, after `start`. A duration is tried first, so "2h" is two hours
 * and never a time. Limits (the longest a booking may be, whole hours for a
 * poll) are the caller's: this only says what was meant.
 */

/** Why `readHowLong` refused what was typed: the same reasons as `readWhen`. */
export type HowLongProblem = WhenProblem;

/** How long, and when that ends. `by` says which way it was typed. */
export type HowLong = { end: Date; minutes: number; by: "duration" | "end" };

export type HowLongResult = { ok: true; value: HowLong } | { ok: false; problem: HowLongProblem };

const FOR = /^for\s+(.+)$/i;
const UNTIL = /^(?:until|till|til|to)\s+(.+)$/i;

/**
 * How long `typed` means from `start` in `zone`, or why it can't be used.
 * "now" and "now+<duration>" in an end are relative to `options.now` (default
 * `start`), as in `readWhen`.
 */
export function readHowLong(
	typed: string,
	start: Date,
	zone: string,
	options: { now?: Date } = {},
): HowLongResult {
	const trimmed = typed.trim().replace(/\s+/g, " ");
	if (trimmed === "") return { ok: false, problem: { kind: "empty" } };

	const minutes = parseDurationMinutes(FOR.exec(trimmed)?.[1] ?? trimmed);
	if (minutes !== undefined) {
		const end = new Date(start.getTime() + minutes * 60_000);
		return { ok: true, value: { end, minutes, by: "duration" } };
	}

	const read = readWhen(UNTIL.exec(trimmed)?.[1] ?? trimmed, start, zone, {
		now: options.now ?? start,
	});
	if (!read.ok) return read;
	const end = toInstant(read.at, zone);
	return {
		ok: true,
		value: { end, minutes: Math.ceil((end.getTime() - start.getTime()) / 60_000), by: "end" },
	};
}
