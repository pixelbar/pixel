import { afterEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "../../core/access.ts";
import { type Args, isGroup, type SuggestContext } from "../../core/command.ts";
import { silentLogger } from "../../core/logger.ts";
import type { Gate } from "../../core/ports/gate.ts";
import { ParkingBookingStore } from "../../services/parking-bookings.ts";
import { ParkingSpotStore } from "../../services/parking-spots.ts";
import { ParkingWindowStore } from "../../services/parking-windows.ts";
import { context, IDS, principal } from "../../testing/fixtures.ts";
import { createParkingFeature, gateLine, PARKING_CAPABILITY, TICK_MS } from "./index.ts";

const ZONE = "Europe/Amsterdam";
/** Saturday 24 Oct 2026, 10:00 in Amsterdam (UTC+2). The reset is 23:59, 21:59 UTC. */
const NOW = new Date("2026-10-24T08:00:00Z");
const utc = (time: string, day = 24) =>
	new Date(`2026-10-${String(day).padStart(2, "0")}T${time}:00Z`);
const RESET = utc("21:59");

const member = (userId: string = IDS.member, displayName = "Alice") =>
	principal("member", { userId, displayName }, ["parking"]);
const BOB = "100000000000000005";

function setup(
	options: { gate?: Gate; spots?: ParkingSpotStore; bookings?: ParkingBookingStore } = {},
) {
	const spots = options.spots ?? new ParkingSpotStore({ logger: silentLogger });
	const windows = new ParkingWindowStore({ logger: silentLogger });
	const bookings = options.bookings ?? new ParkingBookingStore({ logger: silentLogger });
	const gate = options.gate ?? { open: vi.fn(async () => ({ opened: true as const })) };
	const reporter = { captureBackground: vi.fn() };
	let now = NOW;
	const feature = createParkingFeature({
		spots,
		windows,
		bookings,
		gate,
		timezone: ZONE,
		logger: silentLogger,
		reporter,
		now: () => now,
	});
	const [park, parking] = feature.commands ?? [];
	if (!park || isGroup(park) || !parking || !isGroup(parking)) throw new Error("commands");
	const sub = (name: string) => {
		const found = parking.subcommands.find((s) => s.name === name);
		if (!found || !("handler" in found)) throw new Error(`no ${name}`);
		return found;
	};
	const reply = async (
		handler: (typeof park)["handler"],
		args: Args = {},
		who: Principal = member(),
	) => {
		const r = await handler(context({ principal: who, args }));
		expect(r.private).toBe(true);
		return r.text ?? "";
	};
	return {
		spots,
		windows,
		bookings,
		gate,
		reporter,
		feature,
		park,
		parking,
		run: (args: Args, who?: Principal) => reply(park.handler, args, who),
		list: (who?: Principal) => reply(sub("list").handler, {}, who),
		leave: (who?: Principal) => reply(sub("leave").handler, {}, who),
		setNow: (next: Date) => {
			now = next;
		},
		openWindow: (spot: string, from: Date, until: Date) =>
			windows.replace(
				{
					windows: [
						...windows.entries(now).windows,
						{ spot, from, until, setBy: { ref: "x", name: "y" } },
					],
					blocks: windows.entries(now).blocks,
				},
				now,
			),
		closeOurs: (from: Date, until: Date) =>
			windows.replace(
				{
					windows: windows.entries(now).windows,
					blocks: [{ spot: "ours", from, until, setBy: { ref: "x", name: "y" } }],
				},
				now,
			),
	};
}

function withSpots(options?: Parameters<typeof setup>[0]) {
	const t = setup(options);
	t.spots.add({ name: "ours", permanent: true, description: "Next to the *gate*" });
	t.spots.add({ name: "neighbour-1", permanent: false });
	t.spots.add({ name: "neighbour-2", permanent: false });
	t.openWindow("neighbour-1", NOW, utc("12:00"));
	t.openWindow("neighbour-2", NOW, utc("15:00"));
	return t;
}

afterEach(() => {
	vi.useRealTimers();
});

describe("parking", () => {
	it("is for members with the parking capability, and every command is private", () => {
		const { park, parking } = setup();
		const access = { minTier: "member", capability: "parking" };
		expect(PARKING_CAPABILITY.name).toBe("parking");
		expect([park.name, park.access, park.private]).toEqual(["park", access, true]);
		expect(parking.access).toEqual(access);
		expect(parking.subcommands.map((s) => [s.name, s.access])).toEqual([
			["list", access],
			["leave", access],
		]);
	});

	it("suggests the durations from the settings", async () => {
		const { park } = setup();
		const option = park.options?.[0];
		if (!option || !("suggest" in option) || !option.suggest) throw new Error("no suggest");
		expect(await option.suggest({ typed: " H" } as SuggestContext)).toEqual([
			{ name: "1h", value: "1h" },
			{ name: "2h", value: "2h" },
			{ name: "4h", value: "4h" },
		]);
	});
});

describe("/park", () => {
	it("books our own spot first, opens the gate and says where", async () => {
		const t = withSpots();
		const text = await t.run({ for: "2h" });
		expect(text).toBe(
			"Park in **ours** (Next to the \\*gate\\*). It's yours until 12:00.\nThe gate is opening.\nRun `/parking leave` when you go.",
		);
		expect(t.bookings.byPerson(`discord:${IDS.member}`)).toMatchObject({
			spot: "ours",
			by: { name: "Alice" },
			since: NOW,
			until: utc("10:00"),
		});
		expect(t.gate.open).toHaveBeenCalledWith({ principal: member(), spot: "ours" });
	});

	it("then the borrowed spot that fits most tightly", async () => {
		const t = withSpots();
		await t.run({ for: "30m" }, member(BOB, "Bob"));
		expect(await t.run({ for: "1h" })).toContain(
			"Park in **neighbour-1**. It's yours until 11:00.",
		);
		expect(await t.run({ for: "4h" }, member("100000000000000006"))).toContain(
			"Park in **neighbour-2**. It's yours until 14:00.",
		);
	});

	it("books the rest of the day only where a spot is open until the reset", async () => {
		const t = withSpots();
		expect(await t.run({ for: "rest of day" })).toContain("**ours**");
		expect(t.bookings.bySpot("ours")?.until).toEqual(RESET);
		const text = await t.run({ for: "rest of day" }, member(BOB, "Bob"));
		expect(text).toBe(
			"Nothing is free for that long, so the gate stays shut. **neighbour-2** is free until 17:00: try `/park for:7h`.",
		);
		expect(t.bookings.byPerson(`discord:${BOB}`)).toBeUndefined();
	});

	it("says so when every spot is taken or closed", async () => {
		const t = setup();
		t.spots.add({ name: "ours", permanent: true });
		t.closeOurs(NOW, utc("12:00"));
		expect(await t.run({ for: "1h" })).toBe(
			"Sorry, every spot is taken or closed right now, so the gate stays shut.",
		);
		expect(t.gate.open).not.toHaveBeenCalled();
	});

	it("stops before our spot's next closure", async () => {
		const t = setup();
		t.spots.add({ name: "ours", permanent: true });
		t.closeOurs(utc("10:00"), utc("12:00"));
		expect(await t.run({ for: "3h" })).toContain(
			"**ours** is free until 12:00: try `/park for:2h`",
		);
		expect(await t.run({ for: "2h" })).toContain("Park in **ours**");
	});

	it("never books past the reset", async () => {
		const t = withSpots();
		t.setNow(utc("20:00"));
		await expect(t.run({ for: "4h" })).rejects.toThrow(
			"Parking ends at 23:59 every day, so that's too long. Try `/park for:rest of day`.",
		);
	});

	it("refuses a duration it can't read", async () => {
		await expect(withSpots().run({ for: "a while" })).rejects.toThrow(
			/couldn't understand how long/,
		);
	});

	it("makes no second booking, and opens the gate again", async () => {
		const t = withSpots();
		await t.run({ for: "2h" });
		const text = await t.run({ for: "rest of day" });
		expect(text).toContain(
			"You're already parked in **ours** (Next to the \\*gate\\*), until 12:00.",
		);
		expect(text).toContain("The gate is opening.");
		expect(t.bookings.all()).toHaveLength(1);
		expect(t.gate.open).toHaveBeenCalledTimes(2);
	});

	it("keeps the booking when the gate fails, and never retries", async () => {
		const gate = { open: vi.fn(async () => Promise.reject(new Error("timeout"))) };
		const t = withSpots({ gate });
		const text = await t.run({ for: "2h" });
		expect(text).toContain("Park in **ours**");
		expect(text).toContain("⚠️ The gate didn't open. Run `/park` again to try once more.");
		expect(gate.open).toHaveBeenCalledTimes(1);
		expect(t.reporter.captureBackground).toHaveBeenCalledWith(expect.any(Error), "parking");
		expect(t.bookings.all()).toHaveLength(1);
	});

	it("is off while the spots file is invalid", async () => {
		const spots = Object.assign(new ParkingSpotStore({ logger: silentLogger }), { problem: "x" });
		await expect(setup({ spots }).run({ for: "1h" })).rejects.toThrow(/Parking is off/);
	});

	it("says what the gate did", () => {
		expect(gateLine({ opened: false, reason: "not-connected" })).toBe(
			"Pixel can't open the gate yet, so open it the usual way.",
		);
	});
});

describe("/parking list", () => {
	it("shows who's where, since when, until about when, and how long each spot has", async () => {
		const t = withSpots();
		await t.run({ for: "1h" }, member(BOB, "Bob *the* parker"));
		t.setNow(utc("09:30"));
		const text = await t.list();
		expect(text).toBe(
			[
				"**ours** (Next to the \\*gate\\*): taken by Bob \\*the\\* parker since 10:00, until about 11:00 (over by 30m) · open until 23:59 (12h 29m left)",
				"**neighbour-1**: free · open until 14:00 (2h 30m left)",
				"**neighbour-2**: free · open until 17:00 (5h 30m left)",
			].join("\n"),
		);
	});

	it("shows our spot closed, and leaves out closed borrowed spots", async () => {
		const t = setup();
		t.spots.add({ name: "ours", permanent: true });
		t.spots.add({ name: "neighbour-1", permanent: false });
		t.closeOurs(NOW, utc("12:00"));
		expect(await t.list()).toBe("**ours**: closed until 14:00");
	});

	it("says when nothing is open, or there are no spots", async () => {
		const t = setup();
		expect(await t.list()).toBe("There are no parking spots yet.");
		t.spots.add({ name: "neighbour-1", permanent: false });
		expect(await t.list()).toBe("No spot is open right now.");
	});

	it("warns when a file can't be read", async () => {
		const spots = Object.assign(new ParkingSpotStore({ logger: silentLogger }), { problem: "x" });
		const bookings = Object.assign(new ParkingBookingStore({ logger: silentLogger }), {
			problem: "y",
		});
		const text = await setup({ spots, bookings }).list();
		expect(text).toContain("⚠️ Parking is off right now.");
		expect(text).toContain("⚠️ Pixel can't read who's parked");
	});
});

describe("/parking leave", () => {
	it("frees your spot", async () => {
		const t = withSpots();
		await t.run({ for: "1h" });
		expect(await t.leave()).toBe("Thanks, **ours** is free again.");
		expect(t.bookings.all()).toEqual([]);
		expect(await t.leave()).toBe("You're not parked anywhere.");
	});
});

describe("the daily reset", () => {
	it("ends every booking at the reset, at startup and on every tick", async () => {
		vi.useFakeTimers();
		const t = withSpots();
		await t.run({ for: "rest of day" });
		await t.run({ for: "1h" }, member(BOB, "Bob"));

		// Pixel was down over the reset: the first run at startup catches up.
		t.setNow(utc("22:00"));
		const stop = t.feature.start?.();
		expect(t.bookings.all()).toEqual([]);

		t.setNow(utc("08:00", 25));
		await t.run({ for: "1h" });
		vi.advanceTimersByTime(TICK_MS);
		expect(t.bookings.all()).toHaveLength(1);
		t.setNow(utc("22:59", 25));
		vi.advanceTimersByTime(TICK_MS);
		expect(t.bookings.all()).toEqual([]);
		stop?.();
	});

	it("leaves an unreadable bookings file alone, and never throws", () => {
		const bookings = Object.assign(new ParkingBookingStore({ logger: silentLogger }), {
			problem: "x",
			end: vi.fn(),
		});
		setup({ bookings }).feature.start?.()();
		expect(bookings.end).not.toHaveBeenCalled();

		const failing = Object.assign(new ParkingBookingStore({ logger: silentLogger }), {
			end: () => {
				throw new Error("disk full");
			},
		});
		const t = setup({ bookings: failing });
		t.feature.start?.()();
		expect(t.reporter.captureBackground).toHaveBeenCalledWith(expect.any(Error), "parking");
	});
});
