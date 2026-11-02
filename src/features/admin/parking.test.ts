import { describe, expect, it, vi } from "vitest";
import type { Args, SuggestContext } from "../../core/command.ts";
import { UserFacingError } from "../../core/errors.ts";
import { silentLogger } from "../../core/logger.ts";
import { ParkingBookingStore } from "../../services/parking-bookings.ts";
import { ParkingSpotStore } from "../../services/parking-spots.ts";
import { type ParkingEntry, ParkingWindowStore } from "../../services/parking-windows.ts";
import { context, IDS, principal } from "../../testing/fixtures.ts";
import {
	createParkingSubgroup,
	describeSpot,
	resolveSpots,
	suggestSpot,
	suggestSpots,
} from "./parking.ts";

const ZONE = "Europe/Amsterdam";
/** Saturday 24 Oct 2026, 10:00 in Amsterdam (UTC+2). The reset is 23:59, 21:59 UTC. */
const NOW = new Date("2026-10-24T08:00:00Z");
const utc = (time: string, day = 24) =>
	new Date(`2026-10-${String(day).padStart(2, "0")}T${time}:00Z`);
const RESET = utc("21:59");

function setup(
	options: {
		spots?: ParkingSpotStore;
		windows?: ParkingWindowStore;
		bookings?: ParkingBookingStore;
	} = {},
) {
	const spots = options.spots ?? new ParkingSpotStore({ logger: silentLogger });
	const windows = options.windows ?? new ParkingWindowStore({ logger: silentLogger });
	const bookings = options.bookings ?? new ParkingBookingStore({ logger: silentLogger });
	const notices = { send: vi.fn(async () => {}) };
	const activity = { record: vi.fn(async () => true) };
	let now = NOW;
	const group = createParkingSubgroup({
		spots,
		windows,
		bookings,
		notices,
		activity,
		timezone: ZONE,
		now: () => now,
	});
	const sub = (name: string) => {
		const found = group.subcommands.find((s) => s.name === name);
		if (!found) throw new Error(`no ${name}`);
		return found;
	};
	const run = async (name: string, args: Args = {}) => {
		const reply = await sub(name).handler(
			context({ principal: principal("admin", { userId: IDS.admin }), args }),
		);
		expect(reply.private).toBe(true);
		return reply.text ?? "";
	};
	const fails = (name: string, args: Args = {}) => expect(run(name, args)).rejects;
	return {
		spots,
		windows,
		bookings,
		notices,
		activity,
		group,
		sub,
		run,
		fails,
		setNow: (next: Date) => {
			now = next;
		},
		entries: () => windows.entries(now),
	};
}

function withSpots() {
	const t = setup();
	t.spots.add({ name: "ours", permanent: true, description: "Next to the *gate*" });
	t.spots.add({ name: "neighbour-1", permanent: false });
	t.spots.add({ name: "neighbour-2", permanent: false });
	return t;
}

const span = (e: ParkingEntry) => [e.spot, e.from.toISOString(), e.until.toISOString()];

describe("/admin parking", () => {
	it("is admin-only all the way down, and every reply is private", () => {
		const { group } = setup();
		expect(group.name).toBe("parking");
		expect(group.access.minTier).toBe("admin");
		expect(group.subcommands.map((s) => [s.name, s.access.minTier, s.private])).toEqual([
			["status", "admin", true],
			["open", "admin", true],
			["close", "admin", true],
			["assign", "admin", true],
			["free", "admin", true],
			["add-spot", "admin", true],
			["edit-spot", "admin", true],
			["remove-spot", "admin", true],
			["settings", "admin", true],
		]);
	});

	it("suggests spot names from the file", async () => {
		const { sub } = withSpots();
		const suggest = (name: string, option: string, typed: string) => {
			const found = sub(name).options?.find((o) => o.name === option);
			if (!found || !("suggest" in found) || !found.suggest) throw new Error("no suggest");
			return found.suggest({ typed } as SuggestContext);
		};
		expect(await suggest("open", "spots", "ours neigh")).toEqual([
			{ name: "ours neighbour-1", value: "ours neighbour-1" },
			{ name: "ours neighbour-2", value: "ours neighbour-2" },
		]);
		expect(await suggest("edit-spot", "spot", "OURS")).toEqual([{ name: "ours", value: "ours" }]);
	});

	describe("status", () => {
		it("says there are no spots yet", async () => {
			const { run } = setup();
			const text = await run("status");
			expect(text).toContain("no parking spots yet");
			expect(text).toContain("Reset: 23:59 every day");
		});

		it("shows each spot, whether it's open, and the settings", async () => {
			const { run } = withSpots();
			await run("open", { spots: "neighbour-1", until: "17:00" });
			await run("open", { spots: "neighbour-2", from: "tomorrow 8", until: "12:00" });
			const text = await run("status");
			expect(text).toContain("**ours** (permanent): Next to the \\*gate\\*\n  open until 23:59");
			expect(text).toContain("**neighbour-1** (borrowed)\n  open until 17:00");
			expect(text).toContain(
				"**neighbour-2** (borrowed)\n  closed · open Sun 25 Oct 2026, 08:00 to Sun 25 Oct 2026, 12:00",
			);
			expect(text).toContain("Reminder: 15m before someone's end");
			expect(text).toContain("Durations offered: 30m, 1h, 2h, 4h, rest of day");
		});

		it("warns when a file couldn't be read", async () => {
			const { run } = setup({
				spots: Object.assign(new ParkingSpotStore({ logger: silentLogger }), {
					problem: "spots broken",
				}),
				windows: Object.defineProperty(
					new ParkingWindowStore({ logger: silentLogger }),
					"problem",
					{ value: "windows broken" },
				),
			});
			const text = await run("status");
			expect(text).toContain("Parking is off: the spots file is invalid (spots broken)");
			expect(text).toContain("borrowed spots are closed");
			expect(text).toContain("(windows broken)");
		});
	});

	describe("add-spot", () => {
		it("adds a borrowed spot, closed until it's opened", async () => {
			const { run, spots } = setup();
			const text = await run("add-spot", { name: " neighbour-1 ", description: " By the bins " });
			expect(spots.get("neighbour-1")).toEqual({
				name: "neighbour-1",
				permanent: false,
				description: "By the bins",
			});
			expect(text).toContain("a borrowed spot. It's closed until you open it");
		});

		it("adds a permanent spot, open every day", async () => {
			const { run, spots } = setup();
			expect(await run("add-spot", { name: "ours", permanent: true })).toContain(
				"open every day until 23:59",
			);
			expect(spots.get("ours")?.permanent).toBe(true);
		});

		it("refuses a bad name", async () => {
			await setup()
				.fails("add-spot", { name: "Our Spot" })
				.toThrow(/lowercase/);
		});
	});

	describe("open", () => {
		it("opens a borrowed spot from now until the reset by default", async () => {
			const { run, entries } = withSpots();
			expect(await run("open", { spots: "neighbour-1" })).toBe(
				"**neighbour-1** open from now until 23:59.",
			);
			expect(entries().windows.map(span)).toEqual([
				["neighbour-1", NOW.toISOString(), RESET.toISOString()],
			]);
			expect(entries().windows[0]?.setBy).toEqual({
				ref: `discord:${IDS.admin}`,
				name: "Test User",
			});
		});

		it("opens several spots for a set time", async () => {
			const { run, entries } = withSpots();
			const text = await run("open", {
				spots: "neighbour-1, neighbour-2 neighbour-1",
				from: "12:00",
				until: "17:00",
			});
			expect(text).toBe("**neighbour-1**, **neighbour-2** open from 12:00 until 17:00.");
			expect(entries().windows.map(span)).toEqual([
				["neighbour-1", utc("10:00").toISOString(), utc("15:00").toISOString()],
				["neighbour-2", utc("10:00").toISOString(), utc("15:00").toISOString()],
			]);
		});

		it("reads `until` after `from`, so a window can be set for tomorrow", async () => {
			const { run, entries } = withSpots();
			await run("open", { spots: "neighbour-1", from: "tomorrow 8" });
			// Tomorrow the clocks have gone back: UTC+1.
			expect(entries().windows.map(span)).toEqual([
				["neighbour-1", utc("07:00", 25).toISOString(), utc("22:59", 25).toISOString()],
			]);
		});

		it("replaces the spot's window that day, and keeps other days'", async () => {
			const { run, entries } = withSpots();
			await run("open", { spots: "neighbour-1", until: "12:00" });
			await run("open", { spots: "neighbour-1", from: "tomorrow 8", until: "12:00" });
			await run("open", { spots: "neighbour-1", until: "18:00" });
			expect(entries().windows.map(span)).toEqual([
				["neighbour-1", utc("07:00", 25).toISOString(), utc("11:00", 25).toISOString()],
				["neighbour-1", NOW.toISOString(), utc("16:00").toISOString()],
			]);
		});

		it("reads now and now+<duration> from the real now", async () => {
			const { run, fails, entries } = withSpots();
			expect(await run("open", { spots: "neighbour-1", from: "now", until: "now+2h30" })).toBe(
				"**neighbour-1** open from 10:01 until 12:30.",
			);
			expect(entries().windows.map(span)).toEqual([
				["neighbour-1", utc("08:01").toISOString(), utc("10:30").toISOString()],
			]);
			// From tomorrow, "now+2h" is still two hours from now: before it opens.
			await fails("open", { spots: "neighbour-2", from: "tomorrow 8", until: "now+2h" }).toThrow(
				/couldn't understand `until`, or it's in the past/,
			);
		});

		it("never runs past the reset", async () => {
			const { fails, entries } = withSpots();
			await fails("open", { spots: "neighbour-1", until: "tomorrow 9" }).toThrow(
				/can't run past the reset \(23:59\)/,
			);
			expect(entries().windows).toEqual([]);
		});

		it("refuses a time it can't understand, or that's gone", async () => {
			const { fails } = withSpots();
			await fails("open", { spots: "neighbour-1", until: "later" }).toThrow(
				/couldn't understand `until`/,
			);
			await fails("open", { spots: "neighbour-1", from: "2026-10-23T08:00" }).toThrow(
				/couldn't understand `from`/,
			);
		});

		it("lifts a permanent spot's closure, and refuses times for it", async () => {
			const { run, fails, entries } = withSpots();
			expect(await run("open", { spots: "ours" })).toBe("**ours** wasn't closed.");
			await run("close", { spots: "ours" });
			expect(entries().blocks).toHaveLength(1);
			expect(await run("open", { spots: "ours neighbour-1" })).toBe(
				"**neighbour-1** open from now until 23:59.\n**ours** open again.",
			);
			expect(entries().blocks).toEqual([]);
			await fails("open", { spots: "ours", until: "17:00" }).toThrow(
				/only apply to borrowed spots\. \*\*ours\*\* is permanent/,
			);
		});

		it("refuses spots that don't exist, without changing anything", async () => {
			const { fails, entries } = withSpots();
			await fails("open", { spots: "neighbour-1 nope `x`" }).toThrow(
				"There's no spot called `nope`, `'x'`.",
			);
			await fails("open", { spots: " , " }).toThrow(/Name at least one spot/);
			expect(entries().windows).toEqual([]);
		});
	});

	describe("close", () => {
		it("ends a borrowed spot's window for today, and keeps tomorrow's", async () => {
			const { run, entries } = withSpots();
			await run("open", { spots: "neighbour-1" });
			await run("open", { spots: "neighbour-1", from: "tomorrow 8" });
			expect(await run("close", { spots: "neighbour-1 neighbour-2" })).toBe(
				"**neighbour-1** closed for today.\n**neighbour-2** wasn't open today.",
			);
			expect(entries().windows.map((w) => w.from)).toEqual([utc("07:00", 25)]);
		});

		it("closes a permanent spot until the reset by default, or until a time", async () => {
			const { run, entries } = withSpots();
			expect(await run("close", { spots: "ours" })).toBe("**ours** closed until 23:59.");
			expect(entries().blocks.map(span)).toEqual([
				["ours", NOW.toISOString(), RESET.toISOString()],
			]);
			expect(await run("close", { spots: "ours", until: "17:00" })).toBe(
				"**ours** closed until 17:00.",
			);
			expect(entries().blocks.map(span)).toEqual([
				["ours", NOW.toISOString(), utc("15:00").toISOString()],
			]);
		});

		it("refuses `until` for borrowed spots, and past the reset", async () => {
			const { fails } = withSpots();
			await fails("close", { spots: "neighbour-1", until: "17:00" }).toThrow(
				/only applies to permanent spots/,
			);
			await fails("close", { spots: "ours", until: "tomorrow 9" }).toThrow(
				/can't run past the reset/,
			);
		});
	});

	describe("edit-spot", () => {
		it("changes and removes the description", async () => {
			const { run, spots } = withSpots();
			expect(await run("edit-spot", { spot: "neighbour-1", description: "By the bins" })).toBe(
				"Changed **neighbour-1**.",
			);
			expect(spots.get("neighbour-1")?.description).toBe("By the bins");
			await run("edit-spot", { spot: "neighbour-1", description: " - " });
			expect(spots.get("neighbour-1")).toEqual({ name: "neighbour-1", permanent: false });
		});

		it("drops opening times that no longer apply when the kind changes", async () => {
			const { run, entries } = withSpots();
			await run("open", { spots: "neighbour-1" });
			const text = await run("edit-spot", { spot: "neighbour-1", permanent: true });
			expect(text).toContain("It's now permanent");
			expect(text).toContain("Its 1 earlier opening time(s) no longer apply.");
			expect(entries().windows).toEqual([]);
			expect(await run("edit-spot", { spot: "ours", permanent: false })).toContain(
				"It's now borrowed",
			);
		});

		it("needs something to change, and a spot that exists", async () => {
			const { fails } = withSpots();
			await fails("edit-spot", { spot: "ours" }).toThrow(/Give a new `description`/);
			await fails("edit-spot", { spot: "nope", permanent: true }).toThrow(/no spot called/);
		});

		it("says so when the spot went away meanwhile", async () => {
			const t = withSpots();
			Object.assign(t.spots, { update: () => undefined, remove: () => undefined });
			await t.fails("edit-spot", { spot: "ours", permanent: false }).toThrow(/no longer exists/);
			await t.fails("remove-spot", { spot: "ours" }).toThrow(/no longer exists/);
		});
	});

	it("removes a spot and its opening times", async () => {
		const { run, spots, entries } = withSpots();
		await run("open", { spots: "neighbour-1" });
		expect(await run("remove-spot", { spot: "neighbour-1" })).toBe("Removed **neighbour-1**.");
		expect(spots.get("neighbour-1")).toBeUndefined();
		expect(entries().windows).toEqual([]);
	});

	describe("settings", () => {
		it("shows them when nothing is given", async () => {
			expect(await setup().run("settings")).toContain("Ended automatically: 5m after it");
		});

		it("changes them", async () => {
			const { run, spots } = setup();
			const text = await run("settings", {
				remind: 10,
				grace: 0,
				reset: "22:30",
				durations: "1h, 90m, , 2h30, Rest of day",
			});
			expect(text).toContain("Saved.");
			expect(spots.settings()).toEqual({
				remindMinutes: 10,
				graceMinutes: 0,
				resetAt: "22:30",
				durations: ["1h", "1h30", "2h30", "rest of day"],
			});
		});

		it("reads the reset the way /schedule reads a time, and saves it as HH:MM", async () => {
			const { run, spots } = setup();
			await run("settings", { reset: "10:30pm" });
			expect(spots.settings().resetAt).toBe("22:30");
		});

		it("clips opening times and closures to an earlier reset", async () => {
			const t = withSpots();
			await t.run("open", { spots: "neighbour-1" });
			await t.run("open", { spots: "neighbour-2", from: "22:30" });
			await t.run("close", { spots: "ours", until: "17:00" });
			expect(await t.run("settings", { reset: "22:00" })).toContain(
				"1 opening time(s) now end at the new reset.",
			);
			// neighbour-1 now ends at 22:00 (20:00 UTC). neighbour-2 opens at 22:30, after the new
			// reset, so it belongs to the next day and still fits.
			expect(t.entries().windows.map(span)).toEqual([
				["neighbour-1", NOW.toISOString(), utc("20:00").toISOString()],
				["neighbour-2", utc("20:30").toISOString(), RESET.toISOString()],
			]);
			expect(t.entries().blocks.map(span)).toEqual([
				["ours", NOW.toISOString(), utc("15:00").toISOString()],
			]);
			// A later reset changes nothing already set.
			expect(await t.run("settings", { reset: "23:59" })).not.toContain("opening time");
		});

		it("clips bookings to an earlier reset, re-arming their reminder", async () => {
			const t = withSpots();
			const alice = { ref: "discord:100000000000000002", name: "Alice" };
			t.bookings.claim(alice, NOW, () => ({ spot: "ours", until: RESET }));
			t.bookings.claim({ ref: "discord:3", name: "B" }, NOW, () => ({
				spot: "neighbour-1",
				until: utc("10:00"),
			}));
			expect(await t.run("settings", { reset: "22:00" })).toContain(
				"1 booking(s) now end at the new reset.",
			);
			expect(t.bookings.all().map((b) => [b.spot, b.until, b.remindedAt])).toEqual([
				["ours", utc("20:00"), null],
				["neighbour-1", utc("10:00"), null],
			]);
		});

		it("still saves the reset when the bookings can't be shortened", async () => {
			const t = withSpots();
			t.bookings.claim({ ref: "discord:2", name: "A" }, NOW, () => ({
				spot: "ours",
				until: RESET,
			}));
			Object.assign(t.bookings, {
				update: () => {
					throw new Error("disk full");
				},
			});
			expect(await t.run("settings", { reset: "22:00" })).toContain(
				"couldn't shorten the bookings",
			);
		});

		it("still saves the reset when the opening times can't be shortened", async () => {
			const t = withSpots();
			await t.run("open", { spots: "neighbour-1" });
			Object.assign(t.windows, {
				replace: () => {
					throw new Error("disk full");
				},
			});
			expect(await t.run("settings", { reset: "22:00" })).toContain("couldn't shorten");
			expect(t.spots.settings().resetAt).toBe("22:00");
		});

		it("refuses values it can't use", async () => {
			const { fails } = setup();
			await fails("settings", { remind: 121 }).toThrow(/from 0 to 120/);
			await fails("settings", { grace: 1.5 }).toThrow(/from 0 to 60/);
			await fails("settings", { reset: "midnight" }).toThrow(/like `23:59`/);
			await fails("settings", { durations: "1h, soon" }).toThrow(/couldn't understand/);
			await fails("settings", { durations: " , " }).toThrow(/couldn't understand/);
			const many = Array.from({ length: 26 }, (_, i) => `${i + 1}m`).join(", ");
			await fails("settings", { durations: many }).toThrow(/at most 25/);
		});
	});

	it("refuses every change while the spots file is invalid", async () => {
		const spots = Object.assign(new ParkingSpotStore({ logger: silentLogger }), {
			problem: "broken",
		});
		const { fails } = setup({ spots });
		for (const [name, args] of [
			["add-spot", { name: "a" }],
			["edit-spot", { spot: "a", permanent: true }],
			["remove-spot", { spot: "a" }],
			["open", { spots: "a" }],
			["close", { spots: "a" }],
			["settings", { remind: 1 }],
		] as const) {
			await fails(name, args).toThrow(UserFacingError);
			await fails(name, args).toThrow(/parking is off/);
		}
	});
});

describe("/admin parking and bookings", () => {
	const alice = { ref: "discord:100000000000000002", name: "Alice *A*" };
	const book = (t: ReturnType<typeof setup>, spot: string, until: Date) =>
		t.bookings.claim(alice, NOW, () => ({ spot, until }));

	it("shows who's parked in status", async () => {
		const t = withSpots();
		book(t, "ours", utc("10:00"));
		expect(await t.run("status")).toContain(
			"**ours** (permanent): Next to the \\*gate\\*\n  open until 23:59 · taken by Alice \\*A\\* until about 12:00",
		);
	});

	it("warns in status when the bookings file can't be read", async () => {
		const bookings = Object.assign(new ParkingBookingStore({ logger: silentLogger }), {
			problem: "bad",
		});
		expect(await setup({ bookings }).run("status")).toContain(
			"No one can park: the bookings file is invalid (bad)",
		);
	});

	it("frees a spot", async () => {
		const t = withSpots();
		book(t, "ours", utc("10:00"));
		expect(await t.run("free", { spot: "ours" })).toBe(
			"Ended Alice \\*A\\*'s booking: **ours** is free again.",
		);
		expect(t.bookings.all()).toEqual([]);
		expect(t.notices.send).toHaveBeenCalledWith(
			expect.objectContaining({ spot: "ours", by: alice }),
			"admin",
			"An admin ended your parking in **ours**.",
		);
		expect(await t.run("free", { spot: "ours" })).toBe("Nobody is parked in **ours**.");
	});

	it("refuses to cut into a booking unless told to evict", async () => {
		const t = withSpots();
		await t.run("open", { spots: "neighbour-1" });
		book(t, "neighbour-1", utc("14:00"));
		await t
			.fails("open", { spots: "neighbour-1", until: "15:00" })
			.toThrow(
				"Someone is parked in **neighbour-1** until about 16:00. Add `evict:True` to end their booking.",
			);
		await t.fails("close", { spots: "neighbour-1" }).toThrow(/Someone is parked/);
		await t.fails("remove-spot", { spot: "neighbour-1" }).toThrow(/Someone is parked/);
		expect(t.bookings.all()).toHaveLength(1);
		expect(t.entries().windows).toHaveLength(1);

		// A longer opening, or a description, doesn't cut into anything.
		await t.run("open", { spots: "neighbour-1", until: "19:00" });
		await t.run("edit-spot", { spot: "neighbour-1", description: "Here" });
		expect(t.bookings.all()).toHaveLength(1);

		expect(await t.run("close", { spots: "neighbour-1", evict: true })).toBe(
			"**neighbour-1** closed for today.\nEnded Alice \\*A\\*'s booking in **neighbour-1**.",
		);
		expect(t.bookings.all()).toEqual([]);
	});

	it("ends the bookings it cuts into for every change, with evict", async () => {
		for (const [name, args, spot] of [
			["open", { spots: "neighbour-1", until: "11:00", evict: true }, "neighbour-1"],
			["close", { spots: "ours", evict: true }, "ours"],
			["remove-spot", { spot: "ours", evict: true }, "ours"],
			["edit-spot", { spot: "ours", permanent: false, evict: true }, "ours"],
		] as const) {
			const t = withSpots();
			await t.run("open", { spots: "neighbour-1" });
			book(t, spot, utc("12:00"));
			expect(await t.run(name, args)).toContain(`Ended Alice \\*A\\*'s booking in **${spot}**.`);
			expect(t.bookings.all()).toEqual([]);
			expect(t.notices.send).toHaveBeenCalledWith(
				expect.objectContaining({ spot }),
				"admin",
				`An admin ended your parking in **${spot}**.`,
			);
		}
	});

	it("names every booking it would cut into", async () => {
		const t = withSpots();
		book(t, "ours", utc("12:00"));
		t.bookings.claim({ ref: "discord:2", name: "B" }, NOW, () => ({
			spot: "neighbour-1",
			until: utc("12:00"),
		}));
		await t
			.fails("remove-spot", { spot: "ours" })
			.toThrow(
				"Someone is parked in **ours** until about 14:00. Add `evict:True` to end their booking.",
			);
		await t.run("open", { spots: "neighbour-1" });
		await t
			.fails("close", { spots: "ours neighbour-1" })
			.toThrow(
				/\*\*ours\*\* until about 14:00, \*\*neighbour-1\*\* until about 14:00\. .*end those bookings/,
			);
	});
});

describe("/admin parking activity", () => {
	const events = (t: ReturnType<typeof setup>) =>
		(t.activity.record.mock.calls as unknown as [Record<string, unknown>][]).map(([e]) => e);

	it("posts every admin change for the other admins", async () => {
		const t = setup();
		await t.run("add-spot", { name: "ours", permanent: true });
		await t.run("add-spot", { name: "neighbour-1" });
		await t.run("edit-spot", { spot: "neighbour-1", description: "Here" });
		await t.run("edit-spot", { spot: "ours", permanent: false });
		await t.run("open", { spots: "neighbour-1", until: "17:00" });
		await t.run("close", { spots: "neighbour-1" });
		await t.run("remove-spot", { spot: "ours" });
		await t.run("settings", { remind: 10 });
		expect(events(t).map((e) => [e.action, e.admin, e.text])).toEqual([
			["spot-added", "Test User", "added the spot **ours** (permanent)."],
			["spot-added", "Test User", "added the spot **neighbour-1** (borrowed)."],
			["spot-edited", "Test User", "changed the spot **neighbour-1**."],
			["spot-edited", "Test User", "changed the spot **ours** (now borrowed)."],
			["opened", "Test User", "opened parking: **neighbour-1** open from now until 17:00."],
			["closed", "Test User", "closed parking: **neighbour-1** closed for today."],
			["spot-removed", "Test User", "removed the spot **ours**."],
			[
				"settings",
				"Test User",
				"changed the parking settings: reminder 10m before, ended 5m after, reset 23:59, durations 30m, 1h, 2h, 4h, rest of day.",
			],
		]);
	});

	it("posts bookings an admin ends", async () => {
		const t = withSpots();
		const alice = { ref: "discord:100000000000000002", name: "Alice" };
		t.bookings.claim(alice, NOW, () => ({ spot: "ours", until: utc("10:00") }));
		await t.run("free", { spot: "ours" });
		t.bookings.claim(alice, NOW, () => ({ spot: "ours", until: utc("10:00") }));
		await t.run("close", { spots: "ours", evict: true });
		expect(events(t).filter((e) => e.kind !== "admin")).toEqual([
			{ kind: "freed", spot: "ours", who: "Alice", admin: "Test User" },
			{ kind: "evicted", spot: "ours", who: "Alice", admin: "Test User" },
		]);
	});

	it("shows a borrowed spot reported taken, and open lifts it", async () => {
		const t = withSpots();
		await t.run("open", { spots: "neighbour-1" });
		const current = t.entries();
		t.windows.replace(
			{
				windows: current.windows,
				blocks: [
					{
						spot: "neighbour-1",
						from: NOW,
						until: RESET,
						setBy: { ref: "discord:2", name: "Alice" },
						reason: "taken",
					},
				],
			},
			NOW,
		);
		expect(await t.run("status")).toContain(
			"**neighbour-1** (borrowed)\n  closed until 23:59 (reported taken)",
		);
		expect(await t.run("open", { spots: "neighbour-1" })).toBe(
			"**neighbour-1** open from now until 23:59.\n**neighbour-1** is no longer closed.",
		);
		expect(t.entries().blocks).toEqual([]);
	});

	it("shows our spot reported taken", async () => {
		const t = withSpots();
		t.windows.replace(
			{
				windows: [],
				blocks: [
					{
						spot: "ours",
						from: NOW,
						until: RESET,
						setBy: { ref: "x", name: "y" },
						reason: "taken",
					},
				],
			},
			NOW,
		);
		expect(await t.run("status")).toContain("closed until 23:59 (reported taken)");
	});
});

describe("/admin parking assign", () => {
	const BOB = { id: "100000000000000005", displayName: "Bob", isBot: false };
	const alice = { ref: "discord:100000000000000002", name: "Alice" };
	const bobRef = `discord:${BOB.id}`;
	const assign = async (t: ReturnType<typeof setup>, args: Args, user = BOB) => {
		const reply = await t.sub("assign").handler(
			context({
				principal: principal("admin", { userId: IDS.admin }),
				args: { user: user.id, ...args },
				users: { user },
			}),
		);
		expect(reply.private).toBe(true);
		return reply.text ?? "";
	};
	const takenClosure = (t: ReturnType<typeof setup>, spot: string) =>
		t.windows.replace(
			{
				windows: t.entries().windows,
				blocks: [{ spot, from: NOW, until: RESET, setBy: alice, reason: "taken" }],
			},
			NOW,
		);
	const sentKinds = (t: ReturnType<typeof setup>) =>
		(t.notices.send.mock.calls as unknown as [{ spot: string }, string, string][]).map(
			([b, kind, text]) => [b.spot, kind, text],
		);
	const recorded = (t: ReturnType<typeof setup>) =>
		(t.activity.record.mock.calls as unknown as [Record<string, unknown>][]).map(([e]) => e);

	it("gives the person found in a spot reported taken that spot, and lifts the closure", async () => {
		const t = withSpots();
		await t.run("open", { spots: "neighbour-1" });
		// Alice reported ours taken and was moved to neighbour-1.
		t.bookings.claim(alice, NOW, () => ({ spot: "neighbour-1", until: utc("10:00") }));
		takenClosure(t, "ours");
		expect(await assign(t, { spot: "ours" })).toBe(
			"Gave **ours** to Bob, until 23:59.\n**ours** is no longer closed as taken.",
		);
		expect(t.bookings.all().find((b) => b.by.ref === bobRef)).toMatchObject({
			spot: "ours",
			since: NOW,
			until: RESET,
			remindedAt: null,
		});
		expect(t.bookings.all().find((b) => b.by.ref === alice.ref)?.spot).toBe("neighbour-1");
		expect(t.entries().blocks).toEqual([]);
		expect(sentKinds(t)).toEqual([
			[
				"ours",
				"assigned",
				"An admin gave you **ours**, until 23:59. Run `/parking leave` when you go.",
			],
		]);
		expect(recorded(t).at(-1)).toEqual({
			kind: "assigned",
			spot: "ours",
			who: "Bob",
			admin: "Test User",
			until: RESET,
		});
	});

	it("never moves whoever still holds the spot: they use /parking taken, or an admin evicts", async () => {
		const t = withSpots();
		await t.run("open", { spots: "neighbour-1" });
		t.bookings.claim(alice, NOW, () => ({ spot: "ours", until: utc("10:00") }));
		await expect(assign(t, { spot: "ours" })).rejects.toThrow(
			"Alice is still booked into **ours**, until about 12:00. They get a new spot with `/parking taken`; or add `evict:True` to end their booking.",
		);
		expect(t.bookings.all().map((b) => [b.by.name, b.spot])).toEqual([["Alice", "ours"]]);

		expect(await assign(t, { spot: "ours", evict: true })).toBe(
			"Gave **ours** to Bob, until 23:59.\nEnded Alice's booking.",
		);
		expect(t.bookings.all().map((b) => [b.by.name, b.spot])).toEqual([["Bob", "ours"]]);
		expect(sentKinds(t)).toContainEqual([
			"ours",
			"admin",
			"An admin ended your parking in **ours**.",
		]);
		expect(recorded(t)).toContainEqual({
			kind: "evicted",
			spot: "ours",
			who: "Alice",
			admin: "Test User",
		});
	});

	it("ends the person's own booking elsewhere", async () => {
		const t = withSpots();
		await t.run("open", { spots: "neighbour-1" });
		t.bookings.claim({ ref: bobRef, name: "Bob" }, NOW, () => ({
			spot: "neighbour-1",
			until: utc("10:00"),
		}));
		expect(await assign(t, { spot: "ours", for: "1h" })).toBe(
			"Gave **ours** to Bob, until 11:00.\nTheir booking in **neighbour-1** has ended.",
		);
		expect(t.bookings.all().map((b) => [b.by.name, b.spot, b.until])).toEqual([
			["Bob", "ours", utc("09:00")],
		]);
	});

	it("updates the end when they already hold that spot", async () => {
		const t = withSpots();
		t.bookings.claim({ ref: bobRef, name: "Bob" }, NOW, () => ({
			spot: "ours",
			until: utc("09:00"),
		}));
		expect(await assign(t, { spot: "ours", for: "rest of day" })).toBe(
			"Gave **ours** to Bob, until 23:59.",
		);
		expect(t.bookings.all()).toHaveLength(1);
	});

	it("refuses a closed spot, a time past its close, and a duration it can't read", async () => {
		const t = withSpots();
		await expect(assign(t, { spot: "neighbour-1" })).rejects.toThrow(
			"**neighbour-1** is closed right now. Open it first with `/admin parking open`.",
		);
		await t.run("close", { spots: "ours", until: "17:00" });
		await expect(assign(t, { spot: "ours" })).rejects.toThrow(/is closed right now/);
		await t.run("open", { spots: "neighbour-1", until: "17:00" });
		await expect(assign(t, { spot: "neighbour-1", for: "rest of day" })).rejects.toThrow(
			"**neighbour-1** is only open until 17:00. Leave out `for` to give it until then.",
		);
		await expect(assign(t, { spot: "neighbour-1", for: "ages" })).rejects.toThrow(
			/couldn't understand how long/,
		);
		expect(t.bookings.all()).toEqual([]);
	});

	it("needs a person, and suggests the durations", async () => {
		const t = withSpots();
		await t.fails("assign", { spot: "ours" }).toThrow("Pick who is parked there.");
		const option = t.sub("assign").options?.find((o) => o.name === "for");
		if (!option || !("suggest" in option) || !option.suggest) throw new Error("no suggest");
		expect(await option.suggest({ typed: "rest" } as SuggestContext)).toEqual([
			{ name: "rest of day", value: "rest of day" },
		]);
	});

	it("puts the closure back, and changes no booking, when the booking can't be saved", async () => {
		const t = withSpots();
		await t.run("open", { spots: "neighbour-1" });
		t.bookings.claim({ ref: bobRef, name: "Bob" }, NOW, () => ({
			spot: "neighbour-1",
			until: utc("10:00"),
		}));
		takenClosure(t, "ours");
		const before = t.entries();
		Object.assign(t.bookings, {
			assign: () => {
				throw new UserFacingError("Couldn't save the parking bookings, so nothing was changed.");
			},
		});
		await expect(assign(t, { spot: "ours" })).rejects.toThrow(/Couldn't save/);
		expect(t.entries()).toEqual(before);
		expect(t.bookings.all().map((b) => [b.by.name, b.spot])).toEqual([["Bob", "neighbour-1"]]);
		expect(t.notices.send).not.toHaveBeenCalled();
		expect(recorded(t).map((e) => e.kind)).not.toContain("assigned");
	});

	it("still fails cleanly when the closure can't be put back either", async () => {
		const t = withSpots();
		takenClosure(t, "ours");
		const replace = t.windows.replace.bind(t.windows);
		let calls = 0;
		Object.assign(t.windows, {
			replace: (...args: Parameters<typeof replace>) => {
				calls++;
				if (calls > 1) throw new Error("disk full");
				replace(...args);
			},
		});
		Object.assign(t.bookings, {
			assign: () => {
				throw new Error("disk full");
			},
		});
		await expect(assign(t, { spot: "ours" })).rejects.toThrow("disk full");
	});

	it("refuses before changing anything when the bookings file is invalid", async () => {
		const bookings = Object.assign(new ParkingBookingStore({ logger: silentLogger }), {
			problem: "bad",
		});
		const t = setup({ bookings });
		t.spots.add({ name: "ours", permanent: true });
		takenClosure(t, "ours");
		const before = t.entries();
		await expect(assign(t, { spot: "ours" })).rejects.toThrow(/bookings file is invalid/);
		expect(t.entries()).toEqual(before);
	});

	it("is off while the spots file is invalid", async () => {
		const spots = Object.assign(new ParkingSpotStore({ logger: silentLogger }), { problem: "x" });
		await expect(assign(setup({ spots }), { spot: "ours" })).rejects.toThrow(/parking is off/);
	});
});

describe("helpers", () => {
	it("suggests at most 25 spots, and never ones already typed", () => {
		const names = Array.from({ length: 30 }, (_, i) => `spot-${i}`);
		expect(suggestSpot(names, "")).toHaveLength(25);
		expect(suggestSpots(["a", "b"], "a ")).toEqual([{ name: "a b", value: "a b" }]);
		expect(suggestSpots(["x".repeat(32)], `${"y".repeat(70)} x`)).toEqual([]);
	});

	it("resolves spots in the order given, without repeats", () => {
		const store = new ParkingSpotStore({ logger: silentLogger });
		store.add({ name: "a", permanent: false });
		store.add({ name: "b", permanent: true });
		expect(resolveSpots(store, "B a b").map((s) => s.name)).toEqual(["b", "a"]);
	});

	it("describes a permanent spot that's closed now, or later today", () => {
		const ours = { name: "ours", permanent: true };
		const block = (from: string, until: string): ParkingEntry => ({
			spot: "ours",
			from: utc(from),
			until: utc(until),
			setBy: { ref: "x", name: "y" },
		});
		expect(
			describeSpot(ours, { windows: [], blocks: [block("07:00", "10:00")] }, NOW, RESET, ZONE),
		).toBe("**ours** (permanent)\n  closed until 12:00");
		expect(
			describeSpot(ours, { windows: [], blocks: [block("12:00", "13:00")] }, NOW, RESET, ZONE),
		).toBe("**ours** (permanent)\n  open until 14:00 · closed 14:00 to 15:00");
	});
});
