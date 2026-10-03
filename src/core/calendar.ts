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
};

/**
 * Pixelbar's calendar. Features read events from here and never touch a
 * platform. An adapter plugs its source in once it's connected (the same way
 * publishers register with the announcer); until then the calendar is
 * unavailable.
 *
 * Nothing is cached: every call asks the source, so a renamed or rescheduled
 * event shows up straight away. If the source fails, that's an error
 * ({@link CalendarUnavailableError}), never an out-of-date list. The failure is
 * logged, and reported once per outage rather than on every command.
 */
export class Calendar {
	readonly #logger: Logger;
	readonly #reporter: ErrorReporter;

	#source: CalendarSource | undefined;
	#reported = false;

	constructor({ logger, reporter }: CalendarOptions) {
		this.#logger = logger.child({ component: "calendar" });
		this.#reporter = reporter;
	}

	/** Plugs in where events come from. There can only be one source. */
	use(source: CalendarSource): void {
		if (this.#source) throw new Error("The calendar already has a source");
		this.#source = source;
	}

	/** The calendar's events, as they are right now, or throws {@link CalendarUnavailableError}. */
	async events(): Promise<CalendarEvent[]> {
		const source = this.#source;
		if (!source) throw new CalendarUnavailableError("The calendar isn't connected yet");

		try {
			const events = await source.upcoming();
			this.#reported = false;
			return events;
		} catch (error) {
			this.#logger.warn({ event: "calendar.failed", err: error }, "couldn't load the calendar");
			if (!this.#reported) {
				this.#reported = true;
				this.#reporter.captureBackground(error, "calendar");
			}
			throw new CalendarUnavailableError("The calendar couldn't be loaded", { cause: error });
		}
	}
}
