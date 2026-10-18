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

/** `{ a: { b: 1 } }` under `x` becomes `{ "x.a.b": 1 }`: span attributes are flat and primitive. */
function flatAttributes(
	prefix: string,
	value: unknown,
	out: Record<string, string | number | boolean> = {},
): Record<string, string | number | boolean> {
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		out[prefix] = value;
	} else if (value !== null && typeof value === "object") {
		for (const [key, item] of Object.entries(value)) flatAttributes(`${prefix}.${key}`, item, out);
	}
	return out;
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
			// the command runs, however deep, carries the user and the command. The span
			// is the trace for this command (Discord isn't HTTP, so nothing else starts one).
			return Sentry.withIsolationScope((scope) => {
				const attributes = {
					command,
					feature,
					platform: principal.platform,
					tier: principal.tier,
				};
				scope.setTags(attributes);
				scope.setUser(sentryUser(principal));
				Sentry.metrics.count("pixel.command", 1, { attributes });
				return Sentry.startSpan({ name: command, op: "command", attributes }, run);
			});
		},
		breadcrumb(category, message, data) {
			Sentry.addBreadcrumb({ category, message, level: "info", ...(data ? { data } : {}) });
		},
		attach(source, data) {
			// A context shows as its own section on any error reported while this command runs
			// (the isolation scope follows the work); the span attributes put the same facts on
			// the command's trace, which is where a successful call shows.
			Sentry.setContext(source, data);
			Sentry.getActiveSpan()?.setAttributes(flatAttributes(source, data));
		},
	};
}
