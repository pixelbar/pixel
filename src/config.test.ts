import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, loadSentryConfig } from "./config.ts";

const VALID = {
	PSEUDONYM_KEY: "k".repeat(32),
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
			healthPort: 8080,
			sentryDsn: undefined,
		});
	});

	it("treats an empty SENTRY_DSN as unset", () => {
		expect(loadConfig({ ...VALID, SENTRY_DSN: "" }).sentryDsn).toBeUndefined();
	});

	it("lists every invalid variable without echoing values", () => {
		const secret = "short-secret";
		let message = "";
		try {
			loadConfig({
				...VALID,
				PSEUDONYM_KEY: secret,
				DISCORD_GUILD_ID: "abc",
				DISCORD_TOKEN: undefined,
			});
		} catch (error) {
			expect(error).toBeInstanceOf(ConfigError);
			message = (error as Error).message;
		}
		expect(message).toContain("PSEUDONYM_KEY");
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
