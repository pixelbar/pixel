import * as Sentry from "@sentry/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "../core/logger.ts";
import { monitorSlug, planHeartbeat, sentryCheckIn, startHeartbeat } from "./heartbeat.ts";
import { sentryOptions } from "./sentry-options.ts";

describe("startHeartbeat", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	function setup(healthy: { value: boolean }) {
		const checkIn = vi.fn();
		const info = vi.fn();
		const warn = vi.fn();
		const logger = { ...silentLogger, info, warn };
		logger.child = () => logger;
		const heartbeat = startHeartbeat({
			intervalMs: 60_000,
			isHealthy: () => healthy.value,
			checkIn,
			logger,
		});
		return { heartbeat, checkIn, info, warn };
	}

	it("checks in ok on every interval while healthy, and stops when told", async () => {
		const { heartbeat, checkIn } = setup({ value: true });
		expect(checkIn).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(180_000);
		expect(checkIn.mock.calls).toEqual([["ok"], ["ok"], ["ok"]]);
		heartbeat.stop();
		await vi.advanceTimersByTimeAsync(600_000);
		expect(checkIn).toHaveBeenCalledTimes(3);
	});

	it("checks in as failed while the process is up but Discord isn't connected", async () => {
		const healthy = { value: true };
		const { checkIn } = setup(healthy);
		await vi.advanceTimersByTimeAsync(60_000);
		healthy.value = false;
		await vi.advanceTimersByTimeAsync(60_000);
		healthy.value = true;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(checkIn.mock.calls).toEqual([["ok"], ["error"], ["ok"]]);
	});

	it("can check in straight away, such as when Discord connects", () => {
		const { heartbeat, checkIn } = setup({ value: true });
		heartbeat.beat();
		expect(checkIn).toHaveBeenCalledWith("ok");
		heartbeat.stop();
	});

	it("logs when the status changes, not on every beat", async () => {
		const healthy = { value: true };
		const { info } = setup(healthy);
		await vi.advanceTimersByTimeAsync(180_000);
		healthy.value = false;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(info.mock.calls.map(([fields]) => fields)).toEqual([
			{ event: "heartbeat.status", status: "ok" },
			{ event: "heartbeat.status", status: "error" },
		]);
	});

	it("never lets a failing check-in escape the timer", async () => {
		const { checkIn, warn } = setup({ value: true });
		checkIn.mockImplementation(() => {
			throw new Error("sentry down");
		});
		await vi.advanceTimersByTimeAsync(60_000);
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({ event: "heartbeat.failed" }),
			"couldn't check in",
		);
	});

	it("doesn't keep the process alive on its own", () => {
		const { heartbeat } = setup({ value: true });
		expect(vi.getTimerCount()).toBe(1);
		heartbeat.stop();
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("monitorSlug", () => {
	it("is one monitor per environment", () => {
		expect(monitorSlug("prod")).toBe("pixel-prod");
		expect(monitorSlug("dev")).toBe("pixel-dev");
	});
});

describe("planHeartbeat", () => {
	const dsn = "https://public@sentry.example.com/1";

	it("checks in to the environment's monitor in dev and prod", () => {
		expect(planHeartbeat({ env: "dev", sentryDsn: dsn, heartbeatMinutes: 5 })).toEqual({
			monitorSlug: "pixel-dev",
			intervalMinutes: 5,
		});
		expect(planHeartbeat({ env: "prod", sentryDsn: dsn, heartbeatMinutes: 10 })).toEqual({
			monitorSlug: "pixel-prod",
			intervalMinutes: 10,
		});
	});

	it("is off on a laptop, even with a DSN, so developers don't share a monitor that alerts when they stop", () => {
		expect(planHeartbeat({ env: "local", sentryDsn: dsn, heartbeatMinutes: 5 })).toEqual({
			off: "local",
		});
	});

	it("is off without Sentry or when turned off", () => {
		expect(planHeartbeat({ env: "prod", sentryDsn: undefined, heartbeatMinutes: 5 })).toEqual({
			off: "no-sentry",
		});
		expect(planHeartbeat({ env: "prod", sentryDsn: "", heartbeatMinutes: 5 })).toEqual({
			off: "no-sentry",
		});
		expect(planHeartbeat({ env: "prod", sentryDsn: dsn, heartbeatMinutes: 0 })).toEqual({
			off: "disabled",
		});
	});
});

describe("sentryCheckIn, with a real Sentry client", () => {
	const envelopes: unknown[][] = [];
	beforeAll(() => {
		Sentry.init({
			...sentryOptions({
				dsn: "https://key@o0.ingest.sentry.io/1",
				environment: "test",
				release: "1",
				tracesSampleRate: 1,
				profileSessionSampleRate: 0,
			}),
			transport: () => ({
				send: async (envelope: unknown[]) => {
					envelopes.push(envelope);
					return {};
				},
				flush: async () => true,
			}),
		});
	});
	afterAll(async () => {
		await Sentry.close(1000);
	});

	it("sends a check-in for the monitor, with a schedule Sentry can create the monitor from", async () => {
		sentryCheckIn("pixel-test", 5)("ok");
		sentryCheckIn("pixel-test", 1)("error");
		await Sentry.flush(1000);
		const checkIns = envelopes.flatMap((envelope) =>
			(envelope[1] as [{ type: string }, Record<string, unknown>][])
				.filter(([header]) => header.type === "check_in")
				.map(([, payload]) => payload),
		);
		expect(checkIns).toHaveLength(2);
		expect(checkIns[0]).toMatchObject({
			monitor_slug: "pixel-test",
			status: "ok",
			environment: "test",
			monitor_config: {
				schedule: { type: "interval", value: 5, unit: "minute" },
				checkin_margin: 5,
				max_runtime: 1,
				failure_issue_threshold: 1,
				recovery_threshold: 1,
			},
		});
		// A short interval still leaves five minutes' room for a restart.
		expect(checkIns[1]).toMatchObject({
			status: "error",
			monitor_config: { schedule: { value: 1 }, checkin_margin: 5 },
		});
	});
});
