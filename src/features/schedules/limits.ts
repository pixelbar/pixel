import type { ChannelPost } from "../../core/channel-posts.ts";
import { UserFacingError } from "../../core/errors.ts";
import { type Interpolate, interpolateChannelPost } from "../../core/interpolate.ts";
import {
	type LocalDateTime,
	nextOccurrence,
	type Recurrence,
	toLocal,
} from "../../core/recurrence.ts";
import { describeWhen } from "../../core/when.ts";
import {
	MAX_MESSAGE_LENGTH,
	MAX_POLL_ANSWER,
	MAX_POLL_QUESTION,
} from "../../services/schedules.ts";

/**
 * The platform's length limits apply to a post after its `{{tokens}}` are filled, and
 * tokens grow (`{{date}}` is 8 characters, "30 September 2026" is 17). So a body that
 * fits as typed can be too long when it goes out. Checked at create and edit time;
 * clipped as a last resort at post time so a schedule never fails at every occurrence.
 */

/** How many upcoming occurrences are checked at create and edit time. */
export const CHECKED_OCCURRENCES = 12;

const length = (text: string) => [...text].length;

/** What's too long in a filled post, or undefined if it all fits. */
export function overLimit(post: ChannelPost): string | undefined {
	if (post.kind === "message") {
		return length(post.text) > MAX_MESSAGE_LENGTH
			? `the message would be over Discord's ${MAX_MESSAGE_LENGTH}-character limit`
			: undefined;
	}
	if (length(post.question) > MAX_POLL_QUESTION) {
		return `the question would be over Discord's ${MAX_POLL_QUESTION}-character limit`;
	}
	if (post.answers.some((answer) => length(answer) > MAX_POLL_ANSWER)) {
		return `an answer would be over Discord's ${MAX_POLL_ANSWER}-character limit`;
	}
	return undefined;
}

/**
 * Refuses a post that's too long once its tokens are filled, at any of its next
 * occurrences from `now` (or at `now` if it has none left).
 */
export function checkFilledLength(
	post: ChannelPost,
	timing: { start: LocalDateTime; recurrence: Recurrence },
	zone: string,
	now: Date,
	interpolator: Interpolate,
): void {
	const occurrences: Date[] = [];
	let after = now;
	for (let i = 0; i < CHECKED_OCCURRENCES; i++) {
		const next = nextOccurrence(timing.start, timing.recurrence, zone, after);
		if (!next) break;
		occurrences.push(next);
		after = next;
	}
	for (const at of occurrences.length > 0 ? occurrences : [now]) {
		const problem = overLimit(
			interpolateChannelPost(post, (text) => interpolator.interpolate(text, at)),
		);
		if (problem) {
			throw new UserFacingError(
				`With its tokens filled in, ${problem} on ${describeWhen(toLocal(at, zone))}. Make it shorter.`,
			);
		}
	}
}

function clip(text: string, max: number): string {
	const chars = [...text];
	return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

/** The filled post cut down to the platform's limits, and whether anything was cut. */
export function clipToLimits(post: ChannelPost): { post: ChannelPost; clipped: boolean } {
	if (!overLimit(post)) return { post, clipped: false };
	if (post.kind === "message") {
		return { post: { ...post, text: clip(post.text, MAX_MESSAGE_LENGTH) }, clipped: true };
	}
	return {
		post: {
			...post,
			question: clip(post.question, MAX_POLL_QUESTION),
			answers: post.answers.map((answer) => clip(answer, MAX_POLL_ANSWER)),
		},
		clipped: true,
	};
}
