import { describe, expect, it } from "vitest";
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
	let now = NOW;
	const group = createParkingSubgroup({ spots, windows, bookings, timezone: ZONE, now: () => now });
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
