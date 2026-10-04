import { Writable } from "node:stream";
import * as Sentry from "@sentry/node";
import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { REDACT_PATHS } from "./logger.ts";
import { SENTRY_LOG_LEVELS, sentryOptions } from "./sentry-options.ts";

const options = sentryOptions({
	dsn: "https://key@o0.ingest.sentry.io/1",
	environment: "test",
	release: "1.2.3",
});

// Shaped like a Discord token and a Home Assistant token, but not real ones.
const discordToken = `${"A".repeat(26)}.${"B".repeat(6)}.${"C".repeat(38)}`;
const haToken = `eyJ${"h".repeat(30)}.eyJ${"p".repeat(60)}.${"s".repeat(43)}`;

describe("sentryOptions", () => {
	it("passes on the DSN, environment and release", () => {
		expect(options).toMatchObject({
			dsn: "https://key@o0.ingest.sentry.io/1",
			environment: "test",
			release: "1.2.3",
		});
	});

	it("still collects nothing personal by default", () => {
		expect(options.dataCollection).toMatchObject({
			userInfo: false,
			cookies: false,
			httpHeaders: false,
			urlQueryParams: false,
			stackFrameVariables: false,
		});
		expect(options.includeServerName).toBe(false);
		expect(options.tracesSampleRate).toBe(0);
	});

	it("includes the pino integration, so log lines become Sentry Logs", () => {
		expect(options.integrations).toHaveLength(1);
		expect(Array.isArray(options.integrations) && options.integrations[0]?.name).toBe("Pino");
		expect(SENTRY_LOG_LEVELS).toEqual(["info", "warn", "error", "fatal"]);
	});

	it("scrubs secrets from a log before it is sent: the message and every attribute", () => {
		const scrubbed = options.beforeSendLog?.({
			level: "info",
			message: `connecting with ${discordToken}`,
			attributes: { event: "x", nested: { header: `Bearer ${haToken}` }, count: 3 },
		});
		expect(JSON.stringify(scrubbed)).not.toContain(discordToken);
		expect(JSON.stringify(scrubbed)).not.toContain(haToken);
		expect(scrubbed).toMatchObject({
			message: "connecting with [redacted-token]",
			attributes: { event: "x", nested: { header: "Bearer [redacted-token]" }, count: 3 },
		});
	});

	it("scrubs events and breadcrumbs as before", () => {
		expect(JSON.stringify(options.beforeSend?.({ message: haToken } as never, {}))).not.toContain(
			haToken,
		);
		expect(JSON.stringify(options.beforeBreadcrumb?.({ message: haToken }))).not.toContain(haToken);
	});
});

describe("log lines reach Sentry", () => {
	// Sentry's pino hook subscribes on every `init`, so start one client for the whole file
	// and clear what it has sent between tests.
	const envelopes: unknown[][] = [];
	beforeAll(() => {
		Sentry.init({
			...options,
			transport: () => ({
				send: async (envelope: unknown[]) => {
					envelopes.push(envelope);
					return {};
				},
				flush: async () => true,
			}),
		});
	});
	beforeEach(() => {
		envelopes.length = 0;
	});
	afterAll(async () => {
		await Sentry.close(1000);
	});

	const logs = () =>
		envelopes.flatMap((envelope) =>
			(envelope[1] as [{ type: string }, { items?: Record<string, unknown>[] }][])
				.filter(([header]) => header.type === "log")
				.flatMap(([, payload]) => payload.items ?? []),
		);

	function logger(level = "debug") {
		const sink = new Writable({ write: (_chunk, _enc, done) => done() });
		return pino(
			{
				level,
				base: { env: "test", version: "1.2.3" },
				redact: { paths: REDACT_PATHS, censor: "[redacted]" },
			},
			sink,
		);
	}

	it("sends info, warn and error lines as Sentry Logs, with their fields as attributes", async () => {
		const log = logger().child({ component: "home" });
		log.info({ event: "home.action", device: "lamp" }, "ran a device action");
		log.warn({ event: "home.action_denied" }, "refused a device action");
		log.error({ event: "boom" }, "went wrong");
		await Sentry.flush(1000);

		const sent = logs();
		expect(sent.map((l) => [l.level, l.body])).toEqual([
			["info", "ran a device action"],
			["warn", "refused a device action"],
			["error", "went wrong"],
		]);
		const attributes = sent[0]?.attributes as Record<string, { value: unknown }>;
		expect(attributes.event?.value).toBe("home.action");
		expect(attributes.device?.value).toBe("lamp");
		expect(attributes.component?.value).toBe("home");
		expect(attributes.env?.value).toBe("test");
	});

	it("doesn't send debug lines, whatever LOG_LEVEL is", async () => {
		const log = logger("debug");
		log.debug({ event: "noisy" }, "debug line");
		log.info({ event: "kept" }, "info line");
		await Sentry.flush(1000);
		expect(logs().map((l) => l.body)).toEqual(["info line"]);
	});

	it("scrubs tokens from what is sent, and the logger redacts token fields before that", async () => {
		const log = logger();
		log.info({ event: "x", token: "plain-secret", note: `see ${haToken}` }, `with ${discordToken}`);
		await Sentry.flush(1000);
		const text = JSON.stringify(logs());
		expect(text).not.toContain(discordToken);
		expect(text).not.toContain(haToken);
		expect(text).not.toContain("plain-secret");
		expect(text).toContain("[redacted-token]");
		expect(text).toContain("[redacted]");
	});

	it("doesn't turn log lines into error events", async () => {
		logger().error({ event: "boom" }, "went wrong");
		await Sentry.flush(1000);
		const types = envelopes.flatMap((envelope) =>
			(envelope[1] as [{ type: string }][]).map(([header]) => header.type),
		);
		expect(types).toContain("log");
		expect(types).not.toContain("event");
	});
});
