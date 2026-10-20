import { z } from "zod";
import { ANNOUNCEMENT_KINDS, type AnnouncementKind } from "./core/announcement.ts";
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

/**
 * Extra headers for the space state API, as a JSON object of header name to value. The values
 * are secrets (they can carry values that must stay private), so the errors here never echo them.
 */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const extraHeaders = z.string().transform((raw, ctx) => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		parsed = undefined;
	}
	const entries =
		typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? Object.entries(parsed)
			: undefined;
	const valid =
		entries !== undefined &&
		entries.length > 0 &&
		entries.every(
			([name, value]) =>
				HEADER_NAME.test(name) &&
				typeof value === "string" &&
				value.trim() !== "" &&
				!/[\r\n\0]/.test(value),
		);
	if (!valid) {
		ctx.issues.push({
			code: "custom",
			message: 'must be a JSON object of header names to values, like {"X-Example": "value"}',
			input: undefined,
		});
		return z.NEVER;
	}
	return Object.fromEntries(entries.map(([name, value]) => [name, String(value).trim()]));
});

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
		// How often Pixel checks in with its Sentry cron monitor. 0 turns the heartbeat off.
		PIXEL_HEARTBEAT_MINUTES: z.coerce.number().int().min(0).max(60).default(5),
		// Empty turns the log file off. Logs still go to the console and to Sentry.
		PIXEL_LOG_DIR: z.string().trim().default("data/logs"),
		PIXEL_TIMEZONE: z
			.string()
			.default("Europe/Amsterdam")
			.refine(isValidTimeZone, { error: "must be a time zone name like Europe/Amsterdam" }),
		HEALTH_PORT: z.coerce.number().int().min(0).max(65535).default(8080),
		// The public port: the space state webhook. Only listened on when the secret below is set.
		WEBHOOK_PORT: z.coerce.number().int().min(0).max(65535).default(8081),
		SENTRY_DSN: optional(z.url()),
		// 0 drops every trace, 1 keeps them all. Empty uses the default (1).
		SENTRY_TRACES_SAMPLE_RATE: sampleRate,
		// Same for CPU profiles of those traces. Empty uses the default (1).
		SENTRY_PROFILE_SESSION_SAMPLE_RATE: sampleRate,
		SPACEAPI_URL: z.url({ protocol: /^https?$/ }).default("https://spaceapi.pixelbar.nl/"),
		// All three unset means `/spacestate` is off. Setting only some is a mistake, so it stops startup.
		SPACESTATE_API_URL: optional(z.url({ protocol: /^https?$/ })),
		SPACESTATE_USER: optional(z.string().trim().min(1).max(100)),
		SPACESTATE_TOKEN: optional(z.string().trim().min(1)),
		// Optional, and only used when the three above are set.
		SPACESTATE_ADDITIONAL_HEADERS: optional(extraHeaders),
		// Unset means no webhook: Pixel only polls. Shared with the space state service, which signs with it.
		SPACESTATE_WEBHOOK_SECRET: optional(
			z.string().trim().min(32, { error: "must be at least 32 characters" }).max(512),
		),

		DISCORD_TOKEN: z.string().min(1),
		DISCORD_APP_ID: snowflake,
		DISCORD_GUILD_ID: snowflake,
		DISCORD_ANNOUNCEMENTS_CHANNEL_ID: optional(snowflake),
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

		// Both unset means Mastodon is off. Setting only one is a mistake, so it stops startup.
		MASTODON_INSTANCE: optional(z.url({ protocol: /^https?$/ })),
		MASTODON_ACCESS_TOKEN: optional(z.string().trim().min(1)),
		// Public handle for logs only. Never used to post; the token decides the account.
		MASTODON_ACCOUNT: optional(z.string().trim().min(1).max(100)),
		MASTODON_VISIBILITY: optional(z.enum(["public", "unlisted"])),
		// Unset → space.status. off / none / empty list turns toots off even with credentials.
		MASTODON_ANNOUNCE_KINDS: z.preprocess((v) => {
			if (typeof v !== "string") return v;
			const trimmed = v.trim();
			if (trimmed === "") return undefined;
			if (/^(off|none)$/i.test(trimmed)) return [];
			return trimmed
				.split(",")
				.map((part) => part.trim())
				.filter((part) => part.length > 0);
		}, z.array(z.enum(ANNOUNCEMENT_KINDS)).optional()),
	})
	.refine((e) => (e.HOME_ASSISTANT_URL === undefined) === (e.HOME_ASSISTANT_TOKEN === undefined), {
		path: ["HOME_ASSISTANT_URL"],
		error: "set both HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN, or neither",
	})
	.refine((e) => (e.MASTODON_INSTANCE === undefined) === (e.MASTODON_ACCESS_TOKEN === undefined), {
		path: ["MASTODON_INSTANCE"],
		error: "set both MASTODON_INSTANCE and MASTODON_ACCESS_TOKEN, or neither",
	})
	.refine((e) => e.WEBHOOK_PORT === 0 || e.WEBHOOK_PORT !== e.HEALTH_PORT, {
		path: ["WEBHOOK_PORT"],
		error: "must differ from HEALTH_PORT: the webhook port is public, the health port is not",
	})
	.refine(
		(e) =>
			[e.SPACESTATE_API_URL, e.SPACESTATE_USER, e.SPACESTATE_TOKEN].every((v) => v === undefined) ||
			[e.SPACESTATE_API_URL, e.SPACESTATE_USER, e.SPACESTATE_TOKEN].every((v) => v !== undefined),
		{
			path: ["SPACESTATE_API_URL"],
			error:
				"set SPACESTATE_API_URL, SPACESTATE_USER and SPACESTATE_TOKEN together, or none of them",
		},
	);

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
	/** How often Pixel checks in with its Sentry cron monitor, in minutes. 0 means off. */
	heartbeatMinutes: number;
	/** Where the rotating log file goes. Undefined means no file (console and Sentry only). */
	logDir: string | undefined;
	/** The time zone times are shown in, and that `{{date}}` tokens use. E.g. "Europe/Amsterdam". */
	timezone: string;
	healthPort: number;
	/**
	 * The space state webhook (`adapters/webhook`): the port it listens on, which is the only
	 * one exposed to the internet, and the secret requests are signed with. A secret. Undefined
	 * means off: nothing listens and Pixel only polls SpaceAPI.
	 */
	spaceStateWebhook: { port: number; secret: string } | undefined;
	sentryDsn: string | undefined;
	/** How many traces Sentry keeps (0–1). Default 1. Unused without a DSN. */
	sentryTracesSampleRate: number;
	/** How many of those traces get a CPU profile (0–1). Default 1. Unused without a DSN. */
	sentryProfileSessionSampleRate: number;
	spaceApiUrl: string;
	/**
	 * The API `/spacestate` calls to set the space open or closed: its address, and the
	 * user and token it is called with. The user and token come from Key Vault when hosted
	 * and the token is a secret. `headers` are extra request headers (such as one that tells the
	 * API which address the call comes from); their values are secret too. Undefined means
	 * `/spacestate` is off.
	 */
	spaceStateApi:
		| { url: string; user: string; token: string; headers: Record<string, string> }
		| undefined;
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
	 * Outbound Mastodon publisher. Instance origin + access token (a secret).
	 * The account handle is for logs only. Undefined means Mastodon is off.
	 */
	mastodon:
		| {
				instanceUrl: string;
				token: string;
				account: string | undefined;
				visibility: "public" | "unlisted";
				kinds: readonly AnnouncementKind[];
		  }
		| undefined;
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
		heartbeatMinutes: e.PIXEL_HEARTBEAT_MINUTES,
		logDir: e.PIXEL_LOG_DIR === "" ? undefined : e.PIXEL_LOG_DIR,
		timezone: e.PIXEL_TIMEZONE,
		healthPort: e.HEALTH_PORT,
		spaceStateWebhook:
			e.SPACESTATE_WEBHOOK_SECRET !== undefined
				? { port: e.WEBHOOK_PORT, secret: e.SPACESTATE_WEBHOOK_SECRET }
				: undefined,
		sentryDsn: e.SENTRY_DSN,
		sentryTracesSampleRate: e.SENTRY_TRACES_SAMPLE_RATE ?? 1,
		sentryProfileSessionSampleRate: e.SENTRY_PROFILE_SESSION_SAMPLE_RATE ?? 1,
		spaceApiUrl: e.SPACEAPI_URL,
		spaceStateApi:
			e.SPACESTATE_API_URL !== undefined &&
			e.SPACESTATE_USER !== undefined &&
			e.SPACESTATE_TOKEN !== undefined
				? {
						url: e.SPACESTATE_API_URL,
						user: e.SPACESTATE_USER,
						token: e.SPACESTATE_TOKEN,
						headers: e.SPACESTATE_ADDITIONAL_HEADERS ?? {},
					}
				: undefined,
		discord: {
			token: e.DISCORD_TOKEN,
			appId: e.DISCORD_APP_ID,
			guildId: e.DISCORD_GUILD_ID,
			announcementsChannelId: e.DISCORD_ANNOUNCEMENTS_CHANNEL_ID,
			announce: {
				botChannelId: e.DISCORD_ANNOUNCE_BOT_CHANNEL_ID ?? e.DISCORD_ANNOUNCEMENTS_CHANNEL_ID,
				closingTimeChannelId: e.DISCORD_CLOSING_TIME_CHANNEL_ID,
			},
			roles: { member: e.DISCORD_ROLE_MEMBER, friend: e.DISCORD_ROLE_FRIEND },
		},
		homeAssistant:
			e.HOME_ASSISTANT_URL !== undefined && e.HOME_ASSISTANT_TOKEN !== undefined
				? { url: e.HOME_ASSISTANT_URL, token: e.HOME_ASSISTANT_TOKEN }
				: undefined,
		mastodon:
			e.MASTODON_INSTANCE !== undefined && e.MASTODON_ACCESS_TOKEN !== undefined
				? {
						instanceUrl: new URL(e.MASTODON_INSTANCE).origin,
						token: e.MASTODON_ACCESS_TOKEN,
						account: e.MASTODON_ACCOUNT,
						visibility: e.MASTODON_VISIBILITY ?? "unlisted",
						kinds: e.MASTODON_ANNOUNCE_KINDS ?? ["space.status"],
					}
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
