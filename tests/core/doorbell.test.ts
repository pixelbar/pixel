import { describe, expect, it, vi } from "vitest";
import { CALL_ID, type DoorbellEvent, DoorbellEvents } from "../../src/core/doorbell.ts";
import { silentLogger } from "../../src/core/logger.ts";

const RINGING: DoorbellEvent = {
	type: "ringing",
	callId: "20261118-3f9a1c2b7d4e",
	occurredAt: new Date("2026-11-18T09:00:00Z"),
	acceptBy: new Date("2026-11-18T09:00:15Z"),
};

const hub = () => {
	const reporter = { captureBackground: vi.fn() };
	return { events: new DoorbellEvents({ logger: silentLogger, reporter }), reporter };
};

describe("CALL_ID", () => {
	it("matches pixel-phone's call IDs and nothing else", () => {
		expect(CALL_ID.test("20261118-3f9a1c2b7d4e")).toBe(true);
		for (const id of [
			"20261118-3F9A1C2B7D4E",
			"2026111-3f9a1c2b7d4e",
			"20261118-3f9a1c2b7d4",
			"",
		]) {
			expect(CALL_ID.test(id)).toBe(false);
		}
	});
});

describe("DoorbellEvents", () => {
	it("hands every event to every listener, and waits for them", async () => {
		const { events } = hub();
		const seen: string[] = [];
		events.subscribe((event) => {
			seen.push(`a:${event.type}`);
		});
		events.subscribe(async (event) => {
			await new Promise((resolve) => setTimeout(resolve, 5));
			seen.push(`b:${event.type}`);
		});
		await events.emit(RINGING);
		expect(seen.sort()).toEqual(["a:ringing", "b:ringing"]);
	});

	it("stops calling a listener once it unsubscribes", async () => {
		const { events } = hub();
		const listener = vi.fn();
		const stop = events.subscribe(listener);
		await events.emit(RINGING);
		stop();
		await events.emit(RINGING);
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("reports a listener that fails, and still calls the others", async () => {
		const { events, reporter } = hub();
		const other = vi.fn();
		events.subscribe(() => {
			throw new Error("boom");
		});
		events.subscribe(other);
		await expect(events.emit(RINGING)).resolves.toBeUndefined();
		expect(other).toHaveBeenCalledWith(RINGING);
		expect(reporter.captureBackground).toHaveBeenCalledWith(expect.any(Error), "doorbell");
	});

	it("does nothing without listeners", async () => {
		await expect(hub().events.emit(RINGING)).resolves.toBeUndefined();
	});
});
