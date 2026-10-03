import { z } from "zod";
import type { Logger } from "../core/logger.ts";
import type { PersistedSpaceState, SpaceStateStore } from "./space-state-store.ts";

/**
 * Pixelbar's open/closed state from SpaceAPI (https://spaceapi.io).
 *
 * - `checkNow()` asks SpaceAPI live; concurrent calls share one request.
 * - Background polling (`start()`) keeps checking so Pixel notices changes even
 *   when nobody asks — that's how it knows "since when". SpaceAPI itself has no
 *   change timestamp, so "since" is only known for changes Pixel observed.
 * - `onChange` fires on real open↔closed flips (used by announcements, #3).
 * - With a `store`, the last known state and "since" survive restarts. On
 *   startup the saved state is only trusted once a live reading agrees with it:
 *   if they differ, the space changed while Pixel was down, so the time is
 *   unknown ("since" is cleared) and no change event fires — we never announce
 *   a stale change on startup.
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
	/** Remembers the state across restarts. Optional: without it, "since" resets on restart. */
	store?: SpaceStateStore;
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
	readonly #store: SpaceStateStore | undefined;
	readonly #listeners = new Set<(change: SpaceChange) => void>();

	#known: PersistedSpaceState | undefined;
	/** True while `#known` was loaded from the store and no live reading has confirmed it yet. */
	#restored = false;
	#saveFailureReported = false;
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
		this.#store = options.store;
		this.#restore();
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

	/** Loads the saved state, if any. Anything unusable is ignored: we just start fresh. */
	#restore(): void {
		if (!this.#store) return;
		let saved: PersistedSpaceState | undefined;
		try {
			saved = this.#store.load();
		} catch (error) {
			this.#logger.warn(
				{ event: "spaceapi.restore_failed", err: error },
				"ignoring unusable saved space state",
			);
			return;
		}
		if (!saved) return;

		// A "since" in the future means the clock moved or the file was edited.
		const since = saved.since && saved.since <= this.#now() ? saved.since : null;
		this.#known = { state: saved.state, since };
		this.#restored = true;
		this.#logger.info(
			{ event: "spaceapi.restored", state: saved.state, since: since?.toISOString() ?? null },
			"restored saved space state",
		);
	}

	#record(state: SpaceState): SpaceReading {
		const now = this.#now();
		if (state === "unknown") return { state, since: null, checkedAt: now };

		const previous = this.#known;
		if (!previous) {
			// First observation: we don't know when this state began.
			this.#remember({ state, since: null });
		} else if (previous.state !== state) {
			if (this.#restored) {
				// It changed while Pixel was down, so when is unknowable. Don't announce it.
				this.#remember({ state, since: null });
				this.#logger.info(
					{ event: "spaceapi.changed_offline", from: previous.state, to: state },
					"space state changed while Pixel was not running",
				);
			} else {
				this.#remember({ state, since: now });
				this.#logger.info(
					{ event: "spaceapi.changed", from: previous.state, to: state },
					"space state changed",
				);
				this.#emit({ from: previous.state, to: state, at: now });
			}
		}
		this.#restored = false;
		return { state, since: this.#known?.since ?? null, checkedAt: now };
	}

	/** Records the new known state and saves it. Failing to save never breaks a check. */
	#remember(next: PersistedSpaceState): void {
		this.#known = next;
		if (!this.#store) return;
		try {
			this.#store.save(next);
		} catch (error) {
			this.#logger.warn({ event: "spaceapi.save_failed", err: error }, "couldn't save space state");
			if (!this.#saveFailureReported) {
				this.#saveFailureReported = true;
				this.#reportError(new SpaceApiError("couldn't save space state", { cause: error }));
			}
		}
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
