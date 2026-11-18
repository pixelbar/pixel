import type { Logger } from "./logger.ts";
import type { ErrorReporter } from "./ports/error-reporter.ts";

/**
 * The Pixelbar doorbell. pixel-phone answers it: OpenR's intercom calls a phone number,
 * pixel-phone rings the siren in the space, and picks up only when someone accepts,
 * with the button in the space or from Discord. It tells Pixel what happens to each
 * call, and an adapter hands those events to the features that subscribe here. The core
 * knows nothing about where they come from.
 *
 * Events aren't ordered: two for the same call can arrive either way round. Key on
 * `callId` and compare `occurredAt`; anything after `ringing` settles the call.
 */

/** pixel-phone's call IDs: the date and 12 random hex characters. Not secret. */
export const CALL_ID = /^\d{8}-[0-9a-f]{12}$/;

type Base = {
	callId: string;
	occurredAt: Date;
};

export type DoorbellEvent =
	/** Someone is at the door. Accepts after `acceptBy` are refused. */
	| (Base & { type: "ringing"; acceptBy: Date })
	/**
	 * Someone accepted, and pixel-phone is picking up. `via` is who asked it to:
	 * `home-assistant` (the button in the space) or `pixel`. `by` is who, when the caller
	 * said (for Pixel, `discord:<id>`); pixel-phone doesn't check it.
	 */
	| (Base & { type: "accepted"; via: string; by?: string })
	/** Nobody accepted in time, or the caller hung up first. The intercom tries the next number. */
	| (Base & { type: "missed"; reason: "timeout" | "caller_hung_up" })
	/** It rang while another call was going on, and wasn't answered. */
	| (Base & { type: "busy"; activeCallId: string })
	/** An accepted call finished. */
	| (Base & { type: "ended"; reason: "playback_finished" | "caller_hung_up" | "abandoned" });

export type DoorbellEventType = DoorbellEvent["type"];

export type DoorbellListener = (event: DoorbellEvent) => void | Promise<void>;

/**
 * Where doorbell events go. An adapter emits them; features subscribe. A listener that
 * throws is logged and reported, and never stops the others or the adapter.
 */
export class DoorbellEvents {
	readonly #listeners = new Set<DoorbellListener>();
	readonly #logger: Logger;
	readonly #reporter: Pick<ErrorReporter, "captureBackground">;

	constructor(deps: { logger: Logger; reporter: Pick<ErrorReporter, "captureBackground"> }) {
		this.#logger = deps.logger.child({ component: "doorbell" });
		this.#reporter = deps.reporter;
	}

	/** Calls `listener` with every event from now on. Returns a function that stops it. */
	subscribe(listener: DoorbellListener): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	/** Hands an event to every listener, and resolves once they've all finished. Never throws. */
	async emit(event: DoorbellEvent): Promise<void> {
		await Promise.all(
			[...this.#listeners].map(async (listener) => {
				try {
					await listener(event);
				} catch (error) {
					this.#logger.error(
						{
							event: "doorbell.listener_failed",
							type: event.type,
							callId: event.callId,
							err: error,
						},
						"a doorbell listener failed",
					);
					this.#reporter.captureBackground(error, "doorbell");
				}
			}),
		);
	}
}
