import * as Sentry from "@sentry/node";
import { actorRef } from "../core/access.ts";
import type { ErrorReporter } from "../core/ports/error-reporter.ts";

/**
 * Reports unexpected errors to Sentry, tagged with the command and the user:
 * the stable platform ID (e.g. "discord:123…") plus handle and display name so
 * humans can recognise who hit the error. Act on the ID, not the names.
 */
export function createSentryReporter(): ErrorReporter {
	return {
		capture(error, { command, feature, principal }) {
			Sentry.withScope((scope) => {
				scope.setTags({ command, feature, platform: principal.platform, tier: principal.tier });
				scope.setUser({
					id: actorRef(principal),
					...(principal.handle ? { username: principal.handle } : {}),
					name: principal.displayName,
				});
				Sentry.captureException(error);
			});
		},
	};
}
