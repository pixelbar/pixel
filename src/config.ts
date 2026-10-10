import { z } from "zod";
import { isValidTimeZone } from "./core/format.ts";

/**
 * Environment configuration. This is the ONLY module that reads process.env.
 * Validation errors name the variable but never echo its value.
 */

const snowflake = z.string().regex(/^\d{17,20}$/, { error: "must be a Discord ID (17–20 digits)" });
const optional = <T extends z.ZodType>(schema: T) =>
	z.preprocess((v) => (v === "" ? undefined : v), schema.optional());
/** 0 drops everything, 1 keeps it all. Empty means the default. */
const sampleRate = optional(z.coerce.number().min(0).max(1));

const pixelEnv = z.enum(["local", "dev", "prod"]).default("local");
const pixelRuntime = z.enum(["local", "cloud"]).default("local");

const envSchema = z
	.object({
		PIXEL_ENV: pixelEnv,
		PIXEL_RUNTIME: pixelRuntime,
		PIXEL_VERSION: z.string().default("dev"),
		// Set by CI and the Docker build; from a checkout Pixel asks git instead.
		PIXEL_GIT_SHA: optional(
			z
				.string()
				.trim()
				.regex(/^[0-9a-f]{7,40}$/),
		),
		PIXEL_GIT_BRANCH: optional(z.string().trim().min(1).max(100)),
		LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
		PIXEL_ADMINS_FILE: z.string().default("config/admins.yaml"),
		PIXEL_MEMBERS_FILE: z.string().default("config/members.yaml"),
		PIXEL_DATA_DIR: z.string().min(1).default("data"),
		PIXEL_CONTENT_DIR: z.string().min(1).default("content"),
		PIXEL_HOME_ASSISTANT_DIR: z.string().min(1).default("config/home-assistant"),
		PIXEL_HOME_SYNC_MINUTES: z.coerce.number().int().min(0).max(1440).default(60),
		// How often Pixel checks in with its Sentry cron monitor. 0 turns the heartbeat off.
		PIXEL_HEARTBEAT_MINUTES: z.coerce.number().int().min(0).max(60).default(5),
		// Empty turns the log file off. Logs still go to the console and to Sentry.
		PIXEL_LOG_DIR: z.string().trim().default("data/logs"),
		PIXEL_TIMEZONE: z
			.string()
			.default("Europe/Amsterdam")
			.refine(isValidTimeZone, { error: "must be a time zone name like Europe/Amsterdam" }),
		HEALTH_PORT: z.coerce.number().int().min(0).max(65535).default(8080),
		SENTRY_DSN: optional(z.url()),
		// 0 drops every trace, 1 keeps them all. Empty uses the default (1).
		SENTRY_TRACES_SAMPLE_RATE: sampleRate,
		// Same for CPU profiles of those traces. Empty uses the default (1).
		SENTRY_PROFILE_SESSION_SAMPLE_RATE: sampleRate,
		SPACEAPI_URL: z.url({ protocol: /^https?$/ }).default("https://spaceapi.pixelbar.nl/"),

		DISCORD_TOKEN: z.string().min(1),
		DISCORD_APP_ID: snowflake,
		DISCORD_GUILD_ID: snowflake,
		DISCORD_ANNOUNCEMENTS_CHANNEL_ID: optional(snowflake),
		DISCORD_ANNOUNCE_LIVE_CHANNEL_ID: optional(snowflake),
		DISCORD_ANNOUNCE_TIMELINE_CHANNEL_ID: optional(snowflake),
		DISCORD_ANNOUNCE_BOT_CHANNEL_ID: optional(snowflake),
		// Unset, empty, "off" or "none" turns closing-time posts off.
		DISCORD_CLOSING_TIME_CHANNEL_ID: z.preprocess((v) => {
			if (typeof v === "string" && /^(off|none)$/i.test(v.trim())) return undefined;
			return v;
		}, optional(snowflake)),
		PIXEL_CLOSING_TIME_FILE: optional(z.string().trim().min(1)),
		// A role name, or its ID. Unset means that tier isn't mirrored to a Discord role.
		DISCORD_ROLE_MEMBER: optional(z.string().trim().min(1).max(100)),
		DISCORD_ROLE_FRIEND: optional(z.string().trim().min(1).max(100)),

		// Both unset means Home Assistant is off. Setting only one is a mistake, so it stops startup.
		HOME_ASSISTANT_URL: optional(z.url({ protocol: /^https?$/ })),
		HOME_ASSISTANT_TOKEN: optional(z.string().trim().min(1)),
	})
	.refine((e) => (e.HOME_ASSISTANT_URL === undefined) === (e.HOME_ASSISTANT_TOKEN === undefined), {
		path: ["HOME_ASSISTANT_URL"],
		error: "set both HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN, or neither",
	});

export type Config = {
	env: "local" | "dev" | "prod";
	/** Where this process is running. Azure Container Apps sets `cloud`. `/admin status` shows this. */
	runtime: "local" | "cloud";
	version: string;
	/** The git commit and branch Pixel was built from, when given. */
	gitSha: string | undefined;
	gitBranch: string | undefined;
	logLevel: "debug" | "info" | "warn" | "error";
	access: { adminsFile: string; membersFile: string };
	/** Where Pixel keeps small bits of runtime state (e.g. `space.state`). */
	dataDir: string;
	/** Where the reviewed content lives (e.g. `info/*.md` for `/info`). Read-only. */
	contentDir: string;
	/** Where the Home Assistant device allow-list lives (`devices.yaml`). Only read when Home Assistant is configured. */
	homeAssistantDir: string;
	/** How often the Home Assistant inventory is synced, in minutes. 0 means only at startup and on reload. */
	homeSyncMinutes: number;
	/** How often Pixel checks in with its Sentry cron monitor, in minutes. 0 means off. */
	heartbeatMinutes: number;
	/** Where the rotating log file goes. Undefined means no file (console and Sentry only). */
	logDir: string | undefined;
	/** The time zone times are shown in, e.g. "Europe/Amsterdam". */
	timezone: string;
	healthPort: number;
	sentryDsn: string | undefined;
	/** How many traces Sentry keeps (0–1). Default 1. Unused without a DSN. */
	sentryTracesSampleRate: number;
	/** How many of those traces get a CPU profile (0–1). Default 1. Unused without a DSN. */
	sentryProfileSessionSampleRate: number;
	spaceApiUrl: string;
	discord: {
		token: string;
		appId: string;
		guildId: string;
		/**
		 * The channel where people post and read announcements and the weekly poll.
		 * `/info` points people at it. (Not the space-status posts: those are `announce`.)
		 */
		announcementsChannelId: string | undefined;
		announce: {
			/** One post per opening, edited to "closed" when the space closes. */
			liveChannelId: string | undefined;
			/** A new post for every open and every close; never edited. */
			timelineChannelId: string | undefined;
			/**
			 * Where Pixel says it came online or is going offline. Defaults to the
			 * announcements channel. Undefined means off.
			 */
			botChannelId: string | undefined;
			/** Closing-time reminder. Undefined means off. */
			closingTimeChannelId: string | undefined;
		};
		/**
		 * The Discord role each tier is mirrored to, by name or ID. Pixel pushes tiers
		 * to these roles and never reads them. Unset means not mirrored.
		 */
		roles: { member: string | undefined; friend: string | undefined };
	};
	/**
	 * How to reach Home Assistant: its address (for example the Nabu Casa cloud URL)
	 * and a long-lived token. Use a non-admin user's token: Home Assistant can't
	 * limit a token. The token is a secret. Undefined means Home Assistant is off.
	 */
	homeAssistant: { url: string; token: string } | undefined;
	/**
	 * Operator-authored closing-time body. Default `{dataDir}/closing-time.md`.
	 * Missing or empty file → the built-in default. Not a secret.
	 */
	closingTimeFile: string;
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
		runtime: e.PIXEL_RUNTIME,
		version: e.PIXEL_VERSION,
		gitSha: e.PIXEL_GIT_SHA,
		gitBranch: e.PIXEL_GIT_BRANCH,
		logLevel: e.LOG_LEVEL,
		access: { adminsFile: e.PIXEL_ADMINS_FILE, membersFile: e.PIXEL_MEMBERS_FILE },
		dataDir: e.PIXEL_DATA_DIR,
		contentDir: e.PIXEL_CONTENT_DIR,
		homeAssistantDir: e.PIXEL_HOME_ASSISTANT_DIR,
		homeSyncMinutes: e.PIXEL_HOME_SYNC_MINUTES,
		heartbeatMinutes: e.PIXEL_HEARTBEAT_MINUTES,
		logDir: e.PIXEL_LOG_DIR === "" ? undefined : e.PIXEL_LOG_DIR,
		timezone: e.PIXEL_TIMEZONE,
		healthPort: e.HEALTH_PORT,
		sentryDsn: e.SENTRY_DSN,
		sentryTracesSampleRate: e.SENTRY_TRACES_SAMPLE_RATE ?? 1,
		sentryProfileSessionSampleRate: e.SENTRY_PROFILE_SESSION_SAMPLE_RATE ?? 1,
		spaceApiUrl: e.SPACEAPI_URL,
		discord: {
			token: e.DISCORD_TOKEN,
			appId: e.DISCORD_APP_ID,
			guildId: e.DISCORD_GUILD_ID,
			announcementsChannelId: e.DISCORD_ANNOUNCEMENTS_CHANNEL_ID,
			announce: {
				liveChannelId: e.DISCORD_ANNOUNCE_LIVE_CHANNEL_ID,
				timelineChannelId: e.DISCORD_ANNOUNCE_TIMELINE_CHANNEL_ID,
				botChannelId: e.DISCORD_ANNOUNCE_BOT_CHANNEL_ID ?? e.DISCORD_ANNOUNCEMENTS_CHANNEL_ID,
				closingTimeChannelId: e.DISCORD_CLOSING_TIME_CHANNEL_ID,
			},
			roles: { member: e.DISCORD_ROLE_MEMBER, friend: e.DISCORD_ROLE_FRIEND },
		},
		homeAssistant:
			e.HOME_ASSISTANT_URL !== undefined && e.HOME_ASSISTANT_TOKEN !== undefined
				? { url: e.HOME_ASSISTANT_URL, token: e.HOME_ASSISTANT_TOKEN }
				: undefined,
		closingTimeFile: e.PIXEL_CLOSING_TIME_FILE ?? `${e.PIXEL_DATA_DIR}/closing-time.md`,
	};
}

const sentrySchema = z.object({
	PIXEL_ENV: pixelEnv,
	PIXEL_VERSION: z.string().default("dev"),
	SENTRY_DSN: optional(z.url()),
	SENTRY_TRACES_SAMPLE_RATE: sampleRate,
	SENTRY_PROFILE_SESSION_SAMPLE_RATE: sampleRate,
});

/**
 * The narrow slice instrument.ts needs before the app loads. Never throws:
 * a bad DSN just disables Sentry, and loadConfig reports it properly later.
 */
export type SentryConfig = {
	dsn: string;
	environment: string;
	release: string;
	tracesSampleRate: number;
	profileSessionSampleRate: number;
};

export function loadSentryConfig(env: NodeJS.ProcessEnv = process.env): SentryConfig | undefined {
	const result = sentrySchema.safeParse(env);
	if (!result.success || !result.data.SENTRY_DSN) return undefined;
	return {
		dsn: result.data.SENTRY_DSN,
		environment: result.data.PIXEL_ENV,
		release: result.data.PIXEL_VERSION,
		tracesSampleRate: result.data.SENTRY_TRACES_SAMPLE_RATE ?? 1,
		profileSessionSampleRate: result.data.SENTRY_PROFILE_SESSION_SAMPLE_RATE ?? 1,
	};
}
