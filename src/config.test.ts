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
			logLevel: "info",
			access: { adminsFile: "config/admins.yaml", membersFile: "config/members.yaml" },
			dataDir: "data",
			healthPort: 8080,
			sentryDsn: undefined,
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
		});
		expect(
			loadConfig({
				...VALID,
				DISCORD_ANNOUNCE_LIVE_CHANNEL_ID: "",
				DISCORD_ANNOUNCE_TIMELINE_CHANNEL_ID: "",
			}).discord.announce,
		).toEqual({ liveChannelId: undefined, timelineChannelId: undefined });
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

	it("returns DSN, environment and release", () => {
		expect(
			loadSentryConfig({
				SENTRY_DSN: "https://key@o0.ingest.sentry.io/1",
				PIXEL_ENV: "prod",
				PIXEL_VERSION: "abc123",
			}),
		).toEqual({ dsn: "https://key@o0.ingest.sentry.io/1", environment: "prod", release: "abc123" });
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
