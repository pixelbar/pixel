import * as Sentry from "@sentry/node";
import { actorRef } from "../core/access.ts";
import type { FeedbackSink } from "../core/ports/feedback.ts";
import { scrubString } from "./scrub.ts";

/**
 * Sends `/feedback` messages to Sentry as user feedback, with who they're from
 * (the stable `discord:<id>` plus name and handle, like error reports) so the
 * maintainers can follow up. Anything that looks like a secret is redacted first,
 * in case someone pastes one. Returns false when Sentry isn't configured.
 */
export function createSentryFeedback(): FeedbackSink {
	return {
		send({ message, from }) {
			if (!Sentry.getClient()) return false;
			Sentry.withScope((scope) => {
				scope.setUser({
					id: actorRef(from),
					...(from.handle ? { username: from.handle } : {}),
					name: from.displayName,
				});
				Sentry.captureFeedback(
					{
						message: scrubString(message),
						name: from.displayName,
						source: from.platform,
						tags: { command: "feedback", platform: from.platform, tier: from.tier },
					},
					undefined,
					scope,
				);
			});
			return true;
		},
	};
}
