import type { Principal } from "../access.ts";

/**
 * Where people's feedback about Pixel goes (Sentry's user feedback in production).
 * This is the one place a person's own message is deliberately sent off to a
 * tracker, because they chose to send it with `/feedback`. Everything else in
 * Pixel keeps message content out of logs and reports.
 */
export type FeedbackSink = {
	/**
	 * Sends the message, with who it's from so the maintainers can follow up.
	 * Returns false when there is nowhere to send it (nothing is configured).
	 */
	send(feedback: { message: string; from: Principal }): boolean;
};

/** For when feedback isn't set up: nothing is sent and the command says so. */
export const nullFeedbackSink: FeedbackSink = { send: () => false };
