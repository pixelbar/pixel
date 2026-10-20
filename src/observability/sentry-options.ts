import * as Sentry from "@sentry/node";
import { nodeProfilingIntegration } from "@sentry/profiling-node";
import type { SentryConfig } from "../config.ts";
import { scrubDeep } from "./scrub.ts";

/**
 * What Sentry receives from log lines: `info` and above, whatever `LOG_LEVEL` says
 * (debug is for the console and the file). The levels are sent as Sentry Logs, not
 * as error events: real failures reach Sentry as events through the `ErrorReporter`.
 */
export const SENTRY_LOG_LEVELS = ["info", "warn", "error", "fatal"] as const;

/**
 * Incoming requests that aren't worth a Sentry trace: everything but the webhooks
 * (`/hooks/...`). That covers Azure's `/healthz` and `/readyz` probes, and whatever the
 * internet tries against the public webhook port. None of them count as request
 * sessions either: Pixel's session is the process, not an HTTP request.
 */
export function isUntracedRequest(urlPath: string): boolean {
	const path = urlPath.split("?")[0] ?? urlPath;
	return !path.startsWith("/hooks/");
}

/**
 * The Sentry settings, in one place so they can be tested. `instrument.ts` passes
 * them to `Sentry.init`. Pixel's pino logger is picked up by the pino integration, so
 * every log line goes to Sentry Logs as well as to the file and the console, after
 * secrets have been scrubbed from it.
 *
 * Tracing, process sessions, runtime metrics and CPU profiling are on: this is
 * a long-running Discord bot, not a request-scoped web app. Of incoming requests,
 * only the webhooks are traced. A missing DSN never reaches here.
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
		profileSessionSampleRate: sentry.profileSessionSampleRate,
		// Profile sampled command spans (and their outbound HTTP), not the whole process.
		profileLifecycle: "trace",
		integrations: [
			Sentry.httpIntegration({
				ignoreIncomingRequests: isUntracedRequest,
				// Health probes would otherwise be one "session" each. Crash-free
				// rate comes from processSessionIntegration (a default), not HTTP.
				sessions: false,
			}),
			Sentry.pinoIntegration({ log: { levels: [...SENTRY_LOG_LEVELS] } }),
			Sentry.nodeRuntimeMetricsIntegration(),
			// Skip wiring the profiler when the rate is 0: in trace mode the SDK
			// still starts it otherwise.
			...(sentry.profileSessionSampleRate > 0 ? [nodeProfilingIntegration()] : []),
		],
		// Spans are streamed (the SDK default, pinned here because the scrubbing below
		// depends on it): each span goes through `beforeSendSpan`, and there are no
		// transaction events for `beforeSendTransaction` to see. Spans and breadcrumbs keep
		// the path of outgoing requests, and Discord's interaction callback and webhook
		// paths carry a token that can post as the bot, so they are scrubbed too.
		traceLifecycle: "stream",
		beforeSend: (event) => scrubDeep(event),
		beforeSendSpan: (span) => scrubDeep(span),
		beforeBreadcrumb: (breadcrumb) => scrubDeep(breadcrumb),
		beforeSendLog: (log) => scrubDeep(log),
	};
}
