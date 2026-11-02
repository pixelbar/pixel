import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../core/logger.ts";
import { silentLogger } from "../core/logger.ts";
import {
	activityAttributes,
	activityText,
	ParkingActivity,
	type ParkingActivityEvent,
} from "./parking-activity.ts";

const ZONE = "Europe/Amsterdam";
const NOW = new Date("2026-10-24T08:00:00Z");
const NOON = new Date("2026-10-24T10:00:00Z");
const RESET = new Date("2026-10-24T21:59:00Z");
const CHANNEL = "100000000000000050";

const EVENTS: [ParkingActivityEvent, string, Record<string, string>][] = [
	[
		{ kind: "booked", spot: "ours", who: "Alice *A*", until: NOON },
		"**Alice \\*A\\*** parked in **ours** until about 12:00.",
		{ event: "booked", spot: "ours" },
	],
	[
		{ kind: "none-free", who: "Alice" },
		"**Alice** asked to park, but nothing was free for that long.",
		{ event: "none-free" },
	],
	[
		{ kind: "left", spot: "ours", who: "Alice" },
		"**Alice** left **ours**.",
		{ event: "left", spot: "ours" },
	],
	[
		{ kind: "extended", spot: "ours", who: "Alice", until: NOON },
		"**Alice** extended **ours** until about 12:00.",
		{ event: "extended", spot: "ours" },
	],
	[
		{ kind: "ended", spot: "ours", who: "Alice", reason: "over" },
		"Pixel ended **Alice**'s parking in **ours**: their time was up.",
		{ event: "ended", reason: "over", spot: "ours" },
	],
	[
		{ kind: "ended", spot: "ours", who: "Alice", reason: "reset" },
		"Pixel ended **Alice**'s parking in **ours** at the daily reset.",
		{ event: "ended", reason: "reset", spot: "ours" },
	],
	[
		{ kind: "moved", from: "ours", to: "neighbour-1", who: "Alice", closedUntil: RESET },
		"⚠️ **Alice** reported **ours** taken by someone else. Pixel moved them to **neighbour-1** and closed **ours** until 23:59.",
		{ event: "moved", spot: "ours", to: "neighbour-1" },
	],
	[
		{ kind: "taken", spot: "ours", who: "Alice", closedUntil: RESET },
		"⚠️ **Alice** reported **ours** taken by someone else, and no other spot was free, so they were asked to leave. **ours** is closed until 23:59. Please look into it.",
		{ event: "taken", spot: "ours" },
	],
	[
		{ kind: "freed", spot: "ours", who: "Alice", admin: "Admin" },
		"**Admin** ended **Alice**'s booking in **ours**.",
		{ event: "freed", spot: "ours" },
	],
	[
		{ kind: "evicted", spot: "ours", who: "Alice", admin: "Admin" },
		"**Admin** changed **ours**, which ended **Alice**'s booking there.",
		{ event: "evicted", spot: "ours" },
	],
	[
		{ kind: "admin", action: "opened", admin: "", text: "opened parking: **neighbour-1** open." },
		"**Someone** opened parking: **neighbour-1** open.",
		{ event: "admin", action: "opened" },
	],
];

describe("parking activity", () => {
	it.each(EVENTS)(
		"describes %j for the channel, and counts it without who",
		(event, text, attrs) => {
			expect(activityText(event, NOW, ZONE)).toBe(text);
			expect(activityAttributes(event)).toEqual(attrs);
		},
	);

	it("posts to the parking channel with mentions off, and counts it", async () => {
		const post = vi.fn(async () => {});
		const count = vi.fn();
		const activity = new ParkingActivity({
			posts: { post },
			channelId: CHANNEL,
			reporter: { count },
			logger: silentLogger,
			timezone: ZONE,
		});
		expect(activity.posting).toBe(true);
		expect(await activity.record({ kind: "left", spot: "ours", who: "Alice" }, NOW)).toBe(true);
		expect(post).toHaveBeenCalledWith(CHANNEL, {
			kind: "message",
			text: "**Alice** left **ours**.",
			mentions: false,
		});
		expect(count).toHaveBeenCalledWith("pixel.parking", { event: "left", spot: "ours" });
	});

	it("only counts when there's no channel, or no metrics", async () => {
		const post = vi.fn(async () => {});
		const count = vi.fn();
		const off = new ParkingActivity({
			posts: { post },
			channelId: undefined,
			reporter: { count },
			logger: silentLogger,
			timezone: ZONE,
		});
		expect(off.posting).toBe(false);
		expect(await off.record({ kind: "none-free", who: "A" }, NOW)).toBe(false);
		expect(post).not.toHaveBeenCalled();
		expect(count).toHaveBeenCalledTimes(1);
		const noMetrics = new ParkingActivity({
			posts: { post },
			channelId: CHANNEL,
			reporter: {},
			logger: silentLogger,
			timezone: ZONE,
		});
		expect(await noMetrics.record({ kind: "none-free", who: "A" }, NOW)).toBe(true);
	});

	it("logs a failed post without the text, and never throws", async () => {
		const warn = vi.fn();
		const log = { ...silentLogger, warn } as unknown as Logger;
		Object.assign(log, { child: () => log });
		const activity = new ParkingActivity({
			posts: { post: vi.fn(async () => Promise.reject(new Error("Missing Access"))) },
			channelId: CHANNEL,
			reporter: {},
			logger: log,
			timezone: ZONE,
		});
		expect(await activity.record({ kind: "left", spot: "ours", who: "Secret Name" }, NOW)).toBe(
			false,
		);
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({ event: "parking.channel_failed", kind: "left" }),
			expect.any(String),
		);
		expect(JSON.stringify(warn.mock.calls)).not.toContain("Secret Name");
	});
});
