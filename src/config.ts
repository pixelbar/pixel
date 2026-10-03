import { z } from "zod";

/**
 * Environment configuration. This is the ONLY module that reads process.env.
 * Validation errors name the variable but never echo its value.
 */

const snowflake = z.string().regex(/^\d{17,20}$/, { error: "must be a Discord ID (17–20 digits)" });
const optional = <T extends z.ZodType>(schema: T) =>
	z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

const pixelEnv = z.enum(["local", "dev", "prod"]).default("local");

const envSchema = z.object({
	PIXEL_ENV: pixelEnv,
	PIXEL_VERSION: z.string().default("dev"),
	LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
	PIXEL_ADMINS_FILE: z.string().default("config/admins.yaml"),
	PIXEL_MEMBERS_FILE: z.string().default("config/members.yaml"),
	HEALTH_PORT: z.coerce.number().int().min(0).max(65535).default(8080),
	SENTRY_DSN: optional(z.url()),
	SPACEAPI_URL: z.url({ protocol: /^https?$/ }).default("https://spaceapi.pixelbar.nl/"),

	DISCORD_TOKEN: z.string().min(1),
	DISCORD_APP_ID: snowflake,
	DISCORD_GUILD_ID: snowflake,
});

export type Config = {
	env: "local" | "dev" | "prod";
	version: string;
	logLevel: "debug" | "info" | "warn" | "error";
	access: { adminsFile: string; membersFile: string };
	healthPort: number;
	sentryDsn: string | undefined;
	spaceApiUrl: string;
	discord: { token: string; appId: string; guildId: string };
};

export class ConfigError extends Error {
	override name = "ConfigError";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	const result = envSchema.safeParse(env);
	if (!result.success) {
		const problems = result.error.issues.map(
			(issue) => `  - ${issue.path.join(".")}: ${issue.message}`,
		);
		throw new ConfigError(`Invalid environment configuration:\n${problems.join("\n")}`);
	}
	const e = result.data;
	return {
		env: e.PIXEL_ENV,
		version: e.PIXEL_VERSION,
		logLevel: e.LOG_LEVEL,
		access: { adminsFile: e.PIXEL_ADMINS_FILE, membersFile: e.PIXEL_MEMBERS_FILE },
		healthPort: e.HEALTH_PORT,
		sentryDsn: e.SENTRY_DSN,
		spaceApiUrl: e.SPACEAPI_URL,
		discord: { token: e.DISCORD_TOKEN, appId: e.DISCORD_APP_ID, guildId: e.DISCORD_GUILD_ID },
	};
}

const sentrySchema = z.object({
	PIXEL_ENV: pixelEnv,
	PIXEL_VERSION: z.string().default("dev"),
	SENTRY_DSN: optional(z.url()),
});

/**
 * The narrow slice instrument.ts needs before the app loads. Never throws:
 * a bad DSN just disables Sentry, and loadConfig reports it properly later.
 */
export function loadSentryConfig(
	env: NodeJS.ProcessEnv = process.env,
): { dsn: string; environment: string; release: string } | undefined {
	const result = sentrySchema.safeParse(env);
	if (!result.success || !result.data.SENTRY_DSN) return undefined;
	return {
		dsn: result.data.SENTRY_DSN,
		environment: result.data.PIXEL_ENV,
		release: result.data.PIXEL_VERSION,
	};
}
