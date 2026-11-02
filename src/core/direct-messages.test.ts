import { describe, expect, it, vi } from "vitest";
import { DirectMessages } from "./direct-messages.ts";

describe("DirectMessages", () => {
	it("refuses to send until a messenger is plugged in", async () => {
		const messages = new DirectMessages();
		expect(messages.ready).toBe(false);
		await expect(messages.send("100000000000000002", "hi")).rejects.toThrow(/aren't connected/);
	});

	it("sends through the messenger, and passes its failures on", async () => {
		const messages = new DirectMessages();
		const send = vi.fn(async () => {});
		messages.attach({ send });
		expect(messages.ready).toBe(true);
		await messages.send("100000000000000002", "hi");
		expect(send).toHaveBeenCalledWith("100000000000000002", "hi");
		send.mockRejectedValueOnce(new Error("closed"));
		await expect(messages.send("100000000000000002", "hi")).rejects.toThrow("closed");
	});
});
