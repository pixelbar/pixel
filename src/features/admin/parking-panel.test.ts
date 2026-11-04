import { describe, expect, it, vi } from "vitest";
import type { PlatformActor, Tier } from "../../core/access.ts";
import type { ResolvedUser } from "../../core/command.ts";
import { type ActionOutcome, Dispatcher, MESSAGES } from "../../core/dispatcher.ts";
import { IdentityService } from "../../core/identity.ts";
import { silentLogger } from "../../core/logger.ts";
import { nullErrorReporter } from "../../core/ports/error-reporter.ts";
import { RateLimiter } from "../../core/rate-limit.ts";
import { CommandRegistry } from "../../core/registry.ts";
import type { Reply } from "../../core/reply.ts";
import { type Control, type Form, UI_LIMITS } from "../../core/ui.ts";
import { ParkingBookingStore } from "../../services/parking-bookings.ts";
import { ParkingSpotStore } from "../../services/parking-spots.ts";
import { ParkingWindowStore } from "../../services/parking-windows.ts";
import { actor, IDS } from "../../testing/fixtures.ts";
import { createParkingAdmin, PARKING_ACTIONS } from "./parking-panel.ts";

const ZONE = "Europe/Amsterdam";
/** Saturday 24 Oct 2026, 10:00 in Amsterdam (UTC+2). */
const NOW = new Date("2026-10-24T08:00:00Z");
const utc = (time: string) => new Date(`2026-10-24T${time}:00Z`);
const ALICE = { ref: `discord:${IDS.member}`, name: "Alice" };
const BOB: ResolvedUser = { id: "100000000000000005", displayName: "Bob", isBot: false };
const TIERS: Record<string, Tier> = { [IDS.admin]: "admin", [IDS.member]: "member" };

const controlsOf = (reply: Reply): Control[] => (reply.controls ?? []).flat();
const labels = (reply: Reply) =>
	controlsOf(reply).map((c) => (c.kind === "select" ? `[${c.placeholder}]` : c.label));
const said = (reply: Reply) =>
	(reply.embeds ?? []).map((e) => `${e.title}\n${e.description}`).join("\n");

function expectFits(reply: Reply) {
	const rows = reply.controls ?? [];
	expect(rows.length).toBeLessThanOrEqual(UI_LIMITS.rows);
	for (const row of rows) {
		expect(row.length).toBeLessThanOrEqual(UI_LIMITS.buttonsPerRow);
		if (row.some((c) => c.kind === "select")) expect(row).toHaveLength(1);
	}
}

function setup() {
	const spots = new ParkingSpotStore({ logger: silentLogger });
	const windows = new ParkingWindowStore({ logger: silentLogger });
	const bookings = new ParkingBookingStore({ logger: silentLogger });
	const notices = { send: vi.fn(async () => {}) };
	const activity = { record: vi.fn(async () => true) };
	const { subcommand, actions } = createParkingAdmin({
		spots,
		windows,
		bookings,
		notices,
		activity,
		timezone: ZONE,
		now: () => NOW,
	});
	const registry = new CommandRegistry();
	registry.register({
		name: "admin",
		commands: [
			{
				name: "admin",
				description: "Administration",
				access: { minTier: "admin" },
				subcommands: [subcommand],
			},
		],
		actions,
	});
	const dispatcher = new Dispatcher({
		registry,
		identity: new IdentityService([
			{ name: "t", tierFor: async (a: PlatformActor) => TIERS[a.userId] ?? null },
		]),
		rateLimiter: new RateLimiter({ capacity: 10_000, refillPerSecond: 0, now: () => 0 }),
		logger: silentLogger,
		reporter: nullErrorReporter,
	});
	const who = (userId: string = IDS.admin) => actor({ userId, displayName: "Admin" });

	/** `/admin` → Parking. */
	const open = async (userId: string = IDS.admin) => {
		const { reply } = await dispatcher.dispatch({
			actor: who(userId),
			command: "admin",
			subcommand: "parking",
			args: {},
		});
		expectFits(reply);
		return reply;
	};
	const act = async (
		action: string,
		args: Record<string, string | boolean>,
		opts: { users?: Record<string, ResolvedUser>; userId?: string } = {},
	) => {
		const outcome = await dispatcher.act({
			actor: who(opts.userId),
			action,
			args,
			...(opts.users ? { users: opts.users } : {}),
		});
		if (outcome.kind === "update") expectFits(outcome.reply);
		return outcome;
	};
	const click = (reply: Reply, label: string, values: string[] = []) => {
		const control = controlsOf(reply).find((c) =>
			c.kind === "select" ? c.placeholder === label : c.label === label,
		);
		if (!control || control.kind === "link") throw new Error(`no control "${label}"`);
		const args = { ...control.call.args } as Record<string, string | boolean>;
		if (control.kind === "select") args[control.arg] = values.join(", ");
		return act(control.call.action, args);
	};
	const submit = (
		form: Form,
		fields: Record<string, string>,
		users?: Record<string, ResolvedUser>,
	) =>
		act(
			form.submit.action,
			{ ...(form.submit.args as Record<string, string>), ...fields },
			users ? { users } : {},
		);
	return { spots, windows, bookings, notices, activity, actions, open, act, click, submit };
}

function withSpots() {
	const t = setup();
	t.spots.add({ name: "ours", permanent: true, description: "Next to the gate" });
	t.spots.add({ name: "neighbour-1", permanent: false });
	return t;
}

function replyOf(outcome: ActionOutcome): Reply {
	if (outcome.kind !== "update")
		throw new Error(`expected an update, got ${JSON.stringify(outcome)}`);
	return outcome.reply;
}
/** A form's problem: refused, to go back with Fix it. */
function problemOf(outcome: ActionOutcome): string {
	if (outcome.kind !== "refused" || !outcome.problem)
		throw new Error(`expected a problem, got ${JSON.stringify(outcome)}`);
	return outcome.reply.text ?? "";
}
function formOf(outcome: ActionOutcome): Form {
	if (outcome.kind !== "form") throw new Error(`expected a form, got ${JSON.stringify(outcome)}`);
	return outcome.form;
}

describe("/admin → Parking panel", () => {
	it("is admin-only: the subcommand and every action", async () => {
		const t = withSpots();
		expect((await t.open(IDS.member)).text).toBe(MESSAGES.deniedTier);
		for (const action of t.actions) expect(action.access).toEqual({ minTier: "admin" });
		expect(t.actions.map((a) => a.name).sort()).toEqual(Object.values(PARKING_ACTIONS).sort());
		expect((await t.act(PARKING_ACTIONS.home, {}, { userId: IDS.member })).kind).toBe("refused");
	});

	it("starts with Add a spot when there are none", async () => {
		const reply = await setup().open();
		expect(said(reply)).toContain("There are no parking spots yet. Add one with **Add a spot**.");
		expect(labels(reply)).toEqual(["Add a spot", "Settings", "Refresh", "← Admin"]);
	});

	it("lists every spot, with menus to manage one, or open or close several", async () => {
		const reply = await withSpots().open();
		expect(said(reply)).toContain("**ours** (permanent): Next to the gate");
		expect(said(reply)).toContain("Reset: 23:59 every day");
		expect(labels(reply)).toEqual([
			"[Manage a spot…]",
			"[Open spots…]",
			"[Close spots…]",
			"Add a spot",
			"Settings",
			"Refresh",
			"← Admin",
		]);
		const several = controlsOf(reply).find(
			(c) => c.kind === "select" && c.placeholder === "Open spots…",
		);
		expect(several?.kind === "select" && [several.min, several.max]).toEqual([1, 2]);
		expect(several?.kind === "select" && several.options.map((o) => o.description)).toEqual([
			"Permanent · Next to the gate",
			"Borrowed",
		]);
	});
});

describe("a spot's panel", () => {
	it("offers Open… for a closed borrowed spot, and Close for today once it's open", async () => {
		const t = withSpots();
		const closed = replyOf(await t.click(await t.open(), "Manage a spot…", ["neighbour-1"]));
		expect(closed.embeds?.[0]?.title).toBe("🅿️ neighbour-1");
		expect(labels(closed)).toEqual([
			"Open…",
			"Edit…",
			"Remove…",
			"Give it to someone…",
			"← All spots",
			"Refresh",
		]);
		const form = formOf(await t.click(closed, "Open…"));
		expect(form.fields.map((f) => [f.name, f.required])).toEqual([
			["from", false],
			["until", false],
		]);
		const opened = replyOf(await t.submit(form, { until: "17:00" }));
		expect(said(opened)).toContain("**neighbour-1** open from now until 17:00.");
		expect(labels(opened).slice(0, 2)).toEqual(["Open…", "Close for today"]);
		const shut = replyOf(await t.click(opened, "Close for today"));
		expect(said(shut)).toContain("**neighbour-1** closed for today.");
	});

	it("closes a permanent spot until a time on a form, and opens it again", async () => {
		const t = withSpots();
		const ours = replyOf(await t.act(PARKING_ACTIONS.spot, { spot: "ours" }));
		expect(labels(ours).slice(0, 1)).toEqual(["Close…"]);
		const form = formOf(await t.click(ours, "Close…"));
		expect(form.fields).toEqual([expect.objectContaining({ name: "until", required: false })]);
		const closed = replyOf(await t.submit(form, { until: "17:00" }));
		expect(said(closed)).toContain("**ours** closed until 17:00.");
		expect(labels(closed).slice(0, 2)).toEqual(["Open again", "Close…"]);
		expect(said(replyOf(await t.click(closed, "Open again")))).toContain("**ours** open again.");
	});

	it("sends a form's problem back to be fixed, and changes nothing", async () => {
		const t = withSpots();
		const form = formOf(await t.act(PARKING_ACTIONS.openPick, { spots: "neighbour-1" }));
		expect(form.submit.args).toEqual({ spots: "neighbour-1", form: true });
		expect(problemOf(await t.submit(form, { until: "later" }))).toContain(
			"I couldn't understand **Until**",
		);
		expect(t.windows.entries(NOW).windows).toEqual([]);
	});

	it("says so when the spot has gone", async () => {
		const t = withSpots();
		expect(said(replyOf(await t.act(PARKING_ACTIONS.spot, { spot: "nope" })))).toContain(
			"There's no spot called **nope** any more.",
		);
		expect(said(replyOf(await t.act(PARKING_ACTIONS.editForm, { spot: "nope" })))).toContain(
			"There's no spot called **nope** any more.",
		);
	});

	it("goes back to every spot", async () => {
		const t = withSpots();
		const ours = replyOf(await t.act(PARKING_ACTIONS.spot, { spot: "ours" }));
		expect(replyOf(await t.click(ours, "← All spots")).embeds?.[0]?.title).toBe("🅿️ Parking spots");
		expect(replyOf(await t.click(ours, "Refresh")).embeds?.[0]?.title).toBe("🅿️ ours");
	});
});

describe("several spots at once", () => {
	it("opens permanent spots straight away, and asks when for borrowed ones", async () => {
		const t = withSpots();
		await t.act(PARKING_ACTIONS.close, { spots: "ours" });
		const overview = await t.open();
		expect(said(replyOf(await t.click(overview, "Open spots…", ["ours"])))).toContain(
			"**ours** open again.",
		);
		const form = formOf(await t.click(overview, "Open spots…", ["neighbour-1"]));
		expect(form.title).toBe("Open neighbour-1");
		const both = t.spots.add({ name: "neighbour-2", permanent: false });
		const two = formOf(
			await t.act(PARKING_ACTIONS.openPick, { spots: `neighbour-1 ${both.name}` }),
		);
		const opened = replyOf(await t.submit(two, {}));
		expect(opened.embeds?.[0]?.title).toBe("🅿️ Parking spots");
		expect(said(opened)).toContain("**neighbour-1**, **neighbour-2** open from now until 23:59.");
	});

	it("handles spots whose names have spaces", async () => {
		const t = withSpots();
		t.spots.add({ name: "by the bins", permanent: false });
		const panel = replyOf(await t.click(await t.open(), "Manage a spot…", ["by the bins"]));
		expect(panel.embeds?.[0]?.title).toBe("🅿️ by the bins");
		const form = formOf(
			await t.click(await t.open(), "Open spots…", ["by the bins", "neighbour-1"]),
		);
		expect(form.title).toBe("Open by the bins, neighbour-1");
		const opened = replyOf(await t.submit(form, { until: "17:00" }));
		expect(said(opened)).toContain("**by the bins**, **neighbour-1** open from now until 17:00.");
		const open = replyOf(await t.act(PARKING_ACTIONS.spot, { spot: "by the bins" }));
		const shut = replyOf(await t.click(open, "Close for today"));
		expect(shut.embeds?.[0]?.title).toBe("🅿️ by the bins");
		expect(said(shut)).toContain("**by the bins** closed for today.");
	});

	it("closes borrowed spots straight away, and asks until when for permanent ones", async () => {
		const t = withSpots();
		await t.act(PARKING_ACTIONS.open, { spots: "neighbour-1" });
		const overview = await t.open();
		expect(said(replyOf(await t.click(overview, "Close spots…", ["neighbour-1"])))).toContain(
			"**neighbour-1** closed for today.",
		);
		expect(formOf(await t.click(overview, "Close spots…", ["ours", "neighbour-1"])).title).toBe(
			"Close ours, neighbour-1",
		);
	});
});

describe("ending someone's booking", () => {
	it("asks first, and Go ahead ends it", async () => {
		const t = withSpots();
		await t.act(PARKING_ACTIONS.open, { spots: "neighbour-1" });
		t.bookings.claim(ALICE, NOW, () => ({ spot: "neighbour-1", until: utc("10:00") }));
		const panel = replyOf(await t.act(PARKING_ACTIONS.spot, { spot: "neighbour-1" }));
		const ask = replyOf(await t.click(panel, "Close for today"));
		expect(ask.embeds?.[0]?.title).toBe("End a booking?");
		expect(said(ask)).toContain(
			"Someone is parked in **neighbour-1** until about 12:00. Going ahead ends their booking.",
		);
		expect(labels(ask)).toEqual(["Go ahead and end it", "Cancel"]);
		expect(t.bookings.all()).toHaveLength(1);
		expect(replyOf(await t.click(ask, "Cancel")).embeds?.[0]?.title).toBe("🅿️ neighbour-1");
		const done = replyOf(await t.click(ask, "Go ahead and end it"));
		expect(said(done)).toContain("Ended Alice's booking in **neighbour-1**.");
		expect(t.bookings.all()).toEqual([]);
	});

	it("frees a spot after asking", async () => {
		const t = withSpots();
		t.bookings.claim(ALICE, NOW, () => ({ spot: "ours", until: utc("10:00") }));
		const panel = replyOf(await t.act(PARKING_ACTIONS.spot, { spot: "ours" }));
		expect(labels(panel)).toContain("Free the spot…");
		const ask = replyOf(await t.click(panel, "Free the spot…"));
		expect(said(ask)).toContain("This ends Alice's booking, until about 12:00.");
		const freed = replyOf(await t.click(ask, "End the booking"));
		expect(said(freed)).toContain("Ended Alice's booking: **ours** is free again.");
		expect(said(replyOf(await t.act(PARKING_ACTIONS.freeAsk, { spot: "ours" })))).toContain(
			"Nobody is parked in **ours**.",
		);
	});

	it("removes a spot after asking, saying whose booking ends", async () => {
		const t = withSpots();
		t.bookings.claim(ALICE, NOW, () => ({ spot: "ours", until: utc("10:00") }));
		const ask = replyOf(await t.act(PARKING_ACTIONS.removeAsk, { spot: "ours" }));
		expect(said(ask)).toContain("Alice is parked there until about 12:00: their booking ends.");
		const gone = replyOf(await t.click(ask, "Remove ours"));
		expect(said(gone)).toContain("Removed **ours**.");
		expect(gone.embeds?.[0]?.title).toBe("🅿️ Parking spots");
		expect(t.spots.get("ours")).toBeUndefined();
		const plain = replyOf(await t.act(PARKING_ACTIONS.removeAsk, { spot: "neighbour-1" }));
		expect(said(plain)).not.toContain("their booking ends");
	});
});

describe("giving a spot to someone", () => {
	it("asks who on a form, with a person picker", async () => {
		const t = withSpots();
		const form = formOf(await t.act(PARKING_ACTIONS.assignForm, { spot: "ours" }));
		expect(form.fields.map((f) => [f.kind, f.name])).toEqual([
			["user", "user"],
			["text", "for"],
		]);
		const reply = replyOf(await t.submit(form, { user: BOB.id, for: "2h" }, { user: BOB }));
		expect(said(reply)).toContain("Gave **ours** to Bob, until 12:00.");
		expect(t.bookings.all()).toMatchObject([
			{ spot: "ours", by: { ref: `discord:${BOB.id}`, name: "Bob" } },
		]);
	});

	it("asks before ending the holder's booking, then gives it", async () => {
		const t = withSpots();
		t.bookings.claim(ALICE, NOW, () => ({ spot: "ours", until: utc("10:00") }));
		const form = formOf(await t.act(PARKING_ACTIONS.assignForm, { spot: "ours" }));
		const ask = replyOf(await t.submit(form, { user: BOB.id }, { user: BOB }));
		expect(said(ask)).toContain("Alice is still booked into **ours**");
		const done = replyOf(await t.click(ask, "Go ahead and end it"));
		expect(said(done)).toContain("Gave **ours** to Bob, until 23:59.");
		expect(said(done)).toContain("Ended Alice's booking.");
		expect(t.bookings.all()).toMatchObject([{ spot: "ours", by: { name: "Bob" } }]);
	});

	it("refuses a bot", async () => {
		const t = withSpots();
		const form = formOf(await t.act(PARKING_ACTIONS.assignForm, { spot: "ours" }));
		const bot = { ...BOB, isBot: true };
		expect(await t.submit(form, { user: bot.id }, { user: bot })).toMatchObject({
			kind: "refused",
		});
	});
});

describe("spots and settings", () => {
	it("adds a spot on a form, and sends a bad name back to be fixed", async () => {
		const t = setup();
		const form = formOf(await t.click(await t.open(), "Add a spot"));
		expect(form.fields.map((f) => f.name)).toEqual(["name", "description", "kind"]);
		const kind = form.fields[2];
		expect(kind?.kind === "radio" && kind.options.find((o) => o.selected)?.value).toBe("borrowed");
		const added = replyOf(
			await t.submit(form, { name: "ours", kind: "permanent", description: "Here" }),
		);
		expect(added.embeds?.[0]?.title).toBe("🅿️ ours");
		expect(said(added)).toContain("Added **ours**, a permanent spot");
		expect(t.spots.get("ours")).toMatchObject({ permanent: true, description: "Here" });
		const spaced = replyOf(await t.submit(form, { name: "  by   the bins ", kind: "borrowed" }));
		expect(spaced.embeds?.[0]?.title).toBe("🅿️ by the bins");
		expect(said(spaced)).toContain("Added **by the bins**");
		expect(problemOf(await t.submit(form, { name: "Our_Spot", kind: "borrowed" }))).toContain(
			"A spot's name is letters",
		);
		expect(t.spots.all()).toHaveLength(2);
	});

	it("edits a spot on a form filled in with what's saved, and an empty description removes it", async () => {
		const t = withSpots();
		const form = formOf(await t.act(PARKING_ACTIONS.editForm, { spot: "ours" }));
		expect(form.fields[0]).toMatchObject({ name: "description", value: "Next to the gate" });
		const kind = form.fields[1];
		expect(kind?.kind === "radio" && kind.options.find((o) => o.selected)?.value).toBe("permanent");
		const edited = replyOf(await t.submit(form, { kind: "permanent" }));
		expect(said(edited)).toContain("Changed **ours**.");
		expect(t.spots.get("ours")?.description).toBeUndefined();
		await t.submit(form, { kind: "borrowed", description: "By the bins" });
		expect(t.spots.get("ours")).toMatchObject({ permanent: false, description: "By the bins" });
	});

	it("changes the settings on a form filled in with what's saved", async () => {
		const t = withSpots();
		const form = formOf(await t.click(await t.open(), "Settings"));
		expect(form.fields.map((f) => [f.name, f.kind === "text" ? f.value : undefined])).toEqual([
			["remind", "15"],
			["grace", "5"],
			["reset", "23:59"],
			["durations", "30m, 1h, 2h, 4h, rest of day"],
		]);
		const saved = replyOf(await t.submit(form, { remind: "10", grace: "", reset: "23:00" }));
		expect(said(saved)).toContain("Saved.");
		expect(t.spots.settings()).toMatchObject({
			remindMinutes: 10,
			graceMinutes: 5,
			resetAt: "23:00",
		});
		expect(problemOf(await t.submit(form, { remind: "lots" }))).toBe(
			"**Remind** is a whole number of minutes from 0 to 120.",
		);
	});
});

describe("problems", () => {
	it("shows each button's problem on the panel it came from", async () => {
		const t = withSpots();
		const problem = async (action: string, args: Record<string, string | boolean>) =>
			said(replyOf(await t.act(action, args)));
		expect(
			await problem(PARKING_ACTIONS.close, { spots: "neighbour-1", until: "17:00" }),
		).toContain("⚠️ A time only applies to permanent spots.");
		await t.act(PARKING_ACTIONS.close, { spots: "ours" });
		expect(await problem(PARKING_ACTIONS.open, { spots: "ours nope" })).toContain(
			"⚠️ There's no spot called `nope`.",
		);
		expect(await problem(PARKING_ACTIONS.closePick, { spots: "neighbour-1 nope" })).toContain(
			"⚠️ There's no spot called `nope`.",
		);
		expect(await problem(PARKING_ACTIONS.edit, { spot: "nope", kind: "borrowed" })).toContain(
			"⚠️ There's no spot called `nope`.",
		);
		expect(await problem(PARKING_ACTIONS.remove, { spot: "nope" })).toContain("⚠️");
		expect(await problem(PARKING_ACTIONS.free, { spot: "nope" })).toContain("⚠️");
		expect(
			await problem(PARKING_ACTIONS.assignConfirm, {
				spot: "neighbour-1",
				"user-id": BOB.id,
				"user-name": "Bob",
			}),
		).toContain("⚠️ **neighbour-1** is closed right now. Open it first.");
		const form = formOf(await t.act(PARKING_ACTIONS.assignForm, { spot: "neighbour-1" }));
		expect(problemOf(await t.submit(form, { user: BOB.id }, { user: BOB }))).toContain(
			"**neighbour-1** is closed right now.",
		);
	});

	it("reports anything unexpected instead of showing it", async () => {
		const t = withSpots();
		Object.assign(t.windows, {
			replace: () => {
				throw new Error("disk full");
			},
		});
		expect(await t.act(PARKING_ACTIONS.open, { spots: "neighbour-1" })).toEqual({
			kind: "refused",
			reply: { text: MESSAGES.internalError, private: true },
		});
	});
});
