import { AzureCliCredential, ManagedIdentityCredential } from "@azure/identity";
import { QueueClient } from "@azure/storage-queue";
import type { PhoneQueue } from "./reader.ts";

/**
 * pixel-phone's queue through the Azure SDK. This file and `index.ts` are the only places
 * that import `@azure/storage-queue` and `@azure/identity`. Pixel signs in as its own
 * user-assigned managed identity, which pixel-phone's Terraform allows to read and delete
 * messages on that one queue (Storage Queue Data Message Processor). On a laptop it uses
 * the Azure CLI's login instead, which needs the same role.
 *
 * Thin on purpose: what to do with a message is `reader.ts`, which is tested.
 */

/** Each call to the queue gives up after this long. */
const CALL_TIMEOUT_MS = 5000;
/** A received message stays hidden this long; if it isn't deleted by then, it comes back. */
const VISIBILITY_SECONDS = 30;

export function createAzureQueue(options: {
	queueUrl: string;
	/** The managed identity's client ID. Undefined uses the Azure CLI's login. */
	clientId: string | undefined;
}): PhoneQueue {
	const credential = options.clientId
		? new ManagedIdentityCredential({ clientId: options.clientId })
		: new AzureCliCredential();
	const client = new QueueClient(options.queueUrl, credential, {
		retryOptions: { maxTries: 1, tryTimeoutInMs: CALL_TIMEOUT_MS },
	});
	return {
		async receive(max) {
			const response = await client.receiveMessages({
				numberOfMessages: max,
				visibilityTimeout: VISIBILITY_SECONDS,
				abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS),
			});
			return response.receivedMessageItems.map((item) => ({
				messageId: item.messageId,
				popReceipt: item.popReceipt,
				messageText: item.messageText,
				dequeueCount: item.dequeueCount,
			}));
		},
		async delete(message) {
			await client.deleteMessage(message.messageId, message.popReceipt, {
				abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS),
			});
		},
	};
}
