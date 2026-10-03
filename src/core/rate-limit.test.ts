import { describe, expect, it } from "vitest";
import { RateLimiter } from "./rate-limit.ts";

describe("RateLimiter", () => {
	it("allows a burst up to capacity, then limits", () => {
		const limiter = new RateLimiter({ capacity: 3, refillPerSecond: 1, now: () => 0 });
		expect([1, 2, 3, 4].map(() => limiter.tryTake("a"))).toEqual([true, true, true, false]);
	});

	it("refills over time", () => {
		let now = 0;
		const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 1, now: () => now });
		expect(limiter.tryTake("a")).toBe(true);
		expect(limiter.tryTake("a")).toBe(false);
		now = 999;
		expect(limiter.tryTake("a")).toBe(false);
		now = 2000;
		expect(limiter.tryTake("a")).toBe(true);
	});

	it("tracks keys independently", () => {
		const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 1, now: () => 0 });
		expect(limiter.tryTake("a")).toBe(true);
		expect(limiter.tryTake("b")).toBe(true);
		expect(limiter.tryTake("a")).toBe(false);
	});
});
