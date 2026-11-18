import type { DoorbellEvents } from "../../core/doorbell.ts";
import type { Stop } from "../../core/feature.ts";
import type { Logger } from "../../core/logger.ts";
import type { ErrorReporter } from "../../core/ports/error-reporter.ts";
import { parseMessage } from "./events.ts";

/**
 * Reads pixel-phone's call events from its Storage queue (`phone-events`) and hands them
 * to the core. Pixel has no ingress, so it polls: about once a second, which is how soon
 * a doorbell post appears after the phone starts ringing.
 *
 * Every message is deleted once it's been handed on, or straight away if it's malformed
 * or a version Pixel doesn't know: nothing is retried forever. A queue that can't be
 * reached is logged and reported once per outage, polled less often until it's back,
 * and never stops or restarts Pixel.
 */

/** One message as the queue gives it. */
export type QueueMessage = {
	messageId: string;
	popReceipt: string;
	messageText: string;
	/** How many times it has been received, this time included. */
	dequeueCount: number;
};

/** The queue, as far as the reader needs it. Each call has its own time limit. */
export type PhoneQueue = {
	receive(max: number): Promise<QueueMessage[]>;
	delete(message: Pick<QueueMessage, "messageId" | "popReceipt">): Promise<void>;
};

export type ReaderDeps = {
	queue: PhoneQueue;
	events: Pick<DoorbellEvents, "emit">;
	logger: Logger;
	reporter: Pick<ErrorReporter, "captureBackground">;
	/** How long between polls while the queue answers. */
	everyMs?: number;
	/** The longest wait between polls while it doesn't. */
	maxBackoffMs?: number;
	now?: () => Date;
};

/** The most the queue hands out at once. */
const BATCH = 32;
/**
 * A message received this often was never deleted, so handling it keeps failing (or Pixel
 * keeps stopping halfway). It's dropped instead of being handed on again.
 */
const MAX_DEQUEUES = 5;

export function createQueueReader(deps: ReaderDeps) {
	const everyMs = deps.everyMs ?? 1000;
	const maxBackoffMs = deps.maxBackoffMs ?? 60_000;
	const now = deps.now ?? (() => new Date());
	const log = deps.logger.child({ component: "pixel-phone" });
	/** Polls that have failed in a row. */
	let failures = 0;

	async function drop(message: QueueMessage, why: string): Promise<void> {
		log.warn(
			{ event: "pixel_phone.message_dropped", why, dequeueCount: message.dequeueCount },
			"dropped a message from pixel-phone's queue",
		);
		await deps.queue.delete(message);
	}

	async function handle(message: QueueMessage): Promise<void> {
		if (message.dequeueCount > MAX_DEQUEUES) {
			await drop(message, "dequeued too often");
			return;
		}
		const parsed = parseMessage(message.messageText);
		if (!parsed.ok) {
			await drop(message, parsed.why);
			return;
		}
		const { event } = parsed;
		log.info(
			{
				event: "pixel_phone.event",
				type: event.type,
				callId: event.callId,
				lagMs: now().getTime() - event.occurredAt.getTime(),
			},
			"call event from pixel-phone",
		);
		// Never throws: a listener's failure is its own.
		await deps.events.emit(event);
		await deps.queue.delete(message);
	}

	/** One poll: everything waiting, in the order the queue gives it. Resolves to whether it worked. */
	async function poll(): Promise<boolean> {
		try {
			const messages = await deps.queue.receive(BATCH);
			for (const message of messages) await handle(message);
			if (failures > 0) {
				log.info(
					{ event: "pixel_phone.queue_recovered", failures },
					"pixel-phone's queue answers again",
				);
			}
			failures = 0;
			return true;
		} catch (error) {
			failures += 1;
			log.error(
				{ event: "pixel_phone.queue_failed", failures, err: error },
				"couldn't read pixel-phone's queue",
			);
			// Once per outage, not once a second.
			if (failures === 1) deps.reporter.captureBackground(error, "pixel-phone");
			return false;
		}
	}

	/** How long to wait after this poll. */
	function delay(): number {
		if (failures === 0) return everyMs;
		return Math.min(everyMs * 2 ** Math.min(failures, 16), maxBackoffMs);
	}

	return {
		poll,
		delay,
		/** Polls until stopped. Each poll starts once the one before has finished. */
		start(): Stop {
			let stopped = false;
			let timer: NodeJS.Timeout | undefined;
			const loop = async () => {
				await poll();
				if (!stopped) timer = setTimeout(loop, delay());
			};
			timer = setTimeout(loop, 0);
			log.info({ event: "pixel_phone.reading" }, "reading pixel-phone's call events");
			return () => {
				stopped = true;
				clearTimeout(timer);
			};
		},
	};
}
