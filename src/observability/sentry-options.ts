import * as Sentry from "@sentry/node";
import type { SentryConfig } from "../config.ts";
import { scrubDeep } from "./scrub.ts";

/**
 * What Sentry receives from log lines: `info` and above, whatever `LOG_LEVEL` says
 * (debug is for the console and the file). The levels are sent as Sentry Logs, not
 * as error events: real failures reach Sentry as events through the `ErrorReporter`.
 */
export const SENTRY_LOG_LEVELS = ["info", "warn", "error", "fatal"] as const;

/**
 * The Sentry settings, in one place so they can be tested. `instrument.ts` passes
 * them to `Sentry.init`. Pixel's pino logger is picked up by the pino integration, so
 * every log line goes to Sentry Logs as well as to the file and the console, after
 * secrets have been scrubbed from it.
 */
export function sentryOptions(sentry: SentryConfig): Sentry.NodeOptions {
	return {
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
		integrations: [Sentry.pinoIntegration({ log: { levels: [...SENTRY_LOG_LEVELS] } })],
		beforeSend: (event) => scrubDeep(event),
		beforeBreadcrumb: (breadcrumb) => scrubDeep(breadcrumb),
		beforeSendLog: (log) => scrubDeep(log),
	};
}
