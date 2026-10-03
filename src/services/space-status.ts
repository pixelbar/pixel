import { z } from "zod";
import type { Logger } from "../core/logger.ts";

/**
 * Pixelbar's open/closed state from SpaceAPI (https://spaceapi.io).
 *
 * - `checkNow()` asks SpaceAPI live; concurrent calls share one request.
 * - Background polling (`start()`) keeps checking so Pixel notices changes even
 *   when nobody asks — that's how it knows "since when". SpaceAPI itself has no
 *   change timestamp, so "since" is only known for changes Pixel observed.
 * - `onChange` fires on real open↔closed flips (used by announcements, #3).
 *
 * The response is untrusted input: size-capped, time-limited and validated.
 */

export type SpaceState = "open" | "closed" | "unknown";

export type SpaceReading = {
	state: SpaceState;
	/** When Pixel saw the space change to this state; null if it didn't see it happen. */
	since: Date | null;
	checkedAt: Date;
};

export type SpaceChange = { from: "open" | "closed"; to: "open" | "closed"; at: Date };

export type SpaceStatus = {
	checkNow(): Promise<SpaceReading>;
	start(): void;
	stop(): void;
	onChange(listener: (change: SpaceChange) => void): () => void;
};

export class SpaceApiError extends Error {
	override name = "SpaceApiError";
}

export type SpaceStatusOptions = {
	url: string;
	logger: Logger;
	/** Reports persistent failures (once per outage, not per check). */
	reportError: (error: unknown) => void;
	fetch?: typeof globalThis.fetch;
	now?: () => Date;
	timeoutMs?: number;
	pollIntervalMs?: number;
	/** Consecutive failures before the outage is reported. */
	failureThreshold?: number;
	maxResponseBytes?: number;
};

const responseSchema = z.object({
	open: z.boolean().nullable().optional(),
	state: z.object({ open: z.boolean().nullable().optional() }).optional(),
});

export class SpaceApiStatus implements SpaceStatus {
	readonly #url: string;
	readonly #logger: Logger;
	readonly #reportError: (error: unknown) => void;
	readonly #fetch: typeof globalThis.fetch;
	readonly #now: () => Date;
	readonly #timeoutMs: number;
	readonly #pollIntervalMs: number;
	readonly #failureThreshold: number;
	readonly #maxResponseBytes: number;
	readonly #listeners = new Set<(change: SpaceChange) => void>();

	#known: { state: "open" | "closed"; since: Date | null } | undefined;
	#inFlight: Promise<SpaceReading> | undefined;
	#consecutiveFailures = 0;
	#timer: ReturnType<typeof setInterval> | undefined;

	constructor(options: SpaceStatusOptions) {
		this.#url = options.url;
		this.#logger = options.logger.child({ service: "spaceapi" });
		this.#reportError = options.reportError;
		this.#fetch = options.fetch ?? globalThis.fetch;
		this.#now = options.now ?? (() => new Date());
		this.#timeoutMs = options.timeoutMs ?? 5_000;
		this.#pollIntervalMs = options.pollIntervalMs ?? 60_000;
		this.#failureThreshold = options.failureThreshold ?? 5;
		this.#maxResponseBytes = options.maxResponseBytes ?? 64 * 1024;
	}

	checkNow(): Promise<SpaceReading> {
		this.#inFlight ??= this.#check().finally(() => {
			this.#inFlight = undefined;
		});
		return this.#inFlight;
	}

	start(): void {
		if (this.#timer) return;
		this.#poll();
		this.#timer = setInterval(() => this.#poll(), this.#pollIntervalMs);
		this.#timer.unref();
	}

	/** One background check. Failures are already logged and counted by #check. */
	#poll(): void {
		this.checkNow().catch(() => {});
	}

	stop(): void {
		clearInterval(this.#timer);
		this.#timer = undefined;
	}

	onChange(listener: (change: SpaceChange) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async #check(): Promise<SpaceReading> {
		let state: SpaceState;
		try {
			state = await this.#fetchState();
		} catch (error) {
			this.#recordFailure(error);
			throw error instanceof SpaceApiError
				? error
				: new SpaceApiError("SpaceAPI request failed", { cause: error });
		}
		this.#recordSuccess();
		return this.#record(state);
	}

	async #fetchState(): Promise<SpaceState> {
		const response = await this.#fetch(this.#url, {
			signal: AbortSignal.timeout(this.#timeoutMs),
			headers: { accept: "application/json" },
		});
		if (!response.ok) throw new SpaceApiError(`SpaceAPI responded with HTTP ${response.status}`);

		const declared = Number(response.headers.get("content-length"));
		if (declared > this.#maxResponseBytes) throw new SpaceApiError("SpaceAPI response too large");
		const body = await response.text();
		if (body.length > this.#maxResponseBytes)
			throw new SpaceApiError("SpaceAPI response too large");

		let json: unknown;
		try {
			json = JSON.parse(body);
		} catch {
			throw new SpaceApiError("SpaceAPI returned invalid JSON");
		}
		const parsed = responseSchema.safeParse(json);
		if (!parsed.success) throw new SpaceApiError("SpaceAPI response has an unexpected shape");

		// v0.13 has both `state.open` and the deprecated top-level `open`; prefer `state`.
		const open = parsed.data.state?.open !== undefined ? parsed.data.state.open : parsed.data.open;
		if (open === undefined) throw new SpaceApiError("SpaceAPI response has no open state");
		if (open === null) return "unknown";
		return open ? "open" : "closed";
	}

	#record(state: SpaceState): SpaceReading {
		const now = this.#now();
		if (state === "unknown") return { state, since: null, checkedAt: now };

		const previous = this.#known;
		if (!previous) {
			// First observation: we don't know when this state began.
			this.#known = { state, since: null };
		} else if (previous.state !== state) {
			this.#known = { state, since: now };
			this.#logger.info(
				{ event: "spaceapi.changed", from: previous.state, to: state },
				"space state changed",
			);
			this.#emit({ from: previous.state, to: state, at: now });
		}
		return { state, since: this.#known?.since ?? null, checkedAt: now };
	}

	#emit(change: SpaceChange): void {
		for (const listener of this.#listeners) {
			try {
				listener(change);
			} catch (error) {
				this.#logger.error({ err: error }, "space change listener failed");
				this.#reportError(error);
			}
		}
	}

	#recordFailure(error: unknown): void {
		this.#consecutiveFailures++;
		this.#logger.warn(
			{ event: "spaceapi.failed", consecutiveFailures: this.#consecutiveFailures, err: error },
			"SpaceAPI check failed",
		);
		if (this.#consecutiveFailures === this.#failureThreshold) {
			this.#reportError(
				new SpaceApiError(`SpaceAPI failed ${this.#failureThreshold} times in a row`, {
					cause: error,
				}),
			);
		}
	}

	#recordSuccess(): void {
		if (this.#consecutiveFailures > 0) {
			this.#logger.info(
				{ event: "spaceapi.recovered", afterFailures: this.#consecutiveFailures },
				"SpaceAPI reachable again",
			);
		}
		this.#consecutiveFailures = 0;
	}
}
