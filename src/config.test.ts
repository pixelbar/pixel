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
