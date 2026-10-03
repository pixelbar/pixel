export type RateLimitOptions = {
	/** Maximum burst size. */
	capacity: number;
	/** Tokens added back per second. */
	refillPerSecond: number;
	now?: () => number;
};

type Bucket = { tokens: number; updatedAt: number };

/**
 * In-memory token bucket per key. Fine for Pixel's single replica; would need
 * shared storage if Pixel ever ran more than one instance.
 */
export class RateLimiter {
	readonly #buckets = new Map<string, Bucket>();
	readonly #capacity: number;
	readonly #refillPerMs: number;
	readonly #now: () => number;

	constructor({ capacity, refillPerSecond, now = Date.now }: RateLimitOptions) {
		this.#capacity = capacity;
		this.#refillPerMs = refillPerSecond / 1000;
		this.#now = now;
	}

	/** Takes a token for `key`. Returns false if the key is rate limited. */
	tryTake(key: string): boolean {
		const now = this.#now();
		const bucket = this.#buckets.get(key) ?? { tokens: this.#capacity, updatedAt: now };
		const refilled = Math.min(
			this.#capacity,
			bucket.tokens + (now - bucket.updatedAt) * this.#refillPerMs,
		);
		if (refilled < 1) {
			this.#buckets.set(key, { tokens: refilled, updatedAt: now });
			return false;
		}
		this.#buckets.set(key, { tokens: refilled - 1, updatedAt: now });
		this.#prune(now);
		return true;
	}

	/** Drops buckets that have fully refilled, so memory stays bounded. */
	#prune(now: number): void {
		if (this.#buckets.size < 1000) return;
		const fullAfterMs = this.#capacity / this.#refillPerMs;
		for (const [key, bucket] of this.#buckets) {
			if (now - bucket.updatedAt >= fullAfterMs) this.#buckets.delete(key);
		}
	}
}
