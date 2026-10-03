/**
 * Loaded with `node --import` before the app so Sentry can instrument
 * everything that follows. Does nothing when SENTRY_DSN is unset.
 */
import * as Sentry from "@sentry/node";
import { loadSentryConfig } from "./config.ts";
import { scrubDeep } from "./observability/scrub.ts";

const sentry = loadSentryConfig();

if (sentry) {
	Sentry.init({
		dsn: sentry.dsn,
		environment: sentry.environment,
		release: sentry.release,
		// Collect nothing personal by default. Stack frame variables are off
		// because locals can hold tokens or Discord IDs.
		dataCollection: {
			userInfo: false,
			cookies: false,
			httpHeaders: false,
			httpBodies: [],
			urlQueryParams: false,
			stackFrameVariables: false,
		},
		includeServerName: false,
		tracesSampleRate: 0,
		beforeSend: (event) => scrubDeep(event),
		beforeBreadcrumb: (breadcrumb) => scrubDeep(breadcrumb),
	});
}
