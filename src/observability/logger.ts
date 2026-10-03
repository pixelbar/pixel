import { type DestinationStream, pino } from "pino";
import type { Config } from "../config.ts";
import type { Logger } from "../core/logger.ts";

/** Paths pino replaces with "[redacted]" wherever they appear in a log entry. */
export const REDACT_PATHS = [
	"token",
	"*.token",
	"headers.authorization",
	"*.headers.authorization",
];

/**
 * Creates the app logger: JSON to stdout, pretty-printed locally. A custom
 * `destination` (tests) always gets plain JSON.
 */
export function createLogger(
	config: Pick<Config, "env" | "logLevel" | "version">,
	destination?: DestinationStream,
): Logger {
	const options = {
		level: config.logLevel,
		base: { env: config.env, version: config.version },
		redact: { paths: REDACT_PATHS, censor: "[redacted]" },
	};
	if (destination) return pino(options, destination);
	return pino({
		...options,
		...(config.env === "local" ? { transport: { target: "pino-pretty" } } : {}),
	});
}
