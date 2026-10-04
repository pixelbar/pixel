import { actorRef } from "../../core/access.ts";
import { UserFacingError } from "../../core/errors.ts";
import type { Feature } from "../../core/feature.ts";
import type { FeedbackSink } from "../../core/ports/feedback.ts";
import { RateLimiter } from "../../core/rate-limit.ts";

export const MIN_FEEDBACK_LENGTH = 3;
export const MAX_FEEDBACK_LENGTH = 1000;

export type FeedbackDeps = {
	sink: FeedbackSink;
	/**
	 * How often one person may send feedback. It goes to a person's inbox, so this
	 * is much tighter than the limit on ordinary commands: a few at once, then one
	 * every ten minutes.
	 */
	limiter?: RateLimiter;
};

/**
 * `/feedback message:` sends a message to Pixel's maintainers. Anyone can use it,
 * guests included, which is why it is rate limited per person. The message is
 * only ever passed to the sink: it is never logged here, only its length.
 */
export function createFeedbackFeature({ sink, limiter }: FeedbackDeps): Feature {
	const limit = limiter ?? new RateLimiter({ capacity: 3, refillPerSecond: 1 / 600 });
	return {
		name: "feedback",
		commands: [
			{
				name: "feedback",
				description: "Send feedback about Pixel to its maintainers",
				access: { minTier: "guest" },
				private: true,
				options: [
					{
						name: "message",
						description: `What you'd like to tell us (${MIN_FEEDBACK_LENGTH}–${MAX_FEEDBACK_LENGTH} characters)`,
						type: "string",
						required: true,
					},
				],
				handler: async ({ args, principal, logger }) => {
					const message = String(args.message).replace(/\s+/g, " ").trim();
					const length = [...message].length;
					if (length < MIN_FEEDBACK_LENGTH) {
						throw new UserFacingError("Please write a little more, so we know what you mean.");
					}
					if (length > MAX_FEEDBACK_LENGTH) {
						throw new UserFacingError(
							`That's a bit long: please keep it to ${MAX_FEEDBACK_LENGTH} characters.`,
						);
					}
					if (!limit.tryTake(actorRef(principal))) {
						throw new UserFacingError(
							"You've sent a few messages already. Please try again a little later.",
						);
					}
					if (!sink.send({ message, from: principal })) {
						throw new UserFacingError("Feedback isn't set up right now, sorry.");
					}
					// Only the length: what people write is theirs, and doesn't belong in our logs.
					logger.info({ event: "feedback.sent", length }, "feedback sent");
					return {
						text: "Thank you, your feedback was sent to Pixel's maintainers, with your Discord name and ID so they can follow up.",
					};
				},
			},
		],
	};
}
