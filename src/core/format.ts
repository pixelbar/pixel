/** Formats a duration compactly, e.g. "2h 15m" or "3d 4h 0m". Under a minute is "0m". */
export function formatDuration(ms: number): string {
	const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
	const days = Math.floor(totalMinutes / 1440);
	const hours = Math.floor((totalMinutes % 1440) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return `${days}d ${hours}h ${minutes}m`;
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${minutes}m`;
}

/**
 * How far away something still ahead is, in words: "starting now", "in 25m",
 * "in 3h 20m" or "in 2 days".
 */
export function formatUntil(ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 1) return "starting now";
	if (minutes < 60) return `in ${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		const rest = minutes % 60;
		return rest > 0 ? `in ${hours}h ${rest}m` : `in ${hours}h`;
	}
	const days = Math.floor(hours / 24);
	return `in ${days} ${days === 1 ? "day" : "days"}`;
}

/** Whether `zone` is a time zone name that Intl knows, e.g. "Europe/Amsterdam". */
export function isValidTimeZone(zone: string): boolean {
	try {
		new Intl.DateTimeFormat("en-GB", { timeZone: zone });
		return true;
	} catch {
		return false;
	}
}

/**
 * Escapes text written by someone else so it can't be read as formatting, a
 * link or a mention marker. Line breaks become spaces.
 */
export function escapeMarkdown(text: string): string {
	return text
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[\\*_~`|<>[\]]/g, "\\$&");
}

/**
 * Shows text written by someone else as a code span, so nothing in it can act
 * as formatting, a link, a mention, a heading or a list. Control and invisible
 * characters become spaces, backticks become apostrophes, and long text is cut
 * to `max` characters. Returns `fallback` when nothing is left.
 */
export function inlineCode(text: string, max = 200, fallback = "(empty)"): string {
	const clean = text
		.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/`/g, "'");
	if (clean === "") return fallback;
	const chars = [...clean];
	const shown = chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : clean;
	return `\`${shown}\``;
}
