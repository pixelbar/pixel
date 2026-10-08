import { Writable } from "node:stream";
import * as Sentry from "@sentry/node";
import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { REDACT_PATHS } from "./logger.ts";
import { isHealthProbe, SENTRY_LOG_LEVELS, sentryOptions } from "./sentry-options.ts";

const sentryCfg = {
	dsn: "https://key@o0.ingest.sentry.io/1",
	environment: "test",
	release: "1.2.3",
	tracesSampleRate: 1,
	profileSessionSampleRate: 1,
};

const options = sentryOptions(sentryCfg);

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
		expect(options.sampleRate).toBe(1);
		expect(options.tracesSampleRate).toBe(1);
		expect(options.profileSessionSampleRate).toBe(1);
		expect(options.profileLifecycle).toBe("trace");
	});

	it("keeps the sample rates it was given", () => {
		const given = sentryOptions({
			...sentryCfg,
			release: "1",
			tracesSampleRate: 0.25,
			profileSessionSampleRate: 0.5,
		});
		expect(given.tracesSampleRate).toBe(0.25);
		expect(given.profileSessionSampleRate).toBe(0.5);
	});

	it("includes HTTP, pino, runtime metrics and profiling integrations", () => {
		expect(Array.isArray(options.integrations) && options.integrations.map((i) => i?.name)).toEqual(
			["Http", "Pino", "NodeRuntimeMetrics", "ProfilingIntegration"],
		);
		expect(SENTRY_LOG_LEVELS).toEqual(["info", "warn", "error", "fatal"]);
	});

	it("leaves the profiler unwired when the profile session sample rate is 0", () => {
		const names = sentryOptions({ ...sentryCfg, profileSessionSampleRate: 0 }).integrations ?? [];
		expect(Array.isArray(names) && names.map((i) => i?.name)).toEqual([
			"Http",
			"Pino",
			"NodeRuntimeMetrics",
		]);
	});

	it("ignores health probes, including ones with a query string", () => {
		expect(isHealthProbe("/healthz")).toBe(true);
		expect(isHealthProbe("/readyz")).toBe(true);
		expect(isHealthProbe("/healthz?ready=1")).toBe(true);
		expect(isHealthProbe("/")).toBe(false);
		expect(isHealthProbe("/api")).toBe(false);
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
			...sentryOptions({ ...sentryCfg, profileSessionSampleRate: 0 }),
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
