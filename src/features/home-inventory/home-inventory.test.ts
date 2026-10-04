import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "../../core/logger.ts";
import { createHomeInventoryFeature } from "./index.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("the home inventory feature", () => {
	it("has no commands: the inventory is never something people can reach", () => {
		const feature = createHomeInventoryFeature({
			inventory: { sync: vi.fn(), intervalMs: 1000 },
			logger: silentLogger,
		});
		expect(feature.name).toBe("home-inventory");
		expect(feature.commands).toBeUndefined();
	});

	it("syncs on the interval, and stops when told to", async () => {
		const sync = vi.fn(async () => ({ kind: "skipped", reason: "unavailable" }) as const);
		const stop = createHomeInventoryFeature({
			inventory: { sync, intervalMs: 60_000 },
			logger: silentLogger,
		}).start?.();
		expect(sync).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(sync).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(sync).toHaveBeenCalledTimes(3);
		stop?.();
		await vi.advanceTimersByTimeAsync(600_000);
		expect(sync).toHaveBeenCalledTimes(3);
	});

	it("doesn't start a timer when the interval is 0", async () => {
		const sync = vi.fn();
		const stop = createHomeInventoryFeature({
			inventory: { sync, intervalMs: 0 },
			logger: silentLogger,
		}).start?.();
		await vi.advanceTimersByTimeAsync(86_400_000);
		expect(sync).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		stop?.();
	});

	it("logs a failure instead of letting it escape as an unhandled rejection", async () => {
		const error = vi.fn();
		const logger = { ...silentLogger, error };
		const stop = createHomeInventoryFeature({
			inventory: {
				sync: async () => {
					throw new Error("boom");
				},
				intervalMs: 1000,
			},
			logger,
		}).start?.();
		await vi.advanceTimersByTimeAsync(1000);
		expect(error).toHaveBeenCalledWith(
			expect.objectContaining({ event: "home.inventory_failed" }),
			"inventory sync failed",
		);
		stop?.();
	});
});
