import * as Sentry from "@sentry/node";
import { actorRef } from "../core/access.ts";
import type { ErrorReportActor, ErrorReporter } from "../core/ports/error-reporter.ts";

/**
 * Reports unexpected errors to Sentry, tagged with the command and the user:
 * the stable platform ID (e.g. "discord:123…") plus handle and display name so
 * humans can recognise who hit the error. Act on the ID, not the names.
 */

/** The Sentry user for a person: their stable ID first, then names for humans. */
function sentryUser(actor: ErrorReportActor) {
	return {
		id: actorRef(actor),
		...(actor.handle ? { username: actor.handle } : {}),
		name: actor.displayName,
	};
}

export function createSentryReporter(): ErrorReporter {
	return {
		capture(error, { command, feature, principal }) {
			Sentry.withScope((scope) => {
				scope.setTags({ command, feature, platform: principal.platform, tier: principal.tier });
				scope.setUser(sentryUser(principal));
				Sentry.captureException(error);
			});
		},
		captureBackground(error, source, actor) {
			Sentry.withScope((scope) => {
				scope.setTag("source", source);
				if (actor) scope.setUser(sentryUser(actor));
				Sentry.captureException(error);
			});
		},
		withContext({ command, feature, principal }, run) {
			// The isolation scope follows the work across awaits, so anything reported while
			// the command runs, however deep, carries the user and the command.
			return Sentry.withIsolationScope((scope) => {
				scope.setTags({ command, feature, platform: principal.platform, tier: principal.tier });
				scope.setUser(sentryUser(principal));
				return run();
			});
		},
		breadcrumb(category, message, data) {
			Sentry.addBreadcrumb({ category, message, level: "info", ...(data ? { data } : {}) });
		},
	};
}
