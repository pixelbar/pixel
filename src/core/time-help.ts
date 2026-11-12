import type { HowLongProblem } from "./how-long.ts";
import { describeDate, describeWhen } from "./when.ts";

/**
 * What Pixel says when it can't use a time someone typed: which field, why
 * (when it knows), and examples of what works. Every time input uses these, so
 * the help reads the same everywhere. Nothing a person typed is repeated back,
 * only what Pixel understood from it.
 */

/** Examples for a moment ("When", "From", "Until"). */
export const WHEN_EXAMPLES = ["19:00", "fri 8pm", "14th oct", "tomorrow noon", "in 2 hours"];
/** Examples for how long something lasts. */
export const HOW_LONG_EXAMPLES = ["45m", "2h30", "until 17:00", "till 5pm"];
/** Examples for a time of day. */
export const TIME_OF_DAY_EXAMPLES = ["17:00", "5pm", "1730", "noon", "midnight"];

/**
 * Where the time was typed: the field's name as people see it (bold in the
 * message), the time zone it's read in, and an optional last sentence such as
 * "Change it in Reminders."
 */
export type TimeField = { field: string; zone: string; hint?: string };

/** "**When**: that's Mon 12 Oct 2026, 09:00, which has already passed. Type a day, a time or both in …, for example …" */
export function whenRefusal(problem: HowLongProblem, where: TimeField): string {
	return refusal(
		where,
		reason(problem),
		`Type a day, a time or both in ${where.zone}, for example ${examples(WHEN_EXAMPLES)}.`,
	);
}

/** As `whenRefusal`, for how long something lasts. `examples` replaces the usual ones. */
export function howLongRefusal(
	problem: HowLongProblem,
	where: TimeField & { examples?: readonly string[] },
): string {
	return refusal(
		where,
		reason(problem),
		`Type how long, or until when in ${where.zone}, for example ${examples(where.examples ?? HOW_LONG_EXAMPLES)}.`,
	);
}

/** As `whenRefusal`, for a time of day on its own. */
export function timeOfDayRefusal(where: TimeField): string {
	return refusal(
		where,
		reason({ kind: "unclear" }),
		`Type a time of day in ${where.zone}, for example ${examples(TIME_OF_DAY_EXAMPLES)}.`,
	);
}

/** "`19:00`, `fri 8pm` or `in 2 hours`" */
export function examples(list: readonly string[]): string {
	const quoted = list.map((e) => `\`${e}\``);
	const last = quoted.pop();
	return quoted.length === 0 ? (last ?? "") : `${quoted.join(", ")} or ${last}`;
}

function refusal(where: TimeField, why: string, how: string): string {
	return [`**${where.field}**: ${why}`, how, where.hint].filter(Boolean).join(" ");
}

function reason(problem: HowLongProblem): string {
	switch (problem.kind) {
		case "empty":
			return "it's empty.";
		case "unclear":
			return "I couldn't understand it.";
		case "past":
			return `that's ${describeWhen(problem.at)}, which has already passed.`;
		case "before-start":
			return `that's ${describeWhen(problem.at)}, which isn't after it starts.`;
		case "no-such-date":
			return `there's no ${describeDate(problem)}.`;
		case "vague":
			return `\`${problem.word}\` is too vague, so give a time.`;
		case "not-evening":
			return "tonight means 17:00 to 23:59.";
	}
}
