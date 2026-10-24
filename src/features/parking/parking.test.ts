import { afterEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "../../core/access.ts";
import { type Args, isGroup, type SuggestContext } from "../../core/command.ts";
import { silentLogger } from "../../core/logger.ts";
import type { Gate } from "../../core/ports/gate.ts";
import { type ParkingBooking, ParkingBookingStore } from "../../services/parking-bookings.ts";
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
	const notices = {
		send: vi.fn(async (_booking: ParkingBooking, _kind: string, _text: string) => {}),
	};
	let now = NOW;
	const feature = createParkingFeature({
		spots,
		windows,
		bookings,
		gate,
		notices,
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
		notices,
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
			["extend", access],
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
			"Park in **ours** (Next to the \\*gate\\*). It's yours until 12:00.\nThe gate is opening.\nI'll DM you 15 minutes before it ends (that needs DMs from server members on).\nRun `/parking leave` when you go.",
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
		await vi.advanceTimersByTimeAsync(TICK_MS);
		expect(t.bookings.all()).toHaveLength(1);
		t.setNow(utc("22:59", 25));
		await vi.advanceTimersByTimeAsync(TICK_MS);
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

describe("/parking extend", () => {
	const extend = async (t: ReturnType<typeof setup>, args: Args, who: Principal = member()) => {
		const parking = t.parking;
		if (!isGroup(parking)) throw new Error("group");
		const sub = parking.subcommands.find((s) => s.name === "extend");
		if (!sub || !("handler" in sub)) throw new Error("no extend");
		return (await sub.handler(context({ principal: who, args }))).text ?? "";
	};

	it("adds to your end, up to the spot's close, and resets the reminder", async () => {
		const t = withSpots();
		await t.run({ for: "30m" }, member(BOB, "Bob"));
		await t.run({ for: "1h" });
		expect(t.bookings.byPerson(`discord:${IDS.member}`)?.spot).toBe("neighbour-1");
		t.bookings.update(t.bookings.byPerson(`discord:${IDS.member}`)?.id ?? "", {
			remindedAt: utc("08:45"),
		});
		expect(await extend(t, { for: "1h" })).toBe(
			"**neighbour-1** is yours until 12:00 now.\nI'll DM you 15 minutes before it ends.",
		);
		expect(t.bookings.byPerson(`discord:${IDS.member}`)).toMatchObject({
			until: utc("10:00"),
			remindedAt: null,
		});
		await expect(extend(t, { for: "3h" })).rejects.toThrow(
			"**neighbour-1** can only be extended by 2h: it closes at 14:00. Try `/parking extend for:2h`.",
		);
		await extend(t, { for: "2h" });
		await expect(extend(t, { for: "1m" })).rejects.toThrow(
			"**neighbour-1** can't be extended: it closes at 14:00.",
		);
	});

	it("says by how much it can be extended", async () => {
		const t = withSpots();
		await t.run({ for: "30m" }, member(BOB, "Bob"));
		await t.run({ for: "5h" });
		await expect(extend(t, { for: "3h" })).rejects.toThrow(
			"**neighbour-2** can only be extended by 2h: it closes at 17:00. Try `/parking extend for:2h`.",
		);
		await expect(extend(t, { for: "rest of day" })).rejects.toThrow(/only be extended by 2h/);
	});

	it("stays until the reset with rest of day, where the spot allows", async () => {
		const t = withSpots();
		await t.run({ for: "1h" });
		await extend(t, { for: "rest of day" });
		expect(t.bookings.byPerson(`discord:${IDS.member}`)?.until).toEqual(RESET);
		await expect(extend(t, { for: "30m" })).rejects.toThrow(
			"**ours** can't be extended: parking ends at 23:59 every day.",
		);
	});

	it("counts from now once the end has passed, without a reminder that's already due", async () => {
		const t = withSpots();
		await t.run({ for: "1h" });
		t.setNow(utc("09:03"));
		expect(await extend(t, { for: "10m" })).toBe("**ours** is yours until 11:13 now.");
		expect(t.bookings.byPerson(`discord:${IDS.member}`)?.remindedAt).toEqual(utc("09:03"));
	});

	it("needs a booking, and a duration it can read", async () => {
		const t = withSpots();
		expect(await extend(t, { for: "1h" })).toBe(
			"You're not parked anywhere. `/park` gets you a spot.",
		);
		await t.run({ for: "1h" });
		await expect(extend(t, { for: "ages" })).rejects.toThrow(/couldn't understand/);
	});

	it("says so when the booking ended meanwhile", async () => {
		const t = withSpots();
		await t.run({ for: "1h" });
		Object.assign(t.bookings, { update: () => undefined });
		expect(await extend(t, { for: "30m" })).toBe("You're not parked anywhere any more.");
	});
});

describe("reminders and ending bookings", () => {
	const start = async (t: ReturnType<typeof setup>) => {
		const stop = t.feature.start?.();
		await vi.advanceTimersByTimeAsync(0);
		return stop;
	};
	const tick = () => vi.advanceTimersByTimeAsync(TICK_MS);
	const sent = (t: ReturnType<typeof setup>) =>
		t.notices.send.mock.calls.map(([booking, kind, text]) => [booking.spot, kind, text]);

	it("reminds once before the end, offering an extension, then ends it after the grace period", async () => {
		vi.useFakeTimers();
		const t = withSpots();
		await t.run({ for: "1h" });
		const stop = await start(t);
		expect(sent(t)).toEqual([]);

		t.setNow(utc("08:45"));
		await tick();
		expect(sent(t)).toEqual([
			[
				"ours",
				"reminder",
				"Your parking in **ours** ends at 11:00.\nThe spot is open until 23:59, so you can stay longer: `/parking extend for:1h` (up to 12h59).\nIf you haven't left or extended by 11:05, I'll end it. Leaving? `/parking leave`.",
			],
		]);
		expect(t.bookings.all()[0]?.remindedAt).toEqual(utc("08:45"));
		await tick();
		expect(sent(t)).toHaveLength(1);

		t.setNow(utc("09:04"));
		await tick();
		expect(t.bookings.all()).toHaveLength(1);
		t.setNow(utc("09:05"));
		await tick();
		expect(t.bookings.all()).toEqual([]);
		expect(sent(t)[1]).toEqual([
			"ours",
			"over",
			"I've ended your parking in **ours**: your time was up at 11:00.",
		]);
		stop?.();
	});

	it("says when the spot can't be extended", async () => {
		vi.useFakeTimers();
		const t = withSpots();
		t.spots.setSettings({ graceMinutes: 0 });
		await t.run({ for: "rest of day" }, member(BOB, "Bob"));
		// Our spot is taken, so this gets neighbour-1, which closes right then.
		await t.run({ for: "4h" });
		t.setNow(utc("11:45"));
		const stop = await start(t);
		expect(sent(t)).toEqual([
			[
				"neighbour-1",
				"reminder",
				"Your parking in **neighbour-1** ends at 14:00.\nThe spot closes then, so it can't be extended.\nIf you haven't left or extended by then, I'll end it. Leaving? `/parking leave`.",
			],
		]);
		t.setNow(utc("21:44"));
		await tick();
		expect(
			sent(t)
				.filter(([, kind]) => kind === "reminder")
				.at(-1),
		).toEqual([
			"ours",
			"reminder",
			"Your parking in **ours** ends at 23:59.\nParking ends at 23:59 every day, so it can't be extended.\nIf you haven't left or extended by then, I'll end it. Leaving? `/parking leave`.",
		]);
		stop?.();
	});

	it("skips the reminder when the stay was too short for one", async () => {
		vi.useFakeTimers();
		const t = withSpots();
		await t.run({ for: "10m" });
		t.setNow(utc("08:09"));
		const stop = await start(t);
		expect(sent(t)).toEqual([]);
		stop?.();
	});

	it("tells people when the reset ends their booking", async () => {
		vi.useFakeTimers();
		const t = withSpots();
		await t.run({ for: "rest of day" });
		t.setNow(utc("22:00"));
		const stop = await start(t);
		expect(sent(t)).toEqual([
			["ours", "reset", "I've ended your parking in **ours**: parking ends at 23:59 every day."],
		]);
		stop?.();
	});

	it("never runs two ticks at once", async () => {
		vi.useFakeTimers();
		let release = () => {};
		const t = withSpots();
		t.notices.send.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		await t.run({ for: "1h" });
		await t.run({ for: "1h" }, member(BOB, "Bob"));
		t.setNow(utc("08:45"));
		const stop = await start(t);
		await tick();
		expect(t.notices.send).toHaveBeenCalledTimes(1);
		release();
		await vi.advanceTimersByTimeAsync(0);
		release();
		await tick();
		expect(t.notices.send).toHaveBeenCalledTimes(2);
		stop?.();
	});
});
