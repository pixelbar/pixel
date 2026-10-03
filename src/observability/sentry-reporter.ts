import * as Sentry from "@sentry/node";
import { actorRef } from "../core/access.ts";
import type { ErrorReporter } from "../core/ports/error-reporter.ts";

/**
 * Reports unexpected errors to Sentry, tagged with the command and the user's
 * stable platform ID (e.g. "discord:123…") so issues can be traced per user.
 * Display names are never sent.
 */
export function createSentryReporter(): ErrorReporter {
	return {
		capture(error, { command, feature, principal }) {
			Sentry.withScope((scope) => {
				scope.setTags({ command, feature, platform: principal.platform, tier: principal.tier });
				scope.setUser({ id: actorRef(principal) });
				Sentry.captureException(error);
			});
		},
	};
}
