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
 * Azure (and local) probes hit these. They aren't worth a Sentry trace, and they
 * must not be counted as request sessions: Pixel's session is the process, not
 * an HTTP request.
 */
export function isHealthProbe(urlPath: string): boolean {
	const path = urlPath.split("?")[0] ?? urlPath;
	return path === "/healthz" || path === "/readyz";
}

/**
 * The Sentry settings, in one place so they can be tested. `instrument.ts` passes
 * them to `Sentry.init`. Pixel's pino logger is picked up by the pino integration, so
 * every log line goes to Sentry Logs as well as to the file and the console, after
 * secrets have been scrubbed from it.
 *
 * Tracing, process sessions and runtime metrics are on: this is a long-running
 * Discord bot, not a request-scoped web app. Incoming `/healthz` and `/readyz`
 * probes are ignored. A missing DSN never reaches here.
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
		sampleRate: 1,
		tracesSampleRate: sentry.tracesSampleRate,
		integrations: [
			Sentry.httpIntegration({
				ignoreIncomingRequests: isHealthProbe,
				// Health probes would otherwise be one "session" each. Crash-free
				// rate comes from processSessionIntegration (a default), not HTTP.
				sessions: false,
			}),
			Sentry.pinoIntegration({ log: { levels: [...SENTRY_LOG_LEVELS] } }),
			Sentry.nodeRuntimeMetricsIntegration(),
		],
		beforeSend: (event) => scrubDeep(event),
		beforeBreadcrumb: (breadcrumb) => scrubDeep(breadcrumb),
		beforeSendLog: (log) => scrubDeep(log),
	};
}
