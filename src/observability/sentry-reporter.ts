import * as Sentry from "@sentry/node";
import type { PlatformActor } from "../core/access.ts";
import type { ErrorReporter } from "../core/ports/error-reporter.ts";

export function createSentryReporter(
	pseudonymize: (actor: PlatformActor) => string,
): ErrorReporter {
	return {
		capture(error, { command, feature, principal }) {
			Sentry.withScope((scope) => {
				scope.setTags({ command, feature, platform: principal.platform, tier: principal.tier });
				scope.setUser({ id: pseudonymize(principal) });
				Sentry.captureException(error);
			});
		},
	};
}
