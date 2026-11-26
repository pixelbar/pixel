import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
	clients: [] as { url: string; credential: unknown; options: unknown }[],
	receiveMessages: vi.fn(),
	deleteMessage: vi.fn(),
	credentials: [] as { kind: string; options?: unknown }[],
}));

vi.mock("@azure/storage-queue", () => ({
	QueueClient: class {
		constructor(url: string, credential: unknown, options: unknown) {
			sdk.clients.push({ url, credential, options });
		}
		receiveMessages = sdk.receiveMessages;
		deleteMessage = sdk.deleteMessage;
	},
}));

vi.mock("@azure/identity", () => ({
	ManagedIdentityCredential: class {
		kind = "managed-identity";
		constructor(options: unknown) {
			sdk.credentials.push({ kind: this.kind, options });
		}
	},
	AzureCliCredential: class {
		kind = "azure-cli";
		constructor() {
			sdk.credentials.push({ kind: this.kind });
		}
	},
}));

const { createAzureQueue } = await import("../../../src/adapters/pixel-phone/azure-queue.ts");

const URL = "https://pixelphonedevst.queue.core.windows.net/phone-events";
const CLIENT = "00000000-0000-4000-8000-000000000001";

beforeEach(() => {
	sdk.clients.length = 0;
	sdk.credentials.length = 0;
	sdk.receiveMessages.mockReset();
	sdk.deleteMessage.mockReset();
});

describe("createAzureQueue", () => {
	it("signs in as the managed identity in the cloud, and with the Azure CLI on a laptop", () => {
		createAzureQueue({ queueUrl: URL, clientId: CLIENT });
		createAzureQueue({ queueUrl: URL, clientId: undefined });
		expect(sdk.credentials).toEqual([
			{ kind: "managed-identity", options: { clientId: CLIENT } },
			{ kind: "azure-cli" },
		]);
		expect(sdk.clients[0]).toMatchObject({
			url: URL,
			options: { retryOptions: { maxTries: 1, tryTimeoutInMs: 5000 } },
		});
	});

	it("receives messages with a time limit, hidden while they're handled", async () => {
		sdk.receiveMessages.mockResolvedValue({
			receivedMessageItems: [
				{
					messageId: "m1",
					popReceipt: "r1",
					messageText: "{ }",
					dequeueCount: 1,
					insertedOn: new Date(),
				},
			],
		});
		const queue = createAzureQueue({ queueUrl: URL, clientId: CLIENT });
		expect(await queue.receive(32)).toEqual([
			{ messageId: "m1", popReceipt: "r1", messageText: "{ }", dequeueCount: 1 },
		]);
		expect(sdk.receiveMessages).toHaveBeenCalledWith({
			numberOfMessages: 32,
			visibilityTimeout: 30,
			abortSignal: expect.any(AbortSignal),
		});
	});

	it("deletes a message by its ID and pop receipt, with a time limit", async () => {
		sdk.deleteMessage.mockResolvedValue({});
		const queue = createAzureQueue({ queueUrl: URL, clientId: CLIENT });
		await queue.delete({ messageId: "m1", popReceipt: "r1" });
		expect(sdk.deleteMessage).toHaveBeenCalledWith("m1", "r1", {
			abortSignal: expect.any(AbortSignal),
		});
	});
});
