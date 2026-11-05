import { afterEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "../../../src/core/access.ts";
import type { Args, SuggestContext } from "../../../src/core/command.ts";
import { silentLogger } from "../../../src/core/logger.ts";
import type { Gate } from "../../../src/core/ports/gate.ts";
import type { Reply } from "../../../src/core/reply.ts";
import { type ActionResult, type Control, type Form, UI_LIMITS } from "../../../src/core/ui.ts";
import {
	ACTIONS,
	createParkingFeature,
	fitLines,
	gateLine,
	PARKING_CAPABILITY,
	TICK_MS,
} from "../../../src/features/parking/index.ts";
import type { ParkingActivityEvent } from "../../../src/services/parking-activity.ts";
import {
	type ParkingBooking,
	ParkingBookingStore,
} from "../../../src/services/parking-bookings.ts";
import { ParkingSpotStore } from "../../../src/services/parking-spots.ts";
import { ParkingWindowStore } from "../../../src/services/parking-windows.ts";
import { IDS, principal } from "../../../src/testing/fixtures.ts";

const ZONE = "Europe/Amsterdam";
/** Saturday 24 Oct 2026, 10:00 in Amsterdam (UTC+2). The reset is 23:59, 21:59 UTC. */
const NOW = new Date("2026-10-24T08:00:00Z");
const utc = (time: string, day = 24) =>
	new Date(`2026-10-${String(day).padStart(2, "0")}T${time}:00Z`);
const RESET = utc("21:59");

const member = (userId: string = IDS.member, displayName = "Alice") =>
	principal("member", { userId, displayName }, ["parking"]);
const BOB = "100000000000000005";

/** Everything a panel says: the main text, then the spots. */
const said = (reply: Reply) =>
	[reply.text, ...(reply.embeds ?? []).map((e) => e.description)].filter(Boolean).join("\n");
/** The main part of a panel, without the spots. */
const main = (reply: Reply) => reply.embeds?.[0]?.description ?? "";
/** The list of spots on a panel. */
const spotsOf = (reply: Reply) =>
	(reply.embeds ?? [])
		.slice(1)
		.map((e) => e.description ?? "")
		.join("\n");
const controlsOf = (reply: Reply): Control[] => (reply.controls ?? []).flat();
const labels = (reply: Reply) =>
	controlsOf(reply).map((c) =>
		c.kind === "select"
			? `[${c.placeholder}]`
			: `${c.label}${c.kind === "button" && c.disabled ? " (off)" : ""}`,
	);

/** Fails if Discord would refuse the controls. */
function expectFits(reply: Reply) {
	const rows = reply.controls ?? [];
	expect(rows.length).toBeLessThanOrEqual(UI_LIMITS.rows);
	for (const row of rows) {
		expect(row.length).toBeLessThanOrEqual(UI_LIMITS.buttonsPerRow);
		if (row.some((c) => c.kind === "select")) expect(row).toHaveLength(1);
	}
}

function setup(
	options: { gate?: Gate; spots?: ParkingSpotStore; bookings?: ParkingBookingStore } = {},
) {
	const spots = options.spots ?? new ParkingSpotStore({ logger: silentLogger });
	const windows = new ParkingWindowStore({ logger: silentLogger });
	const bookings = options.bookings ?? new ParkingBookingStore({ logger: silentLogger });
	const gate = options.gate ?? { open: vi.fn(async () => ({ opened: true as const })) };
	const reporter = { captureBackground: vi.fn() };
	const activity = {
		record: vi.fn(async (_event: ParkingActivityEvent, _now: Date) => true),
		posting: true,
	};
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
		activity,
		timezone: ZONE,
		logger: silentLogger,
		reporter,
		now: () => now,
	});
	const park = feature.commands?.[0];
	if (!park || park.subcommands !== undefined) throw new Error("no /park");
	const context = (args: Args, who: Principal) => ({
		args,
		users: {},
		channels: {},
		principal: who,
		logger: silentLogger,
		availableCommands: [],
	});

	/** `/park`, with or without `for:`. */
	const run = async (args: Args = {}, who: Principal = member()) => {
		const reply = await park.handler(context(args, who));
		expect(reply.private).toBe(true);
		expectFits(reply);
		return reply;
	};
	const act = async (
		name: string,
		args: Args = {},
		who: Principal = member(),
	): Promise<ActionResult> => {
		const action = feature.actions?.find((a) => a.name === name);
		if (!action) throw new Error(`no action ${name}`);
		const result = await action.handler(context(args, who));
		if ("reply" in result) {
			expect(result.reply.private).toBe(true);
			expectFits(result.reply);
		}
		return result;
	};
	const replyOf = (result: ActionResult): Reply => {
		if (!("reply" in result)) throw new Error("expected a reply");
		return result.reply;
	};
	/** Uses the button labelled `label` (or picks `value` from the select with that placeholder). */
	const click = async (reply: Reply, label: string, who: Principal = member(), value?: string) => {
		const control = controlsOf(reply).find((c) =>
			c.kind === "select" ? c.placeholder === label : c.label === label,
		);
		if (!control || control.kind === "link") throw new Error(`no control "${label}"`);
		const args = { ...control.call.args } as Record<string, string>;
		if (control.kind === "select") args[control.arg] = value ?? "";
		return act(control.call.action, args, who);
	};
	/** Books for `typed`, as `/park for:` does. */
	const book = (typed: string, who: Principal = member()) => run({ for: typed }, who);

	return {
		spots,
		windows,
		bookings,
		gate,
		reporter,
		notices,
		activity,
		feature,
		park,
		run,
		act,
		replyOf,
		click,
		book,
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
	it("is one private command for members with the parking capability, and so is every action", () => {
		const { park, feature } = setup();
		const access = { minTier: "member", capability: "parking" };
		expect(PARKING_CAPABILITY.name).toBe("parking");
		expect(feature.commands).toHaveLength(1);
		expect([park.name, park.access, park.private]).toEqual(["park", access, true]);
		expect(park.options?.map((o) => [o.name, o.required])).toEqual([["for", undefined]]);
		expect(feature.actions?.map((a) => a.name).sort()).toEqual(Object.values(ACTIONS).sort());
		for (const action of feature.actions ?? []) expect(action.access).toEqual(access);
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

describe("not parked", () => {
	it("asks how long, offering the settings' durations, and shows who's where", async () => {
		const t = withSpots();
		await t.book("1h", member(BOB, "Bob"));
		const reply = await t.run();
		expect(main(reply)).toContain("How long do you need?");
		expect(labels(reply)).toEqual([
			"Park for 30m",
			"Park for 1h",
			"Park for 2h",
			"Park for 4h",
			"Park until 23:59 (off)",
			"Another length…",
			"Refresh",
		]);
		expect(spotsOf(reply)).toContain("**ours** (Next to the \\*gate\\*): taken by Bob since 10:00");
	});

	it("lists free and taken spots in separate groups, free first", async () => {
		const t = withSpots();
		await t.book("1h", member(BOB, "Bob"));
		const reply = await t.run();
		const titles = (reply.embeds ?? []).map((e) => e.title);
		expect(titles).toEqual(["🅿️ Parking", "Free", "Taken"]);
		const [, free, taken] = reply.embeds ?? [];
		expect(free?.description).toContain("free");
		expect(free?.description).not.toContain("taken by");
		expect(taken?.description).toContain("taken by Bob");
		expect(taken?.description).not.toContain("free");
	});

	it("books our own spot first, opens the gate and says where", async () => {
		const t = withSpots();
		const reply = t.replyOf(await t.click(await t.run(), "Park for 2h"));
		expect(main(reply)).toBe(
			[
				"Park in **ours** (Next to the \\*gate\\*). It's yours until 12:00.",
				"The gate is opening.",
				"I'll DM you 15 minutes before it ends (that needs DMs from server members on).",
				"Press **Leave** when you go.",
			].join("\n"),
		);
		expect(labels(reply)).toEqual([
			"Open the gate",
			"Leave",
			"Someone's in my spot",
			"Stay 30m longer",
			"Stay 1h longer",
			"Stay 2h longer",
			"Stay 4h longer",
			"Stay until 23:59",
			"Refresh",
		]);
		expect(t.bookings.byPerson(`discord:${IDS.member}`)).toMatchObject({
			spot: "ours",
			by: { name: "Alice" },
			since: NOW,
			until: utc("10:00"),
		});
		expect(t.gate.open).toHaveBeenCalledWith({ principal: member(), spot: "ours" });
	});

	it("books straight away with /park for:", async () => {
		const t = withSpots();
		expect(main(await t.book("2h"))).toContain("Park in **ours**");
		expect(t.bookings.all()).toHaveLength(1);
	});

	it("then the borrowed spot that fits most tightly", async () => {
		const t = withSpots();
		await t.book("30m", member(BOB, "Bob"));
		expect(main(await t.book("1h"))).toContain("Park in **neighbour-1**. It's yours until 11:00.");
		expect(main(await t.book("4h", member("100000000000000006")))).toContain(
			"Park in **neighbour-2**. It's yours until 14:00.",
		);
	});

	it("explains when nothing is free for that long, and offers the longest stay that fits", async () => {
		const t = withSpots();
		await t.book("rest of day");
		const reply = await t.book("rest of day", member(BOB, "Bob"));
		expect(main(reply)).toContain(
			"⚠️ Nothing is free for that long, so the gate stays shut. **neighbour-2** is free until 17:00.",
		);
		expect(t.bookings.byPerson(`discord:${BOB}`)).toBeUndefined();
		expect(labels(reply)).toContain("Park until 23:59 (off)");
		expect(labels(reply)).toContain("Park for 4h");
	});

	it("offers the longest stay as a button when none of the durations fit", async () => {
		const t = setup();
		t.spots.add({ name: "neighbour-1", permanent: false });
		t.openWindow("neighbour-1", NOW, utc("08:20"));
		const reply = await t.run();
		expect(labels(reply)).toEqual(["Park until 10:20", "Another length…", "Refresh"]);
		const parked = t.replyOf(await t.click(reply, "Park until 10:20"));
		expect(main(parked)).toContain("It's yours until 10:20.");
		expect(main(parked)).toContain("It can't be extended: the spot closes at 10:20.");
	});

	it("says so when every spot is taken or closed", async () => {
		const t = setup();
		t.spots.add({ name: "ours", permanent: true });
		t.closeOurs(NOW, utc("12:00"));
		const reply = await t.run();
		expect(main(reply)).toBe("Every spot is taken or closed right now. Try again later.");
		expect(labels(reply)).toEqual(["Refresh"]);
		expect(main(await t.book("1h"))).toContain(
			"⚠️ Sorry, every spot is taken or closed right now, so the gate stays shut.",
		);
		expect(t.gate.open).not.toHaveBeenCalled();
	});

	it("stops before our spot's next closure", async () => {
		const t = setup();
		t.spots.add({ name: "ours", permanent: true });
		t.closeOurs(utc("10:00"), utc("12:00"));
		expect(main(await t.book("3h"))).toContain("**ours** is free until 12:00.");
		expect(main(await t.book("2h"))).toContain("Park in **ours**");
	});

	it("never books past the reset", async () => {
		const t = withSpots();
		t.setNow(utc("20:00"));
		expect(main(await t.book("4h"))).toContain(
			"⚠️ Parking ends at 23:59 every day, so that's too long. Pick a shorter time.",
		);
		expect(labels(await t.run())).toContain("Park for 4h (off)");
	});

	it("takes another length on a form, and explains one it can't read", async () => {
		const t = withSpots();
		const result = await t.click(await t.run(), "Another length…");
		if (!("form" in result)) throw new Error("expected a form");
		const form: Form = result.form;
		expect(form.fields).toEqual([expect.objectContaining({ name: "for", style: "short" })]);
		expect(main(t.replyOf(await t.act(form.submit.action, { for: "a while" })))).toContain(
			"⚠️ I couldn't understand how long.",
		);
		expect(main(t.replyOf(await t.act(form.submit.action, { for: "45m" })))).toContain(
			"It's yours until 10:45.",
		);
	});

	it("offers a select when there are more than five durations", async () => {
		const t = withSpots();
		t.spots.setSettings({ durations: ["15m", "30m", "45m", "1h", "2h", "3h"] });
		const reply = await t.run();
		expect(labels(reply)[0]).toBe("[How long?]");
		expect(main(t.replyOf(await t.click(reply, "How long?", member(), "45m")))).toContain(
			"It's yours until 10:45.",
		);
	});

	it("makes no second booking when already parked, and opens the gate again", async () => {
		const t = withSpots();
		await t.book("2h");
		const reply = await t.book("rest of day");
		expect(main(reply)).toContain("You're already parked here, so I didn't book another spot.");
		expect(main(reply)).toContain("The gate is opening.");
		expect(t.bookings.all()).toHaveLength(1);
		expect(t.gate.open).toHaveBeenCalledTimes(2);
	});

	it("is off while the spots file is invalid", async () => {
		const spots = Object.assign(new ParkingSpotStore({ logger: silentLogger }), { problem: "x" });
		const t = setup({ spots });
		const reply = await t.run();
		expect(said(reply)).toContain("Parking is off right now");
		expect(labels(reply)).toEqual(["Refresh"]);
		expect(main(await t.book("1h"))).toContain("⚠️ Parking is off right now.");
	});
});

describe("the gate", () => {
	it("opens again with Open the gate, and never retries a failure itself", async () => {
		const gate = { open: vi.fn(async () => Promise.reject(new Error("timeout"))) };
		const t = withSpots({ gate });
		const parked = await t.book("2h");
		expect(main(parked)).toContain("Park in **ours**");
		expect(main(parked)).toContain(
			"⚠️ The gate didn't open. Press **Open the gate** to try once more.",
		);
		expect(gate.open).toHaveBeenCalledTimes(1);
		expect(t.reporter.captureBackground).toHaveBeenCalledWith(expect.any(Error), "parking");
		expect(t.bookings.all()).toHaveLength(1);
		gate.open.mockResolvedValueOnce({ opened: true } as never);
		expect(main(t.replyOf(await t.click(parked, "Open the gate")))).toContain(
			"The gate is opening.",
		);
		expect(gate.open).toHaveBeenCalledTimes(2);
	});

	it("only opens for someone who's parked", async () => {
		const t = withSpots();
		const reply = t.replyOf(await t.act(ACTIONS.gate));
		expect(main(reply)).toContain("You're not parked anywhere.");
		expect(t.gate.open).not.toHaveBeenCalled();
	});

	it("doesn't open while the spots file is invalid", async () => {
		const t = withSpots();
		await t.book("1h");
		Object.assign(t.spots, { problem: "x" });
		await expect(t.act(ACTIONS.gate)).rejects.toThrow(/Parking is off/);
		expect(t.gate.open).toHaveBeenCalledTimes(1);
	});

	it("says what the gate did", () => {
		expect(gateLine({ opened: true })).toBe("The gate is opening.");
		expect(gateLine({ opened: false, reason: "not-connected" })).toBe(
			"Pixel can't open the gate right now, so open it the usual way.",
		);
		expect(gateLine({ opened: false, reason: "off" })).toBe(
			"Opening doors from Pixel is switched off right now, so open the gate the usual way.",
		);
		expect(gateLine({ opened: false, reason: "failed" })).toContain("didn't open");
	});
});

describe("who's where", () => {
	it("shows who's where, since when, until about when, and how long each spot has", async () => {
		const t = withSpots();
		await t.book("1h", member(BOB, "Bob *the* parker"));
		t.setNow(utc("09:30"));
		expect(spotsOf(await t.run())).toBe(
			[
				"**neighbour-1**: free · open until 14:00 (2h 30m left)",
				"**neighbour-2**: free · open until 17:00 (5h 30m left)",
				"**ours** (Next to the \\*gate\\*): taken by Bob \\*the\\* parker since 10:00, until about 11:00 (over by 30m) · open until 23:59 (12h 29m left)",
			].join("\n"),
		);
	});

	it("shows our spot closed, and leaves out closed borrowed spots", async () => {
		const t = setup();
		t.spots.add({ name: "ours", permanent: true });
		t.spots.add({ name: "neighbour-1", permanent: false });
		t.closeOurs(NOW, utc("12:00"));
		expect(spotsOf(await t.run())).toBe("**ours**: closed until 14:00");
	});

	it("says when nothing is open, or there are no spots", async () => {
		const t = setup();
		expect(spotsOf(await t.run())).toBe("There are no parking spots yet.");
		t.spots.add({ name: "neighbour-1", permanent: false });
		expect(spotsOf(await t.run())).toBe("No spot is open right now.");
	});

	it("warns when a file can't be read", async () => {
		const spots = Object.assign(new ParkingSpotStore({ logger: silentLogger }), { problem: "x" });
		const bookings = Object.assign(new ParkingBookingStore({ logger: silentLogger }), {
			problem: "y",
		});
		const text = spotsOf(await setup({ spots, bookings }).run());
		expect(text).toContain("⚠️ Parking is off right now.");
		expect(text).toContain("⚠️ Pixel can't read who's parked");
	});

	it("comes back fresh on Refresh", async () => {
		const t = withSpots();
		const reply = await t.run();
		await t.book("1h", member(BOB, "Bob"));
		expect(spotsOf(t.replyOf(await t.click(reply, "Refresh")))).toContain("taken by Bob");
	});
});

describe("leaving", () => {
	it("frees your spot and goes back to choosing how long", async () => {
		const t = withSpots();
		const parked = await t.book("1h");
		const left = t.replyOf(await t.click(parked, "Leave"));
		expect(main(left)).toContain("Thanks, **ours** is free again.");
		expect(labels(left)).toContain("Park for 1h");
		expect(t.bookings.all()).toEqual([]);
		expect(main(t.replyOf(await t.click(parked, "Leave")))).toContain(
			"You're not parked anywhere.",
		);
	});
});

describe("staying longer", () => {
	const extend = async (t: ReturnType<typeof setup>, typed: string, who: Principal = member()) =>
		main(t.replyOf(await t.act(ACTIONS.extend, { for: typed }, who)));

	it("offers what fits before the spot closes, adds to your end, and resets the reminder", async () => {
		const t = withSpots();
		await t.book("30m", member(BOB, "Bob"));
		const parked = await t.book("1h");
		expect(t.bookings.byPerson(`discord:${IDS.member}`)?.spot).toBe("neighbour-1");
		// neighbour-1 closes at 14:00, 3h after the end at 11:00.
		expect(labels(parked)).toEqual([
			"Open the gate",
			"Leave",
			"Someone's in my spot",
			"Stay 30m longer",
			"Stay 1h longer",
			"Stay 2h longer",
			"Stay until 14:00",
			"Refresh",
		]);
		t.bookings.update(t.bookings.byPerson(`discord:${IDS.member}`)?.id ?? "", {
			remindedAt: utc("08:45"),
		});
		const longer = t.replyOf(await t.click(parked, "Stay 1h longer"));
		expect(main(longer)).toBe(
			[
				"Park in **neighbour-1**. It's yours until 12:00.",
				"✅ Extended by 1h.",
				"I'll DM you 15 minutes before it ends.",
				"Press **Leave** when you go.",
			].join("\n"),
		);
		expect(t.bookings.byPerson(`discord:${IDS.member}`)).toMatchObject({
			until: utc("10:00"),
			remindedAt: null,
		});
		expect(await extend(t, "3h")).toContain(
			"⚠️ **neighbour-1** can only be extended by 2h: it closes at 14:00.",
		);
		const most = t.replyOf(await t.click(longer, "Stay until 14:00"));
		expect(t.bookings.byPerson(`discord:${IDS.member}`)?.until).toEqual(utc("12:00"));
		expect(main(most)).toContain("It can't be extended: the spot closes at 14:00.");
		expect(labels(most)).toEqual(["Open the gate", "Leave", "Someone's in my spot", "Refresh"]);
		expect(await extend(t, "1m")).toContain(
			"⚠️ **neighbour-1** can't be extended: it closes at 14:00.",
		);
	});

	it("stays until the reset where the spot allows", async () => {
		const t = withSpots();
		const parked = await t.book("1h");
		const rest = t.replyOf(await t.click(parked, "Stay until 23:59"));
		expect(main(rest)).toContain("✅ Extended until the end of the day.");
		expect(t.bookings.byPerson(`discord:${IDS.member}`)?.until).toEqual(RESET);
		expect(main(rest)).toContain("It can't be extended: parking ends at 23:59 every day.");
		expect(await extend(t, "rest of day")).toContain("can't be extended: parking ends at 23:59");
	});

	it("says by how much, for rest of day too", async () => {
		const t = withSpots();
		await t.book("30m", member(BOB, "Bob"));
		await t.book("5h");
		expect(await extend(t, "rest of day")).toContain("only be extended by 2h: it closes at 17:00");
	});

	it("counts from now once the end has passed, without a reminder that's already due", async () => {
		const t = withSpots();
		await t.book("1h");
		t.setNow(utc("09:03"));
		expect(await extend(t, "10m")).toContain("It's yours until 11:13.");
		expect(t.bookings.byPerson(`discord:${IDS.member}`)?.remindedAt).toEqual(utc("09:03"));
	});

	it("needs a booking, and a duration it can read", async () => {
		const t = withSpots();
		expect(await extend(t, "1h")).toContain("⚠️ You're not parked anywhere.");
		await t.book("1h");
		expect(await extend(t, "ages")).toContain("⚠️ I couldn't understand how long.");
	});

	it("says so when the booking ended meanwhile", async () => {
		const t = withSpots();
		await t.book("1h");
		Object.assign(t.bookings, { update: () => undefined });
		expect(await extend(t, "30m")).toContain("⚠️ You're not parked anywhere any more.");
	});

	it("offers at most five ways, always including the longest", async () => {
		const t = withSpots();
		t.spots.setSettings({ durations: ["15m", "30m", "45m", "1h", "2h", "rest of day"] });
		const parked = await t.book("1h");
		expect(labels(parked).filter((l) => l.startsWith("Stay"))).toEqual([
			"Stay 15m longer",
			"Stay 30m longer",
			"Stay 45m longer",
			"Stay 1h longer",
			"Stay until 23:59",
		]);
	});
});

describe("someone's in my spot", () => {
	const recorded = (t: ReturnType<typeof setup>) => t.activity.record.mock.calls.map(([e]) => e);
	const takenPanel = async (t: ReturnType<typeof setup>) =>
		t.replyOf(await t.click(await t.run(), "Someone's in my spot"));

	it("offers another free spot first, and changes nothing until it's confirmed", async () => {
		const t = withSpots();
		await t.book("1h");
		const offer = await takenPanel(t);
		expect(main(offer)).toBe(
			[
				"Sorry about that. **neighbour-1** is free for the rest of your time, until 11:00.",
				"Move there, and I'll close **ours** until 23:59 and tell the admins.",
			].join("\n"),
		);
		expect(labels(offer)).toEqual(["Move to neighbour-1", "Cancel"]);
		expect(t.bookings.all()[0]?.spot).toBe("ours");
		expect(t.windows.entries(NOW).blocks).toEqual([]);
		expect(main(t.replyOf(await t.click(offer, "Cancel")))).toContain("Park in **ours**");
	});

	it("moves them, closes the taken spot until the reset, and tells the admins", async () => {
		const t = withSpots();
		await t.book("1h");
		const moved = t.replyOf(await t.click(await takenPanel(t), "Move to neighbour-1"));
		expect(main(moved)).toContain("Park in **neighbour-1**. It's yours until 11:00.");
		expect(main(moved)).toContain("I've moved you here, closed **ours** and told the admins.");
		expect(t.bookings.all()).toMatchObject([{ spot: "neighbour-1", until: utc("09:00") }]);
		expect(t.windows.entries(NOW).blocks).toMatchObject([
			{ spot: "ours", from: NOW, until: RESET, reason: "taken", setBy: { name: "Alice" } },
		]);
		expect(recorded(t).at(-1)).toEqual({
			kind: "moved",
			from: "ours",
			to: "neighbour-1",
			who: "Alice",
			closedUntil: RESET,
		});
		// Nobody else is sent to the taken spot.
		expect(main(await t.book("1h", member(BOB, "Bob")))).toContain("**neighbour-2**");
	});

	it("never says the admins were told when they weren't", async () => {
		const t = withSpots();
		await t.book("1h");
		t.activity.posting = false;
		const offer = await takenPanel(t);
		expect(main(offer)).toContain("and I'll close **ours** until 23:59.");
		t.activity.record.mockResolvedValueOnce(false);
		expect(main(t.replyOf(await t.click(offer, "Move to neighbour-1")))).toContain(
			"I've moved you here and closed **ours**, but I couldn't tell the admins, so please tell the board yourself.",
		);
	});

	it("asks them to leave when nothing else is free, and reports it to the board", async () => {
		const t = setup();
		t.spots.add({ name: "ours", permanent: true });
		await t.book("1h");
		const offer = await takenPanel(t);
		expect(main(offer)).toContain("No other spot is free right now, so you'll have to leave.");
		expect(labels(offer)).toEqual(["End my booking and report it", "Cancel"]);
		const ended = t.replyOf(await t.click(offer, "End my booking and report it"));
		expect(main(ended)).toContain(
			"Sorry: someone else is in **ours** and no other spot is free right now, so please leave. I've ended your booking.\nI've reported it to the board.",
		);
		expect(t.bookings.all()).toEqual([]);
		expect(t.windows.entries(NOW).blocks).toMatchObject([{ spot: "ours", reason: "taken" }]);
		expect(recorded(t).at(-1)).toEqual({
			kind: "taken",
			spot: "ours",
			who: "Alice",
			closedUntil: RESET,
		});
	});

	it("says so when it couldn't reach the board", async () => {
		const t = setup();
		t.spots.add({ name: "ours", permanent: true });
		await t.book("1h");
		t.activity.record.mockResolvedValueOnce(false);
		expect(main(t.replyOf(await t.act(ACTIONS.takenConfirm)))).toContain(
			"I couldn't report it to the board, so please tell them yourself.",
		);
	});

	it("asks them to leave when the offered spot went meanwhile", async () => {
		const t = withSpots();
		await t.book("1h");
		Object.assign(t.bookings, { move: () => undefined });
		expect(main(t.replyOf(await t.act(ACTIONS.takenConfirm)))).toContain("so please leave");
	});

	it("still reports it when the taken spot can't be closed", async () => {
		const t = setup();
		t.spots.add({ name: "ours", permanent: true });
		await t.book("1h");
		Object.assign(t.windows, {
			replace: () => {
				throw new Error("disk full");
			},
		});
		expect(main(t.replyOf(await t.act(ACTIONS.takenConfirm)))).toContain(
			"I've reported it to the board.",
		);
	});

	it("needs a booking", async () => {
		const t = withSpots();
		expect(main(t.replyOf(await t.act(ACTIONS.taken)))).toContain("You're not parked anywhere.");
		expect(main(t.replyOf(await t.act(ACTIONS.takenConfirm)))).toContain(
			"⚠️ You're not parked anywhere.",
		);
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
				"Your parking in **ours** ends at 11:00.\nThe spot is open until 23:59, so you can stay up to 12h59 longer: run `/park` and pick how long.\nIf you haven't left or extended by 11:05, I'll end it. Leaving? Run `/park` and press **Leave**.",
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
				"Your parking in **neighbour-1** ends at 14:00.\nThe spot closes then, so it can't be extended.\nIf you haven't left or extended by then, I'll end it. Leaving? Run `/park` and press **Leave**.",
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
			"Your parking in **ours** ends at 23:59.\nParking ends at 23:59 every day, so it can't be extended.\nIf you haven't left or extended by then, I'll end it. Leaving? Run `/park` and press **Leave**.",
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

	it("skips the reminder for a stay exactly as long as the reminder, as /park said", async () => {
		vi.useFakeTimers();
		const t = withSpots();
		const reply = await t.run({ for: "15m" });
		expect(said(reply)).not.toContain("I'll DM you");
		const stop = await start(t);
		await tick();
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

describe("parking activity", () => {
	const kinds = (t: ReturnType<typeof setup>) => t.activity.record.mock.calls.map(([e]) => e.kind);

	it("records booking, a failed park, extending and leaving", async () => {
		const t = withSpots();
		await t.book("1h");
		await t.book("1h", member(BOB, "Bob"));
		await t.book("rest of day", member("100000000000000006", "Carol"));
		await t.book("rest of day", member("100000000000000007", "Dan"));
		await t.act(ACTIONS.extend, { for: "30m" });
		await t.act(ACTIONS.leave);
		expect(kinds(t)).toEqual(["booked", "booked", "none-free", "none-free", "extended", "left"]);
		expect(t.activity.record.mock.calls[0]?.[0]).toEqual({
			kind: "booked",
			spot: "ours",
			who: "Alice",
			until: utc("09:00"),
		});
	});

	it("records bookings Pixel ends", async () => {
		vi.useFakeTimers();
		const t = withSpots();
		await t.run({ for: "rest of day" });
		await t.run({ for: "1h" }, member(BOB, "Bob"));
		t.setNow(utc("09:05"));
		const stop = t.feature.start?.();
		await vi.advanceTimersByTimeAsync(0);
		t.setNow(utc("22:00"));
		await vi.advanceTimersByTimeAsync(TICK_MS);
		expect(t.activity.record.mock.calls.map(([e]) => e).filter((e) => e.kind === "ended")).toEqual([
			{ kind: "ended", spot: "neighbour-1", who: "Bob", reason: "over" },
			{ kind: "ended", spot: "ours", who: "Alice", reason: "reset" },
		]);
		stop?.();
	});
});

describe("fitLines", () => {
	it("keeps whole lines that fit, then says how many more there are", () => {
		expect(fitLines(["a", "b", "c"], 100)).toBe("a\nb\nc");
		expect(fitLines(["x".repeat(10), "y".repeat(10), "z".repeat(10)], 32)).toBe(
			`${"x".repeat(10)}\n${"y".repeat(10)}\n${"z".repeat(10)}`,
		);
		const cut = fitLines(["x".repeat(10), "y".repeat(10), "z".repeat(10)], 31);
		expect(cut).toBe(`${"x".repeat(10)}\n…and 2 more.`);
		expect(cut.length).toBeLessThanOrEqual(31);
	});

	it("fits a hundred spots in one embed", () => {
		const lines = Array.from({ length: 100 }, (_, i) => `**spot ${i}** (${"d".repeat(60)}): free`);
		const text = fitLines(lines, 4000);
		expect(text.length).toBeLessThanOrEqual(4000);
		expect(text).toMatch(/…and \d+ more\.$/);
		expect(
			text
				.split("\n")
				.slice(0, -1)
				.every((l) => lines.includes(l)),
		).toBe(true);
	});
});
