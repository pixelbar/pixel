import type { Suggestion } from "./command.ts";
import { formatMinutes } from "./duration.ts";
import { type HowLong, readHowLong } from "./how-long.ts";
import { type LocalDateTime, toLocal } from "./recurrence.ts";
import { reasonFor, TIME_OF_DAY_EXAMPLES, WHEN_EXAMPLES } from "./time-help.ts";
import {
	describeWhen,
	formatTimeOfDay,
	parseTimeOfDay,
	readWhen,
	type WhenProblem,
} from "./when.ts";

/**
 * Autocomplete for options that take a time: as someone types, Pixel shows
 * what it understood ("fri 8pm → Fri 16 Oct 2026, 20:00"), or why it can't use
 * it, so they see the result before they send. Like every suggestion, this is
 * a convenience and never validation: the handler reads the value again.
 * Picking a suggestion submits what was typed (or the example), not the
 * resolved time, so "now" or "in 2 hours" still count from when it's sent.
 */

/** What a preview shows: the understood value as words, or why it can't be used. */
export type Preview = { ok: true; label: string } | { ok: false; why: string };

/** Examples for how long, as offered when nothing matches yet. */
export const HOW_LONG_SUGGESTIONS = ["30m", "1h", "2h", "until 17:00", "until midnight"];

/**
 * Suggestions for `typed`: what it means first, then the `examples` that contain
 * it ("noon" finds "tomorrow noon"), each with what it means. When neither can be used, one suggestion
 * says why, with what was typed as its value (picking it gets the full help).
 */
export function previewSuggestions(
	typed: string,
	preview: (text: string) => Preview,
	examples: readonly string[],
): Suggestion[] {
	const text = typed.trim().replace(/\s+/g, " ");
	const needle = text.toLowerCase();
	const out: Suggestion[] = [];
	const own = text === "" ? undefined : preview(text);
	if (own?.ok) out.push({ name: `${text} → ${own.label}`, value: text });
	for (const example of examples) {
		if (example.toLowerCase() === needle || !example.toLowerCase().includes(needle)) continue;
		const shown = preview(example);
		if (shown.ok) out.push({ name: `${example} → ${shown.label}`, value: example });
	}
	if (out.length === 0 && own && !own.ok) out.push({ name: own.why, value: text });
	return out;
}

/** Suggestions for a moment, read like `readWhen`: "fri 8pm → Fri 16 Oct 2026, 20:00". */
export function suggestWhen(
	typed: string,
	after: Date,
	zone: string,
	options: { now?: Date; examples?: readonly string[] } = {},
): Suggestion[] {
	return previewSuggestions(
		typed,
		(text) => {
			const read = readWhen(text, after, zone, options.now ? { now: options.now } : {});
			return read.ok
				? { ok: true, label: describeWhen(read.at) }
				: { ok: false, why: whyNot(read.problem, WHEN_EXAMPLES) };
		},
		options.examples ?? WHEN_EXAMPLES,
	);
}

/** Suggestions for a time of day on its own: "5pm → 17:00". */
export function suggestTimeOfDay(typed: string, examples = TIME_OF_DAY_EXAMPLES): Suggestion[] {
	return previewSuggestions(
		typed,
		(text) => {
			const time = parseTimeOfDay(text);
			return time
				? { ok: true, label: formatTimeOfDay(time) }
				: { ok: false, why: whyNot({ kind: "unclear" }, examples) };
		},
		examples,
	);
}

/**
 * Suggestions for how long from `start`, read like `readHowLong`: "2h30 →
 * until 12:30", "until 17:00 → 7h, until 17:00".
 */
export function suggestHowLong(
	typed: string,
	start: Date,
	zone: string,
	options: { now?: Date; examples?: readonly string[] } = {},
): Suggestion[] {
	const now = options.now ?? start;
	return previewSuggestions(
		typed,
		(text) => {
			const read = readHowLong(text, start, zone, { now });
			return read.ok
				? { ok: true, label: describeHowLong(read.value, now, zone) }
				: { ok: false, why: whyNot(read.problem, HOW_LONG_SUGGESTIONS) };
		},
		options.examples ?? HOW_LONG_SUGGESTIONS,
	);
}

/** "until 12:30" for a duration, "2h30, until 12:30" for an end; the date too when it isn't today. */
export function describeHowLong(value: HowLong, now: Date, zone: string): string {
	const until = `until ${describeEnd(toLocal(value.end, zone), toLocal(now, zone))}`;
	return value.by === "duration" ? until : `${formatMinutes(value.minutes)}, ${until}`;
}

/** "17:00" on the same day as `today`, otherwise "Sat 17 Oct 2026, 08:00". */
export function describeEnd(end: LocalDateTime, today: LocalDateTime): string {
	const sameDay = end.year === today.year && end.month === today.month && end.day === today.day;
	return sameDay ? formatTimeOfDay(end) : describeWhen(end);
}

/** A suggestion's text for something it can't use: the reason, or examples when it simply isn't understood. */
function whyNot(problem: WhenProblem, examples: readonly string[]): string {
	if (problem.kind === "unclear" || problem.kind === "empty") {
		return `Not understood yet. Try ${examples.slice(0, 3).join(", ")}`;
	}
	// Suggestions are plain text, so no Markdown quotes.
	const reason = reasonFor(problem).replace(/`/g, '"');
	return reason.charAt(0).toUpperCase() + reason.slice(1);
}
