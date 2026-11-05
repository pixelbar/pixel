import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformActor, Tier } from "../../../src/core/access.ts";
import { Dispatcher, MESSAGES } from "../../../src/core/dispatcher.ts";
import { type EntityState, HOME_MESSAGES, HomeUnavailableError } from "../../../src/core/home.ts";
import { HA_ADMIN, HOME_DENIED } from "../../../src/core/home-access.ts";
import { HOME_KINDS } from "../../../src/core/home-kinds/index.ts";
import { IdentityService } from "../../../src/core/identity.ts";
import { silentLogger } from "../../../src/core/logger.ts";
import { nullErrorReporter } from "../../../src/core/ports/error-reporter.ts";
import { RateLimiter } from "../../../src/core/rate-limit.ts";
import { CommandRegistry } from "../../../src/core/registry.ts";
import { type ControlResult, DeviceControl } from "../../../src/features/home/control.ts";
import { createHomeFeature } from "../../../src/features/home/index.ts";
import { HomeDeviceStore } from "../../../src/services/home-devices.ts";
import { actor, IDS } from "../../../src/testing/fixtures.ts";

const DEVICES = `devices:
  - name: lamp
    entity: light.lamp
    kind: light
    actions: [on, off, toggle]
  - name: sign
    entity: light.sign
    kind: light
    actions: [on, off]
    minTier: friend
  - name: socket
    entity: switch.socket
    kind: switch
    actions: [on, off]
  - name: frozen
    entity: light.frozen
    kind: light
  - name: front-door
    entity: lock.front_door
    kind: door
    actions: [lock, unlock]
  - name: temp
    entity: sensor.temp
    kind: sensor
`;

/** Obviously fake people, each with a tier and the capabilities they hold. */
const PEOPLE = {
	guestWithEverything: {
		id: "100000000000000010",
		tier: null,
		holds: [HA_ADMIN, "ha-lights", "ha-doors"],
	},
	plainMember: { id: IDS.member, tier: "member", holds: [] },
	plainAdmin: { id: IDS.admin, tier: "admin", holds: [] },
	lights: { id: "100000000000000011", tier: "member", holds: ["ha-lights"] },
	switches: { id: "100000000000000012", tier: "member", holds: ["ha-switches"] },
	doors: { id: "100000000000000013", tier: "member", holds: ["ha-doors"] },
	haAdmin: { id: "100000000000000014", tier: "member", holds: [HA_ADMIN] },
	friendLights: { id: "100000000000000015", tier: "friend", holds: ["ha-lights"] },
	friendAdmin: { id: "100000000000000016", tier: "friend", holds: [HA_ADMIN] },
} as const;
type Who = keyof typeof PEOPLE;

const DONE: ControlResult & { durationMs: number } = {
	outcome: "done",
	before: "off",
	after: "on",
	durationMs: 12,
};

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pixel-set-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(
	options: {
		yaml?: string | null;
		result?: ControlResult & { durationMs: number };
		run?: (...args: unknown[]) => Promise<ControlResult & { durationMs: number }>;
		doorsOff?: boolean;
		control?: DeviceControl;
		states?: EntityState[];
	} = {},
) {
	let devices = HomeDeviceStore.empty();
	if (options.yaml !== null) {
		writeFileSync(join(dir, "devices.yaml"), options.yaml ?? DEVICES);
		devices = HomeDeviceStore.open({ dir, kinds: HOME_KINDS });
	}
	const run = vi.fn(options.run ?? (async () => options.result ?? DONE));
	const control = options.control ?? { run: run as DeviceControl["run"], timeoutMs: 8000 };
	const logger = { ...silentLogger, info: vi.fn(), warn: vi.fn() };
	logger.child = () => logger;
	const reporter = { ...nullErrorReporter, breadcrumb: vi.fn() };
	const getStates = vi.fn(
		async (ids: readonly string[]) =>
			new Map(
				(options.states ?? []).filter((s) => ids.includes(s.entityId)).map((s) => [s.entityId, s]),
			),
	);
	const callService = vi.fn(async () => {});
	const feature = createHomeFeature({
		home: { getStates, callService },
		homeDevices: devices,
		reporter,
		control,
		switches: { isOn: (kind: string) => !(options.doorsOff && kind === "door") },
	});
	const registry = new CommandRegistry();
	registry.register(feature);
	const byId = new Map<string, (typeof PEOPLE)[Who]>(Object.values(PEOPLE).map((p) => [p.id, p]));
	const dispatcher = new Dispatcher({
		registry,
		identity: new IdentityService(
			[
				{
					name: "test",
					tierFor: async (a: PlatformActor): Promise<Tier | null> =>
						(byId.get(a.userId)?.tier as Tier | null | undefined) ?? null,
				},
			],
			[
				{
					name: "test",
					capabilitiesFor: async (a: PlatformActor) => byId.get(a.userId)?.holds ?? [],
				},
			],
		),
		rateLimiter: new RateLimiter({ capacity: 1000, refillPerSecond: 0, now: () => 0 }),
		logger,
		reporter: nullErrorReporter,
	});
	/** Presses a device's action button: `ha.act`, as the panel's button does. */
	const set = async (who: Who, device: string, state: string) => {
		const outcome = await dispatcher.act({
			actor: actor({ userId: PEOPLE[who].id }),
			action: "ha.act",
			args: { device, action: state },
		});
		if (outcome.kind === "form") throw new Error("unexpected form");
		return { reply: outcome.reply, private: outcome.reply.private ?? false, outcome };
	};
	/** `/ha device:`: one device's panel. */
	const panel = (who: Who, device: string) =>
		dispatcher.dispatch({
			actor: actor({ userId: PEOPLE[who].id }),
			command: "ha",
			args: { device },
		});
	return {
		set,
		panel,
		run,
		logger,
		reporter,
		getStates,
		callService,
		feature,
		dispatcher,
	};
}

const logged = (calls: unknown[][]) => calls.map(([fields]) => fields as Record<string, unknown>);

describe("/ha set: who may", () => {
	it("is refused to guests at the dispatcher, even one holding every capability", async () => {
		const { set, run } = setup();
		const result = await set("guestWithEverything", "lamp", "on");
		expect(result.reply.text).toBe(MESSAGES.deniedTier);
		expect(run).not.toHaveBeenCalled();
	});

	it.each<[string, Who, string, string, string]>([
		["a member with no capability", "plainMember", "lamp", "on", "capability"],
		["a Pixel admin with no capability", "plainAdmin", "lamp", "on", "capability"],
		["ha-lights on a switch", "lights", "socket", "on", "capability"],
		["ha-lights on a door", "doors", "lamp", "on", "capability"],
		["ha-switches on a light", "switches", "lamp", "off", "capability"],
		[
			"a friend with ha-lights on a device with a member floor",
			"friendLights",
			"lamp",
			"on",
			"tier",
		],
		["an action the file doesn't list", "lights", "sign", "toggle", "action"],
		["an action the kind doesn't have", "haAdmin", "lamp", "explode", "action"],
		["an action of another kind", "haAdmin", "lamp", "unlock", "action"],
		["a device with no actions", "haAdmin", "frozen", "on", "action"],
		["a sensor", "haAdmin", "temp", "on", "action"],
		["a device that doesn't exist", "haAdmin", "no-such-thing", "on", "unknown-device"],
		["an empty device", "haAdmin", "", "on", "unknown-device"],
		["a service name instead of an action", "haAdmin", "lamp", "light.turn_on", "action"],
		["a smuggled-in extra", "haAdmin", "lamp", "on; lock.unlock", "action"],
		["open/unlatch on a door", "doors", "front-door", "open", "action"],
		["lock.open as a typed service", "doors", "front-door", "lock.open", "action"],
	])(
		"refuses %s, without sending anything, with the generic answer",
		async (_label, who, device, state, reason) => {
			const { set, run, logger, callService } = setup();
			const result = await set(who, device, state);
			expect(result.reply).toEqual({ text: HOME_DENIED, private: true });
			expect(result.private).toBe(true);
			expect(run).not.toHaveBeenCalled();
			expect(callService).not.toHaveBeenCalled();
			const denied = logged(logger.warn.mock.calls).filter((f) => f.event === "home.action_denied");
			expect(denied).toHaveLength(1);
			expect(denied[0]?.reason).toBe(reason);
			// The log never holds what was typed.
			expect(JSON.stringify(denied)).not.toContain(
				state.includes("explode") || state.includes("lock.") || state.includes(";")
					? state
					: "\u0000",
			);
			expect(JSON.stringify(denied)).not.toContain("no-such-thing");
		},
	);

	it("gives the same answer for a device that doesn't exist as for one you may not use", async () => {
		const { set } = setup();
		const missing = await set("plainMember", "no-such-thing", "on");
		const forbidden = await set("plainMember", "lamp", "on");
		expect(missing.reply).toEqual(forbidden.reply);
	});

	it.each<[string, Who, string, string]>([
		["ha-lights on a light", "lights", "lamp", "toggle"],
		["ha-switches on a switch", "switches", "socket", "off"],
		["ha-admin on a light", "haAdmin", "lamp", "on"],
		["ha-admin on a switch", "haAdmin", "socket", "on"],
		["a friend with ha-lights on a friend-floor light", "friendLights", "sign", "on"],
		["a friend with ha-admin on a friend-floor light", "friendAdmin", "sign", "off"],
	])("allows %s", async (_label, who, device, state) => {
		const { set, run } = setup();
		const result = await set(who, device, state);
		expect(result.reply.embeds?.[0]?.title).toBe("✅ Done");
		expect(result.private).toBe(true);
		expect(run).toHaveBeenCalledTimes(1);
		const [calledDevice, calledAction] = run.mock.calls[0] as [{ name: string }, { name: string }];
		expect([calledDevice.name, calledAction.name]).toEqual([device, state]);
	});

	it("passes the catalogue's own action, never anything typed", async () => {
		const { set, run } = setup();
		await set("lights", "lamp", "on");
		const [, passed] = run.mock.calls[0] as [
			unknown,
			{ service: string; description: string; done: string[] },
		];
		expect(passed).toBe(HOME_KINDS.get("light")?.actions.find((a) => a.name === "on"));
		expect(passed.service).toBe("turn_on");
	});
});

describe("/ha set: doors", () => {
	it("works for someone with ha-doors or ha-admin", async () => {
		for (const who of ["doors", "haAdmin"] as const) {
			const { set, run } = setup();
			expect((await set(who, "front-door", "unlock")).reply.embeds?.[0]?.title).toBe("✅ Done");
			expect(run).toHaveBeenCalledTimes(1);
		}
	});

	it("is refused to everyone while an admin has switched doors off", async () => {
		for (const who of ["doors", "haAdmin"] as const) {
			const { set, run, logger } = setup({ doorsOff: true });
			const result = await set(who, "front-door", "unlock");
			expect(result.reply.text).toBe(
				"Controlling doors from Pixel is switched off by an admin right now.",
			);
			expect(run).not.toHaveBeenCalled();
			expect(logged(logger.warn.mock.calls)).toContainEqual({
				event: "home.action_denied",
				reason: "kind-off",
				device: "front-door",
				kind: "door",
			});
		}
	});

	it("leaves lights alone when doors are switched off", async () => {
		const { set } = setup({ doorsOff: true });
		expect((await set("lights", "lamp", "on")).reply.embeds?.[0]?.title).toBe("✅ Done");
	});

	it("says nothing about doors to someone who may not use one", async () => {
		const { set } = setup();
		expect((await set("lights", "front-door", "unlock")).reply.text).toBe(HOME_DENIED);
	});

	it("logs every door action with the device, action and outcome", async () => {
		const { set, logger } = setup();
		await set("doors", "front-door", "unlock");
		expect(logged(logger.info.mock.calls)).toContainEqual(
			expect.objectContaining({
				event: "home.action",
				device: "front-door",
				kind: "door",
				action: "unlock",
			}),
		);
	});
});

describe("/ha set: what it says", () => {
	const reply = async (result: ControlResult & { durationMs: number }, state = "") => {
		const { set } = setup({ result });
		const out = await set(
			"haAdmin",
			state === "door" ? "front-door" : "lamp",
			state === "door" ? "unlock" : "on",
		);
		expect(out.private).toBe(true);
		const embed = out.reply.embeds?.[0];
		return { title: embed?.title, text: embed?.description ?? "", accent: embed?.accent };
	};

	it("says done, with what it was and what it is now", async () => {
		expect(await reply(DONE)).toEqual({
			title: "✅ Done",
			text: "**lamp** is now `on` (it was `off`).",
			accent: "positive",
		});
	});

	it("says when it was already there, and that nothing was sent", async () => {
		const out = await reply({ outcome: "already", before: "on", durationMs: 1 });
		expect(out.title).toBe("Already there");
		expect(out.text).toBe("**lamp** is already `on`. I didn't send anything.");
	});

	it("says honestly when it's still working, and that it won't send again", async () => {
		const out = await reply({
			outcome: "in-progress",
			before: "locked",
			after: "unlocking",
			durationMs: 8000,
		});
		expect(out.title).toBe("⏳ Still working");
		expect(out.text).toContain("still `unlocking` after 8s");
		expect(out.text).toContain("won't send it again");
		expect(out.accent).toBe("warning");
	});

	it("says when nothing changed", async () => {
		const out = await reply({
			outcome: "no-change",
			before: "off",
			after: "off",
			durationMs: 8000,
		});
		expect(out.title).toBe("⚠️ Nothing changed");
		expect(out.text).toContain("still shows `off` after 8s");
	});

	it("reports a jammed lock and a device that went unavailable", async () => {
		const jam = await reply(
			{ outcome: "failed", before: "locked", after: "jammed", durationMs: 1 },
			"door",
		);
		expect(jam.title).toBe("⚠️ It didn't work");
		expect(jam.text).toContain("reports ⚠️ `jammed`");
		expect(jam.accent).toBe("negative");
		const gone = await reply({
			outcome: "failed",
			before: "off",
			after: "unavailable",
			durationMs: 1,
		});
		expect(gone.text).toContain("reports ⚠️ unavailable");
	});

	it("says it can't confirm, when it may or may not have gone through", async () => {
		const out = await reply({ outcome: "unconfirmed", before: "off", durationMs: 10_000 });
		expect(out.title).toBe("⚠️ Can't confirm");
		expect(out.text).toContain("may or may not have gone through");
	});

	it("says when Home Assistant refused, without its own words", async () => {
		const out = await reply({ outcome: "rejected", before: "off", durationMs: 5 });
		expect(out.title).toBe("⚠️ Home Assistant refused");
		expect(out.text).toContain(HOME_MESSAGES.refused);
	});

	it.each<[Extract<ControlResult, { outcome: "not-attempted" }>, string]>([
		[{ outcome: "not-attempted", reason: "busy" }, "Someone is already changing **lamp**."],
		[{ outcome: "not-attempted", reason: "cooldown" }, "**lamp** was only just changed."],
		[
			{ outcome: "not-attempted", reason: "missing" },
			"Home Assistant doesn't have **lamp** right now",
		],
		[
			{ outcome: "not-attempted", reason: "unavailable", before: "unavailable" },
			"**lamp** is ⚠️ unavailable, so I didn't send anything.",
		],
		[
			{ outcome: "not-attempted", reason: "unavailable", before: "unknown" },
			"**lamp** is ❔ unknown, so I didn't send anything.",
		],
		[
			{ outcome: "not-attempted", reason: "under-way", before: "unlocking" },
			"**lamp** is already `unlocking`, which means it's on its way.",
		],
	])("says why nothing was sent: %j", async (result, text) => {
		const out = await reply({ ...result, durationMs: 0 });
		expect(out.title).toBe("Not sent");
		expect(out.text).toContain(text);
		expect(out.accent).toBe("warning");
	});

	it("shows hostile states from Home Assistant as inert text", async () => {
		const evil = "**@everyone** [x](https://evil.example) <@123456789012345678>";
		const out = await reply({ outcome: "failed", before: evil, after: evil, durationMs: 1 });
		expect(out.text).not.toMatch(/[^`]\*\*@everyone/);
		expect(out.text.match(/`[^`]*`/g)?.length).toBe(3);
	});

	it("says plainly when Home Assistant can't be reached, having sent nothing", async () => {
		const { set } = setup({
			run: async () => {
				throw new HomeUnavailableError(HOME_MESSAGES.unreachable);
			},
		});
		const out = await set("haAdmin", "lamp", "on");
		expect(out.reply.text).toBe(HOME_MESSAGES.unreachable);
		expect(out.private).toBe(true);
	});

	it("says it isn't set up when Home Assistant isn't configured", async () => {
		const { set, run } = setup({ yaml: null });
		expect((await set("haAdmin", "lamp", "on")).reply.text).toBe(HOME_MESSAGES.notSetUp);
		expect(run).not.toHaveBeenCalled();
	});
});

describe("/ha set: the audit trail", () => {
	it("logs every action with who (from the dispatcher), the device, action, before, after, outcome and time", async () => {
		const { set, logger } = setup();
		await set("lights", "lamp", "on");
		expect(logged(logger.info.mock.calls).filter((f) => f.event === "home.action")).toEqual([
			{
				event: "home.action",
				device: "lamp",
				kind: "light",
				action: "on",
				outcome: "done",
				before: "off",
				after: "on",
				durationMs: 12,
			},
		]);
	});

	it("logs actions that weren't sent too, with the reason", async () => {
		const { set, logger } = setup({
			result: { outcome: "not-attempted", reason: "busy", durationMs: 0 },
		});
		await set("lights", "lamp", "on");
		const [entry] = logged(logger.info.mock.calls).filter((f) => f.event === "home.action");
		expect(entry).toMatchObject({ outcome: "not-attempted", reason: "busy" });
		expect(entry).not.toHaveProperty("before");
	});

	it("keeps what Home Assistant said short in the log", async () => {
		const { set, logger } = setup({
			result: { outcome: "failed", before: "x".repeat(500), after: "y".repeat(500), durationMs: 1 },
		});
		await set("lights", "lamp", "on");
		const [entry] = logged(logger.info.mock.calls).filter((f) => f.event === "home.action");
		expect(String(entry?.before)).toHaveLength(40);
		expect(String(entry?.after)).toHaveLength(40);
	});

	it("leaves a Sentry breadcrumb with who, what and the outcome", async () => {
		const { set, reporter } = setup();
		await set("lights", "lamp", "on");
		expect(reporter.breadcrumb).toHaveBeenCalledWith("home.action", "on lamp: done", {
			user: `discord:${PEOPLE.lights.id}`,
			device: "lamp",
			action: "on",
			outcome: "done",
		});
	});

	it("doesn't log or leave a breadcrumb for a refusal as if it had run", async () => {
		const { set, logger, reporter } = setup();
		await set("plainMember", "lamp", "on");
		expect(logged(logger.info.mock.calls).some((f) => f.event === "home.action")).toBe(false);
		expect(reporter.breadcrumb).not.toHaveBeenCalled();
	});
});

describe("/ha set: end to end with a fake Home Assistant", () => {
	function live(state: string, after: string | null, extra: { cooldownMs?: number } = {}) {
		let t = 0;
		let changed = false;
		const getStates = vi.fn(async (ids: readonly string[]) => {
			const current = changed ? after : state;
			return new Map(
				current === null
					? []
					: [
							[
								ids[0] as string,
								{ entityId: ids[0] as string, state: current, attributes: {}, lastChanged: null },
							],
						],
			);
		});
		const callService = vi.fn(async () => {
			changed = true;
		});
		const control = new DeviceControl({
			home: { getStates, callService },
			now: () => t,
			sleep: async (ms) => {
				t += ms;
			},
			cooldownMs: extra.cooldownMs ?? 3000,
		});
		return { control, callService, getStates };
	}

	it("unlocks a door with lock.unlock, never lock.open", async () => {
		const { control, callService } = live("locked", "unlocked");
		const { set } = setup({ control });
		const result = await set("doors", "front-door", "unlock");
		expect(result.reply.embeds?.[0]?.title).toBe("✅ Done");
		expect(callService.mock.calls).toEqual([
			[{ domain: "lock", service: "unlock", entityId: "lock.front_door" }],
		]);
	});

	it("switches a light on, calling exactly light.turn_on on its entity, and reports it", async () => {
		const { control, callService } = live("off", "on");
		const { set } = setup({ control });
		const result = await set("lights", "lamp", "on");
		expect(result.reply.embeds?.[0]?.description).toBe("**lamp** is now `on` (it was `off`).");
		expect(callService).toHaveBeenCalledTimes(1);
		expect(callService).toHaveBeenCalledWith({
			domain: "light",
			service: "turn_on",
			entityId: "light.lamp",
		});
	});

	it("says it's already on, and sends nothing", async () => {
		const { control, callService } = live("on", "on");
		const { set } = setup({ control });
		expect((await set("lights", "lamp", "on")).reply.embeds?.[0]?.title).toBe("Already there");
		expect(callService).not.toHaveBeenCalled();
	});

	it("sends one action for two quick runs", async () => {
		const { control, callService } = live("off", "on");
		const { set } = setup({ control });
		const [a, b] = await Promise.all([set("lights", "lamp", "on"), set("haAdmin", "lamp", "on")]);
		const titles = [a, b].map((r) => r.reply.embeds?.[0]?.title);
		expect(titles.sort()).toEqual(["Not sent", "✅ Done"]);
		expect(callService).toHaveBeenCalledTimes(1);
	});

	it("sends nothing to a device that's unavailable", async () => {
		const { control, callService } = live("unavailable", "unavailable");
		const { set } = setup({ control });
		expect((await set("lights", "lamp", "on")).reply.embeds?.[0]?.description).toContain(
			"didn't send anything",
		);
		expect(callService).not.toHaveBeenCalled();
	});

	it("sends nothing at all when Home Assistant can't be read", async () => {
		const { control, callService, getStates } = live("off", "on");
		getStates.mockRejectedValueOnce(new HomeUnavailableError(HOME_MESSAGES.unreachable));
		const { set } = setup({ control });
		expect((await set("lights", "lamp", "on")).reply.text).toBe(HOME_MESSAGES.unreachable);
		expect(callService).not.toHaveBeenCalled();
	});
});

describe("a device's panel", () => {
	const STATES = [
		{ entityId: "light.lamp", state: "on", attributes: {}, lastChanged: null },
		{ entityId: "lock.front_door", state: "locked", attributes: {}, lastChanged: null },
		{ entityId: "sensor.temp", state: "21", attributes: {}, lastChanged: null },
	];
	const buttons = (reply: {
		controls?: readonly (readonly { kind: string; label?: string; disabled?: boolean }[])[];
	}) =>
		(reply.controls ?? [])
			.flat()
			.map((c) => (c.kind === "button" ? `${c.label}${c.disabled ? " (off)" : ""}` : c.kind));

	it("offers a button for each action the person may take, greying out where it already is", async () => {
		const { panel } = setup({ states: STATES });
		const { reply } = await panel("lights", "lamp");
		expect(buttons(reply)).toEqual(["On (off)", "Off", "Toggle", "← All devices", "Refresh"]);
		expect(reply.private).toBe(true);
	});

	it("offers nothing to change to someone who may only look", async () => {
		const { panel } = setup({ states: STATES });
		expect(buttons((await panel("plainMember", "lamp")).reply)).toEqual([
			"← All devices",
			"Refresh",
		]);
		expect(buttons((await panel("lights", "socket")).reply)).toEqual(["← All devices", "Refresh"]);
		expect(buttons((await panel("haAdmin", "temp")).reply)).toEqual(["← All devices", "Refresh"]);
	});

	it("offers a door's lock and unlock to someone with ha-doors or ha-admin, never anything else", async () => {
		for (const who of ["doors", "haAdmin"] as const) {
			const { panel } = setup({ states: STATES });
			expect(buttons((await panel(who, "front-door")).reply)).toEqual([
				"Lock (off)",
				"Unlock",
				"← All devices",
				"Refresh",
			]);
		}
	});

	it("offers no door buttons while doors are switched off, and says why", async () => {
		const { panel } = setup({ states: STATES, doorsOff: true });
		const { reply } = await panel("doors", "front-door");
		expect(buttons(reply)).toEqual(["← All devices", "Refresh"]);
		expect(reply.embeds?.[0]?.description).toContain(
			"Controlling doors from Pixel is switched off by an admin right now.",
		);
	});

	it("shows what a button did above the device's state, and nothing for a refusal", async () => {
		const { set } = setup({ states: STATES });
		const done = await set("lights", "lamp", "off");
		expect(done.reply.embeds?.map((e) => e.title)).toEqual(["✅ Done", "lamp"]);
		expect(done.outcome.kind).toBe("update");
		const refused = await set("plainMember", "lamp", "off");
		expect(refused.outcome.kind).toBe("refused");
	});

	it("still says what happened when Home Assistant can't be read again afterwards", async () => {
		writeFileSync(join(dir, "devices.yaml"), DEVICES);
		const states = vi.fn(async () => {
			throw new HomeUnavailableError(HOME_MESSAGES.unreachable);
		});
		// The action ran (the fake control says it's done); only the re-read fails.
		const registry = new CommandRegistry();
		registry.register(
			createHomeFeature({
				home: { getStates: states, callService: async () => {} },
				homeDevices: HomeDeviceStore.open({ dir, kinds: HOME_KINDS }),
				control: { run: vi.fn(async () => DONE) as DeviceControl["run"], timeoutMs: 8000 },
			}),
		);
		const dispatcher = new Dispatcher({
			registry,
			identity: new IdentityService(
				[{ name: "t", tierFor: async () => "member" }],
				[{ name: "t", capabilitiesFor: async () => ["ha-lights"] }],
			),
			rateLimiter: new RateLimiter({ capacity: 10, refillPerSecond: 0, now: () => 0 }),
			logger: silentLogger,
			reporter: nullErrorReporter,
		});
		const outcome = await dispatcher.act({
			actor: actor({ userId: PEOPLE.lights.id }),
			action: "ha.act",
			args: { device: "lamp", action: "off" },
		});
		if (outcome.kind !== "update") throw new Error(`expected an update, got ${outcome.kind}`);
		expect(outcome.reply.embeds?.map((e) => e.title)).toEqual(["✅ Done", "lamp"]);
		expect(outcome.reply.embeds?.[1]?.description).toBe(
			`${HOME_MESSAGES.unreachable} Press **Refresh** to see its state.`,
		);
		expect(
			outcome.reply.controls?.flat().map((c) => (c.kind === "button" ? c.label : c.kind)),
		).toEqual(["← All devices", "Refresh"]);
	});

	it("still reports anything unexpected while reading it again", async () => {
		writeFileSync(join(dir, "devices.yaml"), DEVICES);
		const registry = new CommandRegistry();
		registry.register(
			createHomeFeature({
				home: {
					getStates: async () => {
						throw new Error("bug");
					},
					callService: async () => {},
				},
				homeDevices: HomeDeviceStore.open({ dir, kinds: HOME_KINDS }),
				control: { run: vi.fn(async () => DONE) as DeviceControl["run"], timeoutMs: 8000 },
			}),
		);
		const dispatcher = new Dispatcher({
			registry,
			identity: new IdentityService(
				[{ name: "t", tierFor: async () => "member" }],
				[{ name: "t", capabilitiesFor: async () => ["ha-lights"] }],
			),
			rateLimiter: new RateLimiter({ capacity: 10, refillPerSecond: 0, now: () => 0 }),
			logger: silentLogger,
			reporter: nullErrorReporter,
		});
		const outcome = await dispatcher.act({
			actor: actor({ userId: PEOPLE.lights.id }),
			action: "ha.act",
			args: { device: "lamp", action: "off" },
		});
		expect(outcome).toEqual({
			kind: "refused",
			reply: { text: MESSAGES.internalError, private: true },
		});
	});

	it("only shows a device the person may see", async () => {
		const { panel, dispatcher } = setup({ states: STATES });
		expect((await panel("plainMember", "no-such-thing")).reply).toEqual({
			text: HOME_DENIED,
			private: true,
		});
		const viaMenu = await dispatcher.act({
			actor: actor({ userId: PEOPLE.friendLights.id }),
			action: "ha.device",
			args: { device: "front-door" },
		});
		expect(viaMenu).toEqual({
			kind: "refused",
			reply: { text: HOME_DENIED, private: true },
			problem: true,
		});
	});

	it("says it isn't set up, from the command and from every button", async () => {
		const { panel, dispatcher } = setup({ yaml: null });
		expect((await panel("lights", "lamp")).reply.text).toBe(HOME_MESSAGES.notSetUp);
		for (const [action, args] of [
			["ha.list", {}],
			["ha.device", { device: "lamp" }],
			["ha.act", { device: "lamp", action: "on" }],
		] as const) {
			const outcome = await dispatcher.act({
				actor: actor({ userId: PEOPLE.lights.id }),
				action,
				args,
			});
			expect(outcome.kind === "update" && outcome.reply.text).toBe(HOME_MESSAGES.notSetUp);
		}
	});
});

describe("the list's menu", () => {
	it("offers only the devices the person may see, with their kind and state as plain text", async () => {
		const { dispatcher } = setup({
			states: [
				{ entityId: "light.lamp", state: "on", attributes: {}, lastChanged: null },
				{
					entityId: "sensor.temp",
					state: "21.456",
					attributes: { unit_of_measurement: "°C" },
					lastChanged: null,
				},
			],
		});
		const { reply } = await dispatcher.dispatch({
			actor: actor({ userId: PEOPLE.lights.id }),
			command: "ha",
			args: {},
		});
		const menu = reply.controls?.[0]?.[0];
		expect(menu?.kind === "select" && menu.options.map((o) => [o.value, o.description])).toEqual([
			["lamp", "Light · on"],
			["sign", "Light · not in Home Assistant"],
			["socket", "Switch · not in Home Assistant"],
			["frozen", "Light · not in Home Assistant"],
			["front-door", "Door · not in Home Assistant"],
			["temp", "Sensor · 21.46 °C"],
		]);
		expect(menu?.kind === "select" && menu.call.action).toBe("ha.device");
	});

	it("pages past 25 devices", async () => {
		const many = Array.from(
			{ length: 30 },
			(_, i) => `  - name: lamp-${i}\n    entity: light.l${i}\n    kind: light\n`,
		).join("");
		const { dispatcher } = setup({ yaml: `devices:\n${many}` });
		const page = (n: number) =>
			dispatcher.act({
				actor: actor({ userId: PEOPLE.lights.id }),
				action: "ha.list",
				args: { page: n },
			});
		const second = await page(1);
		const reply = second.kind === "update" ? second.reply : undefined;
		const menu = reply?.controls?.[0]?.[0];
		expect(menu?.kind === "select" && menu.options).toHaveLength(5);
		expect(
			reply?.controls?.[1]?.map((c) => (c.kind === "button" ? [c.label, c.disabled] : [])),
		).toEqual([
			["‹ Previous", undefined],
			["Next ›", true],
		]);
	});
});
