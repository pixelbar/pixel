import type { Suggestion } from "./command.ts";
import { reasonFor } from "./time-help.ts";
import type { WhenProblem } from "./when.ts";

/**
 * Autocomplete for options that take a time: as someone types, Pixel shows
 * what it understood ("2h → until 12:30"), or why it can't use it, so they see
 * the result before they send. Like every suggestion, this is a convenience
 * and never validation: the handler reads the value again. Picking a
 * suggestion submits what was typed (or the example), not the resolved time,
 * so "now" or "in 2 hours" still count from when it's sent. Only slash options
 * can have suggestions: Discord forms (modals) can't.
 */

/** What a preview shows: the understood value as words, or why it can't be used. */
export type Preview = { ok: true; label: string } | { ok: false; why: string };

/**
 * Suggestions for `typed`: what it means first, then the `examples` that contain
 * it ("noon" finds "tomorrow noon"), each with what it means. When neither can
 * be used, one suggestion says why, with what was typed as its value (picking it
 * gets the full help).
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

/**
 * A suggestion's text for something it can't use: the reason ("That's …, which
 * has already passed."), or the first few `examples` when it simply isn't
 * understood, which is usual while someone is still typing.
 */
export function whyNot(problem: WhenProblem, examples: readonly string[]): string {
	if (problem.kind === "unclear" || problem.kind === "empty") {
		return `Not understood yet. Try ${examples.slice(0, 3).join(", ")}`;
	}
	// Suggestions are plain text, so no Markdown quotes.
	const reason = reasonFor(problem).replace(/`/g, '"');
	return reason.charAt(0).toUpperCase() + reason.slice(1);
}
