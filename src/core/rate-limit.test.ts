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

	it("prunes fully refilled buckets once many keys are tracked", () => {
		let now = 0;
		const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 1, now: () => now });
		for (let i = 0; i < 1000; i++) limiter.tryTake(`user-${i}`);
		expect(limiter.size).toBe(1000);

		now = 10_000; // long enough for every bucket to refill
		limiter.tryTake("newcomer");
		expect(limiter.size).toBe(1);
		// A pruned key starts again with a full bucket.
		expect([
			limiter.tryTake("user-0"),
			limiter.tryTake("user-0"),
			limiter.tryTake("user-0"),
		]).toEqual([true, true, false]);
	});

	it("keeps buckets that are still refilling", () => {
		let now = 0;
		const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 1, now: () => now });
		for (let i = 0; i < 1000; i++) limiter.tryTake(`user-${i}`);
		now = 500;
		limiter.tryTake("newcomer");
		expect(limiter.size).toBe(1001);
	});

	it("tracks keys independently", () => {
		const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 1, now: () => 0 });
		expect(limiter.tryTake("a")).toBe(true);
		expect(limiter.tryTake("b")).toBe(true);
		expect(limiter.tryTake("a")).toBe(false);
	});
});
