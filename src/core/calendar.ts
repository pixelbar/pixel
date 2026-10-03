import type { Logger } from "./logger.ts";
import type { ErrorReporter } from "./ports/error-reporter.ts";

/** An event on Pixelbar's calendar, in terms that don't depend on any platform. */
export type CalendarEvent = {
	id: string;
	title: string;
	startsAt: Date;
	/** When it ends, if it has a planned end. */
	endsAt: Date | null;
	/** Where it happens, as plain text: a place, or the name of a voice channel. */
	location: string | null;
	/** A link to the event on its platform. */
	url: string;
	/** How it repeats in plain words (e.g. "weekly on Tuesday"); null if it doesn't. */
	repeats: string | null;
};

/** Where calendar events come from. A platform adapter implements this (Discord scheduled events). */
export type CalendarSource = {
	/**
	 * Events that are scheduled or running, in any order. Finished and cancelled
	 * events are left out. An event that has started and has no end time is
	 * running.
	 */
	upcoming(): Promise<CalendarEvent[]>;
};

/** The calendar can't be read right now, so there's nothing sensible to show. */
export class CalendarUnavailableError extends Error {
	override name = "CalendarUnavailableError";
}

export type CalendarOptions = {
	logger: Logger;
	reporter: ErrorReporter;
	now?: () => number;
	/** How long a loaded list counts as fresh. */
	ttlMs?: number;
	/** How long an old list may still be shown when the source is failing. */
	maxStaleMs?: number;
};

/**
 * Pixelbar's calendar. Features read events from here and never touch a
 * platform. An adapter plugs its source in once it's connected (the same way
 * publishers register with the announcer); until then the calendar is
 * unavailable.
 *
 * - Results are cached briefly, so a busy channel doesn't hit the platform on
 *   every command, and concurrent loads share one request.
 * - If the source fails, a recent enough earlier list is shown instead of an
 *   error. The failure is logged, and reported once per outage.
 */
export class Calendar {
	readonly #logger: Logger;
	readonly #reporter: ErrorReporter;
	readonly #now: () => number;
	readonly #ttlMs: number;
	readonly #maxStaleMs: number;

	#source: CalendarSource | undefined;
	#cache: { events: CalendarEvent[]; loadedAt: number } | undefined;
	#inFlight: Promise<CalendarEvent[]> | undefined;
	#reported = false;

	constructor({ logger, reporter, now, ttlMs, maxStaleMs }: CalendarOptions) {
		this.#logger = logger.child({ component: "calendar" });
		this.#reporter = reporter;
		this.#now = now ?? Date.now;
		this.#ttlMs = ttlMs ?? 60_000;
		this.#maxStaleMs = maxStaleMs ?? 10 * 60_000;
	}

	/** Plugs in where events come from. There can only be one source. */
	use(source: CalendarSource): void {
		if (this.#source) throw new Error("The calendar already has a source");
		this.#source = source;
	}

	/** The calendar's events, or throws {@link CalendarUnavailableError}. */
	async events(): Promise<CalendarEvent[]> {
		const source = this.#source;
		if (!source) throw new CalendarUnavailableError("The calendar isn't connected yet");

		const cache = this.#cache;
		if (cache && this.#now() - cache.loadedAt < this.#ttlMs) return cache.events;

		this.#inFlight ??= this.#load(source).finally(() => {
			this.#inFlight = undefined;
		});
		return this.#inFlight;
	}

	async #load(source: CalendarSource): Promise<CalendarEvent[]> {
		try {
			const events = await source.upcoming();
			this.#cache = { events, loadedAt: this.#now() };
			this.#reported = false;
			return events;
		} catch (error) {
			this.#logger.warn({ event: "calendar.failed", err: error }, "couldn't load the calendar");
			if (!this.#reported) {
				this.#reported = true;
				this.#reporter.captureBackground(error, "calendar");
			}
			const cache = this.#cache;
			if (cache && this.#now() - cache.loadedAt <= this.#maxStaleMs) return cache.events;
			throw new CalendarUnavailableError("The calendar couldn't be loaded", { cause: error });
		}
	}
}
