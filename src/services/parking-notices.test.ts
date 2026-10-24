import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../core/logger.ts";
import { silentLogger } from "../core/logger.ts";
import type { ParkingBooking } from "./parking-bookings.ts";
import { endedText, ParkingNotices, reminderText } from "./parking-notices.ts";

const ZONE = "Europe/Amsterdam";
const NOW = new Date("2026-10-24T08:45:00Z");
const RESET = new Date("2026-10-24T21:59:00Z");
const booking: ParkingBooking = {
	id: "aaaaaa",
	spot: "ours",
	by: { ref: "discord:100000000000000002", name: "Alice" },
	since: new Date("2026-10-24T08:00:00Z"),
	until: new Date("2026-10-24T09:00:00Z"),
	remindedAt: null,
};
const context = { now: NOW, zone: ZONE, settings: { graceMinutes: 5, resetAt: "23:59" } };

describe("parking DMs", () => {
	it("says why a booking ended", () => {
		expect(endedText(booking, "admin", context)).toBe("An admin ended your parking in **ours**.");
		expect(endedText(booking, "over", context)).toContain("your time was up at 11:00");
		expect(endedText(booking, "reset", context)).toContain("parking ends at 23:59 every day");
	});

	it("offers less than an hour when that's all the spot has", () => {
		const text = reminderText(booking, new Date("2026-10-24T09:20:00Z"), RESET, context);
		expect(text).toContain("`/parking extend for:20m` (up to 20m)");
	});

	it("treats a spot with no opening left as closing", () => {
		expect(reminderText(booking, undefined, RESET, context)).toContain(
			"The spot closes then, so it can't be extended.",
		);
	});
});

describe("ParkingNotices", () => {
	const logger = () => {
		const log = { ...silentLogger, info: vi.fn(), warn: vi.fn() } as unknown as Logger;
		return Object.assign(log, { child: () => log });
	};

	it("DMs the person by their Discord ID, and logs it without the text", async () => {
		const send = vi.fn(async () => {});
		const log = logger();
		await new ParkingNotices({ messages: { send }, logger: log }).send(booking, "over", "text");
		expect(send).toHaveBeenCalledWith("100000000000000002", "text");
		expect(log.info).toHaveBeenCalledWith(
			{
				event: "parking.dm_sent",
				kind: "over",
				spot: "ours",
				user: "discord:100000000000000002",
				userName: "Alice",
			},
			expect.any(String),
		);
	});

	it("logs a failure and never throws", async () => {
		const log = logger();
		const notices = new ParkingNotices({
			messages: { send: vi.fn(async () => Promise.reject(new Error("DMs closed"))) },
			logger: log,
		});
		await notices.send(booking, "reminder", "secret text");
		const failing = new ParkingNotices({
			messages: { send: vi.fn(async () => Promise.reject("nope")) },
			logger: log,
		});
		await failing.send(booking, "admin", "x");
		expect(log.warn).toHaveBeenCalledWith(
			expect.objectContaining({ event: "parking.dm_failed", reason: "DMs closed" }),
			expect.any(String),
		);
		expect(log.warn).toHaveBeenCalledWith(
			expect.objectContaining({ reason: "unknown" }),
			expect.any(String),
		);
		expect(JSON.stringify(vi.mocked(log.warn).mock.calls)).not.toContain("secret text");
	});

	it("only DMs people on Discord", async () => {
		const send = vi.fn(async () => {});
		await new ParkingNotices({ messages: { send }, logger: silentLogger }).send(
			{ ...booking, by: { ref: "telegram:1", name: "T" } },
			"over",
			"x",
		);
		expect(send).not.toHaveBeenCalled();
	});
});
