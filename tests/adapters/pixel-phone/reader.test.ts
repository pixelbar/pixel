import { afterEach, describe, expect, it, vi } from "vitest";
import { createPixelPhoneReader } from "../../../src/adapters/pixel-phone/index.ts";
import {
	createQueueReader,
	type PhoneQueue,
	type QueueMessage,
} from "../../../src/adapters/pixel-phone/reader.ts";
import type { DoorbellEvent } from "../../../src/core/doorbell.ts";
import type { Logger } from "../../../src/core/logger.ts";

const CALL = "20261118-3f9a1c2b7d4e";
const NOW = new Date("2026-11-18T09:00:01Z");

const ringing = JSON.stringify({
	version: 1,
	type: "ringing",
	callId: CALL,
	occurredAt: "2026-11-18T09:00:00.000Z",
	from: "+31201234567",
	to: "+31103024128",
	acceptBy: "2026-11-18T09:00:15.000Z",
});

let next = 0;
const message = (messageText: string, dequeueCount = 1): QueueMessage => {
	next += 1;
	return { messageId: `m${next}`, popReceipt: `r${next}`, messageText, dequeueCount };
};

/** A queue in memory: `receive` hands out what's waiting, once. */
class FakeQueue implements PhoneQueue {
	waiting: QueueMessage[] = [];
	deleted: string[] = [];
	failReceive: Error | undefined;
	failDelete: Error | undefined;
	receives = 0;

	async receive(max: number): Promise<QueueMessage[]> {
		this.receives += 1;
		if (this.failReceive) throw this.failReceive;
		return this.waiting.splice(0, max);
	}

	async delete(m: Pick<QueueMessage, "messageId" | "popReceipt">): Promise<void> {
		if (this.failDelete) throw this.failDelete;
		this.deleted.push(m.messageId);
	}
}

const recordingLogger = () => {
	const lines: { level: string; obj: Record<string, unknown> }[] = [];
	const logger: Logger = {
		debug: (obj) => lines.push({ level: "debug", obj: obj as Record<string, unknown> }),
		info: (obj) => lines.push({ level: "info", obj: obj as Record<string, unknown> }),
		warn: (obj) => lines.push({ level: "warn", obj: obj as Record<string, unknown> }),
		error: (obj) => lines.push({ level: "error", obj: obj as Record<string, unknown> }),
		child: () => logger,
	};
	return { logger, lines };
};

const setup = () => {
	const queue = new FakeQueue();
	const handed: DoorbellEvent[] = [];
	const emit = vi.fn(async (event: DoorbellEvent) => {
		handed.push(event);
	});
	const reporter = { captureBackground: vi.fn() };
	const { logger, lines } = recordingLogger();
	const reader = createQueueReader({
		queue,
		events: { emit },
		logger,
		reporter,
		everyMs: 1000,
		maxBackoffMs: 60_000,
		now: () => NOW,
	});
	return { queue, handed, emit, reporter, lines, reader };
};

afterEach(() => {
	vi.useRealTimers();
});

describe("the pixel-phone queue reader", () => {
	it("hands each event on, then deletes its message", async () => {
		const { queue, handed, emit, lines, reader } = setup();
		const m = message(ringing);
		queue.waiting.push(m);
		let deletedBeforeHandedOn = false;
		emit.mockImplementationOnce(async (event) => {
			deletedBeforeHandedOn = queue.deleted.includes(m.messageId);
			handed.push(event);
		});
		expect(await reader.poll()).toBe(true);
		expect(handed).toEqual([
			{
				type: "ringing",
				callId: CALL,
				occurredAt: new Date("2026-11-18T09:00:00Z"),
				acceptBy: new Date("2026-11-18T09:00:15Z"),
			},
		]);
		expect(deletedBeforeHandedOn).toBe(false);
		expect(queue.deleted).toEqual([m.messageId]);
		const logged = lines.find((l) => l.obj.event === "pixel_phone.event");
		expect(logged?.obj).toEqual({
			event: "pixel_phone.event",
			type: "ringing",
			callId: CALL,
			lagMs: 1000,
		});
		// Phone numbers aren't logged.
		expect(JSON.stringify(lines)).not.toContain("+31");
	});

	it("drops malformed and unknown-version messages with a warning, never handing them on", async () => {
		const { queue, emit, lines, reader } = setup();
		const bad = [message("not json"), message(JSON.stringify({ version: 2, type: "rang" }))];
		queue.waiting.push(...bad);
		await reader.poll();
		expect(emit).not.toHaveBeenCalled();
		expect(queue.deleted).toEqual(bad.map((m) => m.messageId));
		expect(
			lines.filter((l) => l.obj.event === "pixel_phone.message_dropped").map((l) => l.obj.why),
		).toEqual(["json", "version"]);
		// What was in them isn't logged.
		expect(JSON.stringify(lines)).not.toContain("rang");
	});

	it("drops a message that keeps coming back, instead of handing it on again", async () => {
		const { queue, emit, reader } = setup();
		const m = message(ringing, 6);
		queue.waiting.push(m);
		await reader.poll();
		expect(emit).not.toHaveBeenCalled();
		expect(queue.deleted).toEqual([m.messageId]);
	});

	it("handles a batch in the order the queue gives it", async () => {
		const { queue, handed, reader } = setup();
		const missed = JSON.stringify({
			version: 1,
			type: "missed",
			callId: CALL,
			occurredAt: "2026-11-18T09:00:15Z",
			reason: "timeout",
		});
		queue.waiting.push(message(ringing), message(missed));
		await reader.poll();
		expect(handed.map((e) => e.type)).toEqual(["ringing", "missed"]);
	});

	it("reports an outage once, backs off while it lasts, and says when it's over", async () => {
		const { queue, reporter, lines, reader } = setup();
		expect(reader.delay()).toBe(1000);
		queue.failReceive = new Error("unreachable");
		expect(await reader.poll()).toBe(false);
		expect(reader.delay()).toBe(2000);
		await reader.poll();
		await reader.poll();
		expect(reader.delay()).toBe(8000);
		for (let i = 0; i < 20; i++) await reader.poll();
		expect(reader.delay()).toBe(60_000);
		expect(reporter.captureBackground).toHaveBeenCalledTimes(1);
		expect(reporter.captureBackground).toHaveBeenCalledWith(expect.any(Error), "pixel-phone");

		queue.failReceive = undefined;
		expect(await reader.poll()).toBe(true);
		expect(reader.delay()).toBe(1000);
		expect(lines.some((l) => l.obj.event === "pixel_phone.queue_recovered")).toBe(true);
	});

	it("treats a delete that fails as an outage: the message comes back later", async () => {
		const { queue, emit, reader } = setup();
		queue.waiting.push(message(ringing));
		queue.failDelete = new Error("timeout");
		expect(await reader.poll()).toBe(false);
		expect(emit).toHaveBeenCalledTimes(1);
	});

	it("polls about once a second until stopped, one poll at a time", async () => {
		vi.useFakeTimers();
		const { queue, reader } = setup();
		const stop = reader.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(queue.receives).toBe(1);
		await vi.advanceTimersByTimeAsync(1000);
		expect(queue.receives).toBe(2);
		await vi.advanceTimersByTimeAsync(3000);
		expect(queue.receives).toBe(5);
		stop();
		await vi.advanceTimersByTimeAsync(5000);
		expect(queue.receives).toBe(5);
	});

	it("doesn't start another poll when stopped while one runs", async () => {
		vi.useFakeTimers();
		const { queue, reader } = setup();
		let release: (() => void) | undefined;
		queue.receive = async () => {
			queue.receives += 1;
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return [];
		};
		const stop = reader.start();
		await vi.advanceTimersByTimeAsync(0);
		stop();
		release?.();
		await vi.advanceTimersByTimeAsync(5000);
		expect(queue.receives).toBe(1);
	});
});

describe("createPixelPhoneReader", () => {
	it("does nothing without a queue configured", () => {
		const { logger, lines } = recordingLogger();
		expect(
			createPixelPhoneReader({
				config: undefined,
				events: { emit: vi.fn() },
				logger,
				reporter: { captureBackground: vi.fn() },
			}),
		).toBeUndefined();
		expect(lines.map((l) => l.obj.event)).toEqual(["pixel_phone.unconfigured"]);
	});

	it("reads the configured queue", async () => {
		const queue = new FakeQueue();
		queue.waiting.push(message(ringing));
		const emit = vi.fn();
		const reader = createPixelPhoneReader({
			config: {
				queueUrl: "https://pixelphonedevst.queue.core.windows.net/phone-events",
				clientId: undefined,
			},
			events: { emit },
			logger: recordingLogger().logger,
			reporter: { captureBackground: vi.fn() },
			queue,
		});
		await reader?.poll();
		expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "ringing", callId: CALL }));
	});
});
