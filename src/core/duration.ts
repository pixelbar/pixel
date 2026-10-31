/**
 * Understands what people type for how long: "30m", "90 min", "an hour", "2h30",
 * "2h 30m", "1 day", "3 days", "2 weeks". One number and a unit, or hours and
 * minutes together. Anything else is refused, not guessed. Shared by everything
 * that reads a duration (parking, poll durations), so they all read it the same way.
 */

const UNITS: Record<string, number> = {
	m: 1,
	min: 1,
	mins: 1,
	minute: 1,
	minutes: 1,
	h: 60,
	hr: 60,
	hrs: 60,
	hour: 60,
	hours: 60,
	d: 1440,
	day: 1440,
	days: 1440,
	w: 10080,
	wk: 10080,
	week: 10080,
	weeks: 10080,
};

const ONE = /^(\d{1,4}|an?) ?([a-z]+)$/;
const HOURS_AND_MINUTES =
	/^(\d{1,2}) ?(?:h|hr|hrs|hour|hours) ?(\d{1,2}) ?(?:m|min|mins|minute|minutes)?$/;

/** How many minutes `typed` means, or undefined when it isn't a duration (or is zero). */
export function parseDurationMinutes(typed: string): number | undefined {
	const text = typed.trim().toLowerCase().replace(/\s+/g, " ");
	const both = HOURS_AND_MINUTES.exec(text);
	if (both) {
		const minutes = Number(both[2]);
		return minutes < 60 ? Number(both[1]) * 60 + minutes : undefined;
	}
	const one = ONE.exec(text);
	const unit = one ? UNITS[one[2] as string] : undefined;
	if (!one || unit === undefined) return undefined;
	const count = one[1] === "a" || one[1] === "an" ? 1 : Number(one[1]);
	return count > 0 ? count * unit : undefined;
}

/**
 * A duration written the usual way: "30m", "1h", "2h05", "1 day", "3 days",
 * "1 week". Whole days and weeks are written as such; anything else in hours and
 * minutes.
 */
export function formatMinutes(minutes: number): string {
	const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
	if (minutes > 0 && minutes % 10080 === 0) return plural(minutes / 10080, "week");
	if (minutes > 0 && minutes % 1440 === 0) return plural(minutes / 1440, "day");
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	if (hours === 0) return `${rest}m`;
	return rest === 0 ? `${hours}h` : `${hours}h${String(rest).padStart(2, "0")}`;
}
