import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, loadSentryConfig } from "./config.ts";

const VALID = {
	DISCORD_TOKEN: "not-a-real-token",
	DISCORD_APP_ID: "100000000000000010",
	DISCORD_GUILD_ID: "100000000000000020",
};

describe("loadConfig", () => {
	it("applies defaults", () => {
		const config = loadConfig(VALID);
		expect(config).toMatchObject({
			env: "local",
			runtime: "local",
			logLevel: "info",
			access: { adminsFile: "config/admins.yaml", membersFile: "config/members.yaml" },
			dataDir: "data",
			healthPort: 8080,
			sentryDsn: undefined,
			sentryTracesSampleRate: 1,
			spaceApiUrl: "https://spaceapi.pixelbar.nl/",
		});
	});

	it("reads content from ./content unless told otherwise", () => {
		expect(loadConfig(VALID).contentDir).toBe("content");
		expect(loadConfig({ ...VALID, PIXEL_CONTENT_DIR: "/srv/pixel/content" }).contentDir).toBe(
			"/srv/pixel/content",
		);
		expect(() => loadConfig({ ...VALID, PIXEL_CONTENT_DIR: "" })).toThrow(/PIXEL_CONTENT_DIR/);
	});

	it("shows times in Amsterdam unless told otherwise, and rejects unknown time zones", () => {
		expect(loadConfig(VALID).timezone).toBe("Europe/Amsterdam");
		expect(loadConfig({ ...VALID, PIXEL_TIMEZONE: "UTC" }).timezone).toBe("UTC");
		expect(() => loadConfig({ ...VALID, PIXEL_TIMEZONE: "Europe/Atlantis" })).toThrow(
			/PIXEL_TIMEZONE/,
		);
		expect(() => loadConfig({ ...VALID, PIXEL_TIMEZONE: "" })).toThrow(/PIXEL_TIMEZONE/);
	});

	it("has no announcements channel unless configured, and rejects one that isn't a Discord ID", () => {
		expect(loadConfig(VALID).discord.announcementsChannelId).toBeUndefined();
		expect(
			loadConfig({ ...VALID, DISCORD_ANNOUNCEMENTS_CHANNEL_ID: "" }).discord.announcementsChannelId,
		).toBeUndefined();
		expect(
			loadConfig({ ...VALID, DISCORD_ANNOUNCEMENTS_CHANNEL_ID: "100000000000000031" }).discord
				.announcementsChannelId,
		).toBe("100000000000000031");
		expect(() =>
			loadConfig({ ...VALID, DISCORD_ANNOUNCEMENTS_CHANNEL_ID: "#announcements" }),
		).toThrow(/DISCORD_ANNOUNCEMENTS_CHANNEL_ID/);
	});

	it("mirrors no tier to a Discord role unless configured", () => {
		expect(loadConfig(VALID).discord.roles).toEqual({ member: undefined, friend: undefined });
		expect(
			loadConfig({ ...VALID, DISCORD_ROLE_MEMBER: "", DISCORD_ROLE_FRIEND: "" }).discord.roles,
		).toEqual({ member: undefined, friend: undefined });
	});

	it("reads a role name or ID for each tier, trimmed", () => {
		expect(
			loadConfig({
				...VALID,
				DISCORD_ROLE_MEMBER: "  member ",
				DISCORD_ROLE_FRIEND: "100000000000000102",
			}).discord.roles,
		).toEqual({ member: "member", friend: "100000000000000102" });
		expect(loadConfig({ ...VALID, DISCORD_ROLE_FRIEND: "friend" }).discord.roles).toEqual({
			member: undefined,
			friend: "friend",
		});
	});

	it("rejects a blank or over-long role setting", () => {
		expect(() => loadConfig({ ...VALID, DISCORD_ROLE_MEMBER: "   " })).toThrow(
			/DISCORD_ROLE_MEMBER/,
		);
		expect(() => loadConfig({ ...VALID, DISCORD_ROLE_FRIEND: "x".repeat(101) })).toThrow(
			/DISCORD_ROLE_FRIEND/,
		);
	});

	it("has no announcement channels unless configured", () => {
		expect(loadConfig(VALID).discord.announce).toEqual({
			liveChannelId: undefined,
			timelineChannelId: undefined,
			botChannelId: undefined,
		});
		expect(
			loadConfig({
				...VALID,
				DISCORD_ANNOUNCE_LIVE_CHANNEL_ID: "",
				DISCORD_ANNOUNCE_TIMELINE_CHANNEL_ID: "",
			}).discord.announce,
		).toEqual({ liveChannelId: undefined, timelineChannelId: undefined, botChannelId: undefined });
	});

	it("reads one channel for each announcement style, which may be the same channel", () => {
		const announce = loadConfig({
			...VALID,
			DISCORD_ANNOUNCE_LIVE_CHANNEL_ID: "100000000000000031",
			DISCORD_ANNOUNCE_TIMELINE_CHANNEL_ID: "100000000000000032",
		}).discord.announce;
		expect(announce).toEqual({
			liveChannelId: "100000000000000031",
			timelineChannelId: "100000000000000032",
			botChannelId: undefined,
		});
		const same = loadConfig({
			...VALID,
			DISCORD_ANNOUNCE_LIVE_CHANNEL_ID: "100000000000000031",
			DISCORD_ANNOUNCE_TIMELINE_CHANNEL_ID: "100000000000000031",
		}).discord.announce;
		expect(same.liveChannelId).toBe(same.timelineChannelId);
	});

	it("rejects announcement channels that aren't Discord IDs", () => {
		expect(() => loadConfig({ ...VALID, DISCORD_ANNOUNCE_LIVE_CHANNEL_ID: "#status" })).toThrow(
			/DISCORD_ANNOUNCE_LIVE_CHANNEL_ID/,
		);
		expect(() => loadConfig({ ...VALID, DISCORD_ANNOUNCE_TIMELINE_CHANNEL_ID: "123" })).toThrow(
			/DISCORD_ANNOUNCE_TIMELINE_CHANNEL_ID/,
		);
	});

	it("takes the data directory from PIXEL_DATA_DIR and rejects an empty one", () => {
		expect(loadConfig({ ...VALID, PIXEL_DATA_DIR: "/var/lib/pixel" }).dataDir).toBe(
			"/var/lib/pixel",
		);
		expect(() => loadConfig({ ...VALID, PIXEL_DATA_DIR: "" })).toThrow(/PIXEL_DATA_DIR/);
	});

	it("accepts a custom SpaceAPI URL but only over http(s)", () => {
		expect(loadConfig({ ...VALID, SPACEAPI_URL: "https://example.org/space" }).spaceApiUrl).toBe(
			"https://example.org/space",
		);
		expect(() => loadConfig({ ...VALID, SPACEAPI_URL: "file:///etc/passwd" })).toThrow(
			/SPACEAPI_URL/,
		);
	});

	it("treats an empty SENTRY_DSN as unset", () => {
		expect(loadConfig({ ...VALID, SENTRY_DSN: "" }).sentryDsn).toBeUndefined();
	});

	it("defaults PIXEL_RUNTIME to local, and accepts cloud", () => {
		expect(loadConfig(VALID).runtime).toBe("local");
		expect(loadConfig({ ...VALID, PIXEL_RUNTIME: "cloud" }).runtime).toBe("cloud");
		expect(() => loadConfig({ ...VALID, PIXEL_RUNTIME: "azure" })).toThrow(/PIXEL_RUNTIME/);
	});

	it("lists every invalid variable without echoing values", () => {
		const secret = "https://secret-key-in-a-bad-dsn";
		let message = "";
		try {
			loadConfig({
				...VALID,
				SENTRY_DSN: `${secret} not a url`,
				DISCORD_GUILD_ID: "abc",
				DISCORD_TOKEN: undefined,
			});
		} catch (error) {
			expect(error).toBeInstanceOf(ConfigError);
			message = (error as Error).message;
		}
		expect(message).toContain("SENTRY_DSN");
		expect(message).toContain("DISCORD_GUILD_ID");
		expect(message).toContain("DISCORD_TOKEN");
		expect(message).not.toContain(secret);
	});
});

describe("loadSentryConfig", () => {
	it("is undefined without a DSN", () => {
		expect(loadSentryConfig({})).toBeUndefined();
	});

	it("is undefined for an invalid DSN instead of throwing", () => {
		expect(loadSentryConfig({ SENTRY_DSN: "not a url" })).toBeUndefined();
	});

	it("returns DSN, environment, release and traces sample rate 1", () => {
		expect(
			loadSentryConfig({
				SENTRY_DSN: "https://key@o0.ingest.sentry.io/1",
				PIXEL_ENV: "prod",
				PIXEL_VERSION: "abc123",
			}),
		).toEqual({
			dsn: "https://key@o0.ingest.sentry.io/1",
			environment: "prod",
			release: "abc123",
			tracesSampleRate: 1,
		});
	});

	it("keeps a traces sample rate from the environment", () => {
		expect(
			loadSentryConfig({
				SENTRY_DSN: "https://key@o0.ingest.sentry.io/1",
				SENTRY_TRACES_SAMPLE_RATE: "0.25",
			})?.tracesSampleRate,
		).toBe(0.25);
	});

	it("is undefined for an invalid traces sample rate instead of throwing", () => {
		expect(
			loadSentryConfig({
				SENTRY_DSN: "https://key@o0.ingest.sentry.io/1",
				SENTRY_TRACES_SAMPLE_RATE: "2",
			}),
		).toBeUndefined();
	});
});

describe("the traces sample rate", () => {
	it("defaults to 1, and accepts 0 through 1", () => {
		expect(loadConfig(VALID).sentryTracesSampleRate).toBe(1);
		expect(loadConfig({ ...VALID, SENTRY_TRACES_SAMPLE_RATE: "" }).sentryTracesSampleRate).toBe(1);
		expect(loadConfig({ ...VALID, SENTRY_TRACES_SAMPLE_RATE: "0" }).sentryTracesSampleRate).toBe(0);
		expect(loadConfig({ ...VALID, SENTRY_TRACES_SAMPLE_RATE: "0.5" }).sentryTracesSampleRate).toBe(
			0.5,
		);
	});

	it("rejects a rate outside 0–1", () => {
		expect(() => loadConfig({ ...VALID, SENTRY_TRACES_SAMPLE_RATE: "-0.1" })).toThrow(
			/SENTRY_TRACES_SAMPLE_RATE/,
		);
		expect(() => loadConfig({ ...VALID, SENTRY_TRACES_SAMPLE_RATE: "2" })).toThrow(
			/SENTRY_TRACES_SAMPLE_RATE/,
		);
		expect(() => loadConfig({ ...VALID, SENTRY_TRACES_SAMPLE_RATE: "nope" })).toThrow(
			/SENTRY_TRACES_SAMPLE_RATE/,
		);
	});
});

describe("Home Assistant settings", () => {
	const URL = "https://example123.ui.nabu.casa";
	const TOKEN = "a-long-lived-token-value";

	it("is off unless configured", () => {
		expect(loadConfig(VALID).homeAssistant).toBeUndefined();
		expect(
			loadConfig({ ...VALID, HOME_ASSISTANT_URL: "", HOME_ASSISTANT_TOKEN: "" }).homeAssistant,
		).toBeUndefined();
	});

	it("reads the address and the token", () => {
		expect(
			loadConfig({ ...VALID, HOME_ASSISTANT_URL: URL, HOME_ASSISTANT_TOKEN: ` ${TOKEN} ` })
				.homeAssistant,
		).toEqual({ url: URL, token: TOKEN });
		expect(
			loadConfig({
				...VALID,
				HOME_ASSISTANT_URL: "http://homeassistant.local:8123",
				HOME_ASSISTANT_TOKEN: TOKEN,
			}).homeAssistant?.url,
		).toBe("http://homeassistant.local:8123");
	});

	it.each([
		["only the address", { HOME_ASSISTANT_URL: URL }],
		["only the token", { HOME_ASSISTANT_TOKEN: TOKEN }],
	])("refuses to start with %s, without echoing either value", (_label, env) => {
		let message = "";
		try {
			loadConfig({ ...VALID, ...env });
		} catch (error) {
			expect(error).toBeInstanceOf(ConfigError);
			message = (error as Error).message;
		}
		expect(message).toMatch(/set both HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN, or neither/);
		expect(message).not.toContain(TOKEN);
		expect(message).not.toContain(URL);
	});

	it.each(["not a url", "ftp://example.com", "example.com"])("rejects the address %j", (url) => {
		expect(() =>
			loadConfig({ ...VALID, HOME_ASSISTANT_URL: url, HOME_ASSISTANT_TOKEN: TOKEN }),
		).toThrow(/HOME_ASSISTANT_URL/);
	});

	it("rejects a blank token", () => {
		expect(() =>
			loadConfig({ ...VALID, HOME_ASSISTANT_URL: URL, HOME_ASSISTANT_TOKEN: "   " }),
		).toThrow(/HOME_ASSISTANT_TOKEN/);
	});
});

describe("the Home Assistant devices directory", () => {
	it("defaults to config/home-assistant", () => {
		expect(loadConfig(VALID).homeAssistantDir).toBe("config/home-assistant");
	});

	it("can be pointed elsewhere, but not at nothing", () => {
		expect(
			loadConfig({ ...VALID, PIXEL_HOME_ASSISTANT_DIR: "/etc/pixel/ha" }).homeAssistantDir,
		).toBe("/etc/pixel/ha");
		expect(() => loadConfig({ ...VALID, PIXEL_HOME_ASSISTANT_DIR: "" })).toThrow(
			/PIXEL_HOME_ASSISTANT_DIR/,
		);
	});
});

describe("the Home Assistant inventory interval", () => {
	it("defaults to an hour", () => {
		expect(loadConfig(VALID).homeSyncMinutes).toBe(60);
	});

	it("can be changed, or set to 0 for only at startup and on reload", () => {
		expect(loadConfig({ ...VALID, PIXEL_HOME_SYNC_MINUTES: "15" }).homeSyncMinutes).toBe(15);
		expect(loadConfig({ ...VALID, PIXEL_HOME_SYNC_MINUTES: "0" }).homeSyncMinutes).toBe(0);
	});

	it.each(["-1", "1.5", "abc", "1441"])("refuses %s", (value) => {
		expect(() => loadConfig({ ...VALID, PIXEL_HOME_SYNC_MINUTES: value })).toThrow(
			/PIXEL_HOME_SYNC_MINUTES/,
		);
	});
});

describe("the log directory", () => {
	it("defaults to data/logs", () => {
		expect(loadConfig(VALID).logDir).toBe("data/logs");
	});

	it("can be moved", () => {
		expect(loadConfig({ ...VALID, PIXEL_LOG_DIR: " /var/log/pixel " }).logDir).toBe(
			"/var/log/pixel",
		);
	});

	it("turns the log file off when empty, leaving the console and Sentry", () => {
		expect(loadConfig({ ...VALID, PIXEL_LOG_DIR: "" }).logDir).toBeUndefined();
		expect(loadConfig({ ...VALID, PIXEL_LOG_DIR: "   " }).logDir).toBeUndefined();
	});
});

describe("the heartbeat interval", () => {
	it("defaults to five minutes", () => {
		expect(loadConfig(VALID).heartbeatMinutes).toBe(5);
	});

	it("can be changed, or set to 0 to turn the heartbeat off", () => {
		expect(loadConfig({ ...VALID, PIXEL_HEARTBEAT_MINUTES: "1" }).heartbeatMinutes).toBe(1);
		expect(loadConfig({ ...VALID, PIXEL_HEARTBEAT_MINUTES: "0" }).heartbeatMinutes).toBe(0);
	});

	it.each(["-1", "2.5", "61", "often"])("refuses %s", (value) => {
		expect(() => loadConfig({ ...VALID, PIXEL_HEARTBEAT_MINUTES: value })).toThrow(
			/PIXEL_HEARTBEAT_MINUTES/,
		);
	});
});

describe("the bot status channel and build info", () => {
	it("posts Pixel's online status in the announcements channel unless told otherwise", () => {
		expect(
			loadConfig({ ...VALID, DISCORD_ANNOUNCEMENTS_CHANNEL_ID: "100000000000000041" }).discord
				.announce.botChannelId,
		).toBe("100000000000000041");
		expect(
			loadConfig({
				...VALID,
				DISCORD_ANNOUNCEMENTS_CHANNEL_ID: "100000000000000041",
				DISCORD_ANNOUNCE_BOT_CHANNEL_ID: "100000000000000042",
			}).discord.announce.botChannelId,
		).toBe("100000000000000042");
		expect(() => loadConfig({ ...VALID, DISCORD_ANNOUNCE_BOT_CHANNEL_ID: "123" })).toThrow(
			/DISCORD_ANNOUNCE_BOT_CHANNEL_ID/,
		);
	});

	it("reads the git commit and branch when given, and checks the commit looks like one", () => {
		expect(loadConfig(VALID)).toMatchObject({ gitSha: undefined, gitBranch: undefined });
		expect(
			loadConfig({ ...VALID, PIXEL_GIT_SHA: "abc1234def", PIXEL_GIT_BRANCH: "feature/doors" }),
		).toMatchObject({ gitSha: "abc1234def", gitBranch: "feature/doors" });
		expect(() => loadConfig({ ...VALID, PIXEL_GIT_SHA: "not a sha" })).toThrow(/PIXEL_GIT_SHA/);
	});
});
