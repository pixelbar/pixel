import type { Logger } from "../core/logger.ts";

/** What a rejection or exception carries, as an `Error` the logger can serialise (the reason can be anything). */
function asError(reason: unknown): Error {
	return reason instanceof Error ? reason : new Error(`non-error thrown: ${String(reason)}`);
}

/**
 * Makes sure failures that nothing caught reach the log file and Sentry too, not
 * just the console: an unhandled promise rejection is logged and the bot carries
 * on (like Sentry's own default), and an uncaught exception is logged just before
 * the process exits as it always does. Neither changes whether the process exits.
 */
export function logProcessFailures(
	logger: Logger,
	proc: Pick<NodeJS.Process, "on"> = process,
): void {
	proc.on("unhandledRejection", (reason: unknown) => {
		logger.error(
			{ event: "process.unhandled_rejection", err: asError(reason) },
			"unhandled promise rejection",
		);
	});
	proc.on("uncaughtExceptionMonitor", (error: Error, origin: string) => {
		logger.error({ event: "process.uncaught_exception", origin, err: error }, "uncaught exception");
	});
}
