import { accessSync, constants, mkdirSync } from "node:fs";
import { join } from "node:path";
import pino, { type DestinationStream, type TransportTargetOptions } from "pino";
import type { Config } from "../config.ts";
import type { Logger } from "../core/logger.ts";
import { scrubString } from "./scrub.ts";

/** Paths pino replaces with "[redacted]" wherever they appear in a log entry. */
export const REDACT_PATHS = [
	"token",
	"*.token",
	"headers.authorization",
	"*.headers.authorization",
];

/** Log files are `pixel.<date>.<n>.log`, with `current.log` always pointing at the live one. */
export const LOG_FILE_PREFIX = "pixel";
/** A new file when this size is reached, and at least one a day. */
export const LOG_FILE_SIZE = "20m";
/** How many rotated files to keep besides the live one: about two weeks. */
export const LOG_FILES_KEPT = 14;

export type LogConfig = Pick<Config, "env" | "logLevel" | "version" | "logDir">;

/**
 * Where logs go: the console (readable locally, JSON elsewhere) and, when there is a
 * directory, a rotating file of JSON lines (private to the user running Pixel).
 * Sentry gets the same entries through its pino integration (`instrument.ts`), so
 * every log line reaches all three from the one logger.
 */
export function logTargets(
	config: Pick<LogConfig, "env" | "logLevel">,
	dir: string | undefined,
	console = true,
): TransportTargetOptions[] {
	const targets: TransportTargetOptions[] = [];
	if (console) {
		targets.push(
			config.env === "local"
				? { target: "pino-pretty", level: config.logLevel, options: {} }
				: { target: "pino/file", level: config.logLevel, options: { destination: 1 } },
		);
	}
	if (dir) {
		targets.push({
			target: "pino-roll",
			level: config.logLevel,
			options: {
				file: join(dir, LOG_FILE_PREFIX),
				extension: ".log",
				frequency: "daily",
				dateFormat: "yyyy-MM-dd",
				size: LOG_FILE_SIZE,
				symlink: true,
				mkdir: true,
				mode: 0o600,
				limit: { count: LOG_FILES_KEPT, removeOtherLogFiles: true },
			},
		});
	}
	return targets;
}

/** Whether Pixel can write in `dir`, creating it if needed. Never throws. */
export function canWriteLogs(dir: string): boolean {
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		accessSync(dir, constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Creates the app logger. Whatever is written has token shapes masked (see
 * `scrub.ts`). A custom `destination` (tests) always gets plain JSON and
 * nothing else. Otherwise it logs to the console and to a rotating file; if the log
 * directory can't be written it carries on with the console and says so, so a
 * read-only disk never stops the bot (the console and Sentry still have everything).
 */
export function createLogger(
	config: LogConfig,
	destination?: DestinationStream,
	options: { console?: boolean } = {},
): Logger {
	const base = {
		level: config.logLevel,
		base: { env: config.env, version: config.version },
		redact: { paths: REDACT_PATHS, censor: "[redacted]" },
		// A last line of defence for everything written, console and file: code shouldn't log
		// a token, but if one slips into a message or an error, it's masked. The patterns only
		// match token shapes, which hold no quotes, so the line stays valid JSON.
		hooks: { streamWrite: scrubString },
	};
	if (destination) return pino(base, destination);

	const dir = config.logDir && canWriteLogs(config.logDir) ? config.logDir : undefined;
	const logger = pino(base, pino.transport({ targets: logTargets(config, dir, options.console) }));
	if (config.logDir && !dir) {
		logger.warn(
			{ event: "log.file_unavailable" },
			"can't write the log directory, so logs only go to the console and Sentry",
		);
	}
	return logger;
}
