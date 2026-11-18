import type { DoorbellEvents } from "../../core/doorbell.ts";
import type { Logger } from "../../core/logger.ts";
import type { ErrorReporter } from "../../core/ports/error-reporter.ts";
import { createAzureQueue } from "./azure-queue.ts";
import { createQueueReader, type PhoneQueue } from "./reader.ts";

/**
 * pixel-phone, the service that answers the Pixelbar doorbell. Pixel reads its call
 * events from a Storage queue and hands them to the core's `DoorbellEvents`. Without
 * `PIXEL_PHONE_QUEUE_URL` this does nothing and the rest of Pixel is unaffected.
 */
export function createPixelPhoneReader(deps: {
	config: { queueUrl: string; clientId: string | undefined } | undefined;
	events: Pick<DoorbellEvents, "emit">;
	logger: Logger;
	reporter: Pick<ErrorReporter, "captureBackground">;
	/** Overrides the Azure queue (tests). */
	queue?: PhoneQueue;
}) {
	if (!deps.config) {
		deps.logger.info(
			{ event: "pixel_phone.unconfigured" },
			"pixel-phone isn't configured, so doorbell events aren't read",
		);
		return undefined;
	}
	return createQueueReader({
		queue: deps.queue ?? createAzureQueue(deps.config),
		events: deps.events,
		logger: deps.logger,
		reporter: deps.reporter,
	});
}
