import { pino } from "pino";
import type { Config } from "../config.ts";
import type { Logger } from "../core/logger.ts";

export function createLogger(config: Pick<Config, "env" | "logLevel" | "version">): Logger {
	return pino({
		level: config.logLevel,
		base: { env: config.env, version: config.version },
		redact: {
			paths: ["token", "*.token", "headers.authorization", "*.headers.authorization"],
			censor: "[redacted]",
		},
		...(config.env === "local" ? { transport: { target: "pino-pretty" } } : {}),
	});
}
