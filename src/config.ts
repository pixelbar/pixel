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

/** An OpenR ID (a building or a door): digits. */
const openrId = z
	.string()
	.trim()
	.regex(/^\d{1,10}$/, { error: "must be an OpenR ID (digits)" });

/**
 * The doors `/openr open` offers, as `Name=ID` pairs separated by commas, like
 * `Entrance=103, Living room=203`. Names are what people pick in Discord; IDs are
 * OpenR's. Neither may repeat. Errors never echo the value.
 */
const openrDoors = z.string().transform((raw, ctx) => {
	const doors: { name: string; id: string }[] = [];
	const problem = (message: string) => {
		ctx.issues.push({ code: "custom", message, input: undefined });
		return z.NEVER;
	};
	for (const part of raw.split(",")) {
		if (part.trim() === "") continue;
		const at = part.lastIndexOf("=");
		const name = part.slice(0, at).trim();
		const id = part.slice(at + 1).trim();
		if (at < 0 || !/^[^=]{1,50}$/.test(name) || !/^\d{1,10}$/.test(id)) {
			return problem(
				"must be Name=ID pairs separated by commas, like Entrance=103, Living room=203",
			);
		}
		doors.push({ name, id });
	}
	if (doors.length === 0) return problem("must list at least one door, or be left unset");
	if (doors.length > 25) return problem("can list at most 25 doors");
	const names = new Set(doors.map((d) => d.name.toLowerCase()));
	const ids = new Set(doors.map((d) => d.id));
	if (names.size !== doors.length || ids.size !== doors.length) {
		return problem("names a door twice");
	}
	return doors;
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
		// Unset, empty, "off" or "none" turns parking activity posts off.
		DISCORD_PARKING_CHANNEL_ID: z.preprocess((v) => {
			if (typeof v === "string" && /^(off|none)$/i.test(v.trim())) return undefined;
			return v;
		}, optional(snowflake)),
		PIXEL_CLOSING_TIME_FILE: optional(z.string().trim().min(1)),
		// A role name, or its ID. Unset means that tier isn't mirrored to a Discord role.
		DISCORD_ROLE_MEMBER: optional(z.string().trim().min(1).max(100)),
		DISCORD_ROLE_FRIEND: optional(z.string().trim().min(1).max(100)),
		// "on" also reads the roles back into members.yaml every minute. Needs the Server Members
		// Intent in the Developer Portal. Off unless set.
		DISCORD_ROLE_SYNC: optional(z.enum(["on", "off"])),

		// Both unset means Home Assistant is off. Setting only one is a mistake, so it stops startup.
		HOME_ASSISTANT_URL: optional(z.url({ protocol: /^https?$/ })),
		HOME_ASSISTANT_TOKEN: optional(z.string().trim().min(1)),

		// Both unset means Mastodon is off. Setting only one is a mistake, so it stops startup.
		MASTODON_INSTANCE: optional(z.url({ protocol: /^https?$/ })),
		MASTODON_ACCESS_TOKEN: optional(z.string().trim().min(1)),
		// Public handle for logs only. Never used to post; the token decides the account.
		MASTODON_ACCOUNT: optional(z.string().trim().min(1).max(100)),
		MASTODON_VISIBILITY: optional(z.enum(["public", "unlisted"])),

		// OpenR, the building's doors. Off unless OPENR_BUILDING_ID is set; then the email and
		// password must be set too, and at least one of OPENR_DOORS and OPENR_GATE_DOOR.
		OPENR_URL: z.url({ protocol: /^https$/ }).default("https://dashboard.openr.nl/api/v4"),
		OPENR_BUILDING_ID: optional(openrId),
		OPENR_EMAIL: optional(z.string().trim().min(3).max(200)),
		OPENR_PASSWORD: optional(z.string().min(1)),
		OPENR_DOORS: optional(openrDoors),
		OPENR_GATE_DOOR: optional(openrId),
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
	.refine(
		(e) =>
			[e.OPENR_BUILDING_ID, e.OPENR_EMAIL, e.OPENR_PASSWORD].every((v) => v === undefined) ||
			[e.OPENR_BUILDING_ID, e.OPENR_EMAIL, e.OPENR_PASSWORD].every((v) => v !== undefined),
		{
			path: ["OPENR_BUILDING_ID"],
			error: "set OPENR_BUILDING_ID, OPENR_EMAIL and OPENR_PASSWORD together, or none of them",
		},
	)
	.refine(
		(e) =>
			e.OPENR_BUILDING_ID === undefined ||
			e.OPENR_DOORS !== undefined ||
			e.OPENR_GATE_DOOR !== undefined,
		{ path: ["OPENR_DOORS"], error: "set OPENR_DOORS, OPENR_GATE_DOOR or both when OpenR is on" },
	)
	.refine(
		(e) =>
			e.OPENR_BUILDING_ID !== undefined ||
			(e.OPENR_DOORS === undefined && e.OPENR_GATE_DOOR === undefined),
		{
			path: ["OPENR_BUILDING_ID"],
			error: "OPENR_DOORS and OPENR_GATE_DOOR need OPENR_BUILDING_ID",
		},
	)
	.refine(
		(e) =>
			e.OPENR_GATE_DOOR === undefined ||
			!(e.OPENR_DOORS ?? []).some((door) => door.id === e.OPENR_GATE_DOOR),
		{
			path: ["OPENR_DOORS"],
			error: "must not include the parking gate: only /park opens OPENR_GATE_DOOR",
		},
	)
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
			/** Every parking change, for admins to watch. Undefined means off. */
			parkingChannelId: string | undefined;
		};
		/**
		 * The Discord role each tier is mirrored to, by name or ID. Pixel pushes tiers
		 * to these roles. Unset means not mirrored.
		 */
		roles: { member: string | undefined; friend: string | undefined };
		/**
		 * Whether the role sync also reads these roles back into members.yaml every
		 * minute (`core/role-sync.ts`). Off unless `DISCORD_ROLE_SYNC=on`.
		 */
		roleSync: boolean;
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
	 * OpenR, the building's doors: where its API is, the building, the account Pixel logs
	 * in as (the email and password are secrets), the doors `/openr open` offers, and the
	 * parking gate's door, which only `/park` opens. Undefined means OpenR is off.
	 */
	openr:
		| {
				url: string;
				buildingId: string;
				email: string;
				password: string;
				doors: readonly { name: string; id: string }[];
				gateDoor: string | undefined;
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
				parkingChannelId: e.DISCORD_PARKING_CHANNEL_ID,
			},
			roles: { member: e.DISCORD_ROLE_MEMBER, friend: e.DISCORD_ROLE_FRIEND },
			roleSync: e.DISCORD_ROLE_SYNC === "on",
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
		openr:
			e.OPENR_BUILDING_ID !== undefined &&
			e.OPENR_EMAIL !== undefined &&
			e.OPENR_PASSWORD !== undefined
				? {
						url: e.OPENR_URL,
						buildingId: e.OPENR_BUILDING_ID,
						email: e.OPENR_EMAIL,
						password: e.OPENR_PASSWORD,
						doors: e.OPENR_DOORS ?? [],
						gateDoor: e.OPENR_GATE_DOOR,
					}
				: undefined,
		closingTimeFile: e.PIXEL_CLOSING_TIME_FILE ?? `${e.PIXEL_DATA_DIR}/closing-time.md`,
	};
}

const openrAccountSchema = z.object({
	OPENR_URL: z.url({ protocol: /^https$/ }).default("https://dashboard.openr.nl/api/v4"),
	OPENR_EMAIL: z.string().trim().min(3).max(200),
	OPENR_PASSWORD: z.string().min(1),
});

/**
 * Just the OpenR account, for `just openr-doors`, which lists the buildings and doors
 * so the rest of the OpenR settings can be filled in. Errors name the variable but
 * never echo its value.
 */
export function loadOpenrAccount(env: NodeJS.ProcessEnv = process.env): {
	url: string;
	email: string;
	password: string;
} {
	const result = openrAccountSchema.safeParse(
		Object.fromEntries(Object.entries(env).filter(([, v]) => v !== "")),
	);
	if (!result.success) {
		const names = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))];
		throw new ConfigError(`Set ${names.join(" and ")} (see .env.example, OpenR)`);
	}
	return {
		url: result.data.OPENR_URL,
		email: result.data.OPENR_EMAIL,
		password: result.data.OPENR_PASSWORD,
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
