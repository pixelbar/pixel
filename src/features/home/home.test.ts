import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformActor } from "../../core/access.ts";
import { Dispatcher, MESSAGES } from "../../core/dispatcher.ts";
import { type EntityState, HOME_MESSAGES, HomeUnavailableError } from "../../core/home.ts";
import { HOME_DENIED } from "../../core/home-access.ts";
import { HOME_KINDS } from "../../core/home-kinds/index.ts";
import { IdentityService } from "../../core/identity.ts";
import { silentLogger } from "../../core/logger.ts";
import { nullErrorReporter } from "../../core/ports/error-reporter.ts";
import { RateLimiter } from "../../core/rate-limit.ts";
import { CommandRegistry } from "../../core/registry.ts";
import { HomeDeviceStore } from "../../services/home-devices.ts";
import { actor, IDS } from "../../testing/fixtures.ts";
import { createHomeFeature, describeState } from "./index.ts";

const NOW = new Date("2026-10-04T12:00:00Z");

const DEVICES = `devices:
  - name: sign
    entity: light.sign
    kind: light
    actions: [on, off]
    minTier: friend
    description: The sign by the door
  - name: lamp
    entity: light.lamp
    kind: light
    actions: [on, off, toggle]
  - name: socket
    entity: switch.socket
    kind: switch
    actions: [on, off]
  - name: front-door
    entity: lock.front_door
    kind: door
    actions: [lock, unlock]
    minTier: admin
  - name: temp
    entity: sensor.temp
    kind: sensor
`;

const TIERS: Record<string, "admin" | "member" | "friend"> = {
	[IDS.admin]: "admin",
	[IDS.member]: "member",
	[IDS.friend]: "friend",
};

const entity = (
	entityId: string,
	state: string,
	attributes: Record<string, unknown> = {},
	lastChanged: Date | null = new Date("2026-10-04T10:00:00Z"),
): EntityState => ({ entityId, state, attributes, lastChanged });

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pixel-home-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(
	states: EntityState[] = [],
	options: {
		yaml?: string | null;
		getStates?: (ids: readonly string[]) => Promise<Map<string, EntityState>>;
	} = {},
) {
	let devices = HomeDeviceStore.empty();
	if (options.yaml !== null) {
		writeFileSync(join(dir, "devices.yaml"), options.yaml ?? DEVICES);
		devices = HomeDeviceStore.open({ dir, kinds: HOME_KINDS });
	}
	const getStates = vi.fn(
		options.getStates ??
			(async (ids: readonly string[]) =>
				new Map(states.filter((s) => ids.includes(s.entityId)).map((s) => [s.entityId, s]))),
	);
	const logger = { ...silentLogger, info: vi.fn(), warn: vi.fn() };
	logger.child = () => logger;
	const registry = new CommandRegistry();
	registry.register(
		createHomeFeature({ home: { getStates }, homeDevices: devices, now: () => NOW }),
	);
	const dispatcher = new Dispatcher({
		registry,
		identity: new IdentityService([
			{ name: "test", tierFor: async (a: PlatformActor) => TIERS[a.userId] ?? null },
		]),
		rateLimiter: new RateLimiter({ capacity: 1000, refillPerSecond: 0, now: () => 0 }),
		logger,
		reporter: nullErrorReporter,
	});
	const list = (userId: string) =>
		dispatcher.dispatch({
			actor: actor({ userId }),
			command: "ha",
			subcommand: "list",
			args: {},
		});
	const status = (userId: string, device: string) =>
		dispatcher.dispatch({
			actor: actor({ userId }),
			command: "ha",
			subcommand: "status",
			args: { device },
		});
	const suggest = (userId: string, typed = "") =>
		dispatcher.suggest({
			actor: actor({ userId }),
			command: "ha",
			subcommand: "status",
			option: "device",
			typed,
			args: {},
		});
	return { list, status, suggest, getStates, logger };
}

const fields = (embed: { fields?: { name: string; value: string }[] } | undefined) =>
	Object.fromEntries((embed?.fields ?? []).map((f) => [f.name, f.value]));

const ALL = [
	entity("light.sign", "on", { brightness: 128 }),
	entity("light.lamp", "off"),
	entity("switch.socket", "unavailable"),
	entity("lock.front_door", "locked"),
	entity("sensor.temp", "21.5", { unit_of_measurement: "°C" }),
];

describe("/ha list", () => {
	it("is refused to guests at the dispatcher, whatever they hold", async () => {
		const { list, getStates } = setup(ALL);
		const result = await list(IDS.guest);
		expect(result.reply.text).toBe(MESSAGES.deniedTier);
		expect(getStates).not.toHaveBeenCalled();
	});

	it("shows only the devices the caller may use, grouped by kind, privately", async () => {
		const { list } = setup(ALL);
		const friend = await list(IDS.friend);
		expect(friend.private).toBe(true);
		expect(fields(friend.reply.embeds?.[0])).toEqual({ "Light · 1": "**sign** `on`" });

		const member = await list(IDS.member);
		expect(fields(member.reply.embeds?.[0])).toEqual({
			"Light · 2": "**sign** `on`\n**lamp** `off`",
			"Switch · 1": "**socket** ⚠️ unavailable",
			"Sensor · 1": "**temp** `21.5 °C`",
		});

		const admin = await list(IDS.admin);
		expect(fields(admin.reply.embeds?.[0])["Door · 1"]).toBe("**front-door** `locked`");
	});

	it("asks Home Assistant fresh every time, and only about the devices it will show", async () => {
		const { list, getStates } = setup(ALL);
		await list(IDS.friend);
		await list(IDS.friend);
		expect(getStates).toHaveBeenCalledTimes(2);
		expect(getStates).toHaveBeenCalledWith(["light.sign"]);
	});

	it("shows unavailable and unknown as themselves, never as off, and a missing entity as missing", async () => {
		const { list } = setup([
			entity("light.sign", "unknown"),
			entity("switch.socket", "unavailable"),
			// light.lamp, sensor.temp: not in Home Assistant at all
		]);
		const text = JSON.stringify((await list(IDS.member)).reply);
		expect(text).toContain("❔ unknown");
		expect(text).toContain("⚠️ unavailable");
		expect(text).toContain("**lamp** ❔ not in Home Assistant");
		expect(text).not.toContain("`off`");
	});

	it("shows hostile values from Home Assistant as inert text", async () => {
		const evil = "**@everyone** [click](https://evil.example) <@123456789012345678> # x\n- y `z`";
		const { list } = setup([
			entity("light.sign", evil),
			entity("sensor.temp", "5", { unit_of_measurement: evil }),
		]);
		const reply = await list(IDS.member);
		const text = JSON.stringify(reply.reply);
		// Everything from Home Assistant sits inside a code span, which has no backticks of its own.
		expect(fields(reply.reply.embeds?.[0])["Light · 2"]).toMatch(/^\*\*sign\*\* `[^`]+`\n/);
		expect(text).not.toContain("`z`");
		for (const f of reply.reply.embeds?.[0]?.fields ?? []) {
			for (const line of f.value.split("\n")) {
				expect(line.replace(/^\*\*[a-z-]+\*\* /, "")).toMatch(
					/^(`[^`]*`|⚠️ unavailable|❔ [A-Za-z ]+)$/,
				);
			}
		}
	});

	it("keeps a long list within the size limit, saying how many it left out", async () => {
		const many = Array.from(
			{ length: 150 },
			(_, i) => `  - name: lamp-${i}\n    entity: light.l${i}\n    kind: light\n`,
		).join("");
		const { list } = setup(
			Array.from({ length: 150 }, (_, i) => entity(`light.l${i}`, "on")),
			{ yaml: `devices:\n${many}` },
		);
		const field = (await list(IDS.member)).reply.embeds?.[0]?.fields?.[0];
		expect(field?.name).toBe("Light · 150");
		expect(field?.value.length).toBeLessThanOrEqual(1024);
		expect(field?.value).toMatch(/…and \d+ more\.$/);
	});

	it("says so plainly when nothing is available to the caller", async () => {
		const { list } = setup(ALL, {
			yaml: "devices:\n  - name: door\n    entity: lock.d\n    kind: door\n    minTier: admin\n",
		});
		expect((await list(IDS.member)).reply.text).toBe("There are no devices available to you.");
	});

	it("says it isn't set up when Home Assistant isn't configured", async () => {
		const { list, getStates } = setup(ALL, { yaml: null });
		const result = await list(IDS.admin);
		expect(result.reply.text).toBe(HOME_MESSAGES.notSetUp);
		expect(result.private).toBe(true);
		expect(getStates).not.toHaveBeenCalled();
	});

	it("tells people plainly when Home Assistant can't be reached", async () => {
		const { list } = setup([], {
			getStates: async () => {
				throw new HomeUnavailableError(HOME_MESSAGES.unreachable);
			},
		});
		const result = await list(IDS.member);
		expect(result.reply.text).toBe(HOME_MESSAGES.unreachable);
		expect(result.private).toBe(true);
	});
});

describe("/ha status", () => {
	it("shows the live state, when it changed, and the useful attributes for the kind", async () => {
		const { status } = setup(ALL);
		const result = await status(IDS.member, "sign");
		expect(result.private).toBe(true);
		const embed = result.reply.embeds?.[0];
		expect(embed?.title).toBe("sign");
		expect(embed?.description).toBe("The sign by the door");
		expect(fields(embed)).toEqual({
			State: "`on`",
			Kind: "Light",
			"Last changed": "2h 0m ago",
			Brightness: "50%",
		});
		expect(embed?.accent).toBe("brand");
	});

	it("rounds a long reading to two decimals, and leaves other text alone", async () => {
		const { status } = setup([
			entity("sensor.temp", "23.7000007629395", { unit_of_measurement: "°C" }),
		]);
		expect(fields((await status(IDS.member, "temp")).reply.embeds?.[0]).State).toBe("`23.7 °C`");
		const text = setup([entity("sensor.temp", "1.2.3", { unit_of_measurement: "x" })]);
		expect(fields((await text.status(IDS.member, "temp")).reply.embeds?.[0]).State).toBe(
			"`1.2.3 x`",
		);
		const big = setup([entity("sensor.temp", "-0.004")]);
		expect(fields((await big.status(IDS.member, "temp")).reply.embeds?.[0]).State).toBe("`0`");
	});

	it("shows a sensor's reading with its unit, and its battery", async () => {
		const { status } = setup([
			entity("sensor.temp", "21.5", {
				unit_of_measurement: "°C",
				device_class: "temperature",
				battery_level: 87.26,
			}),
		]);
		expect(fields((await status(IDS.member, "temp")).reply.embeds?.[0])).toMatchObject({
			State: "`21.5 °C`",
			Type: "`temperature`",
			Battery: "87.3%",
		});
	});

	it("leaves out attributes that are missing or the wrong sort of value", async () => {
		const { status } = setup([
			entity("light.lamp", "on", { brightness: "very" }),
			entity("sensor.temp", "1", { device_class: 5, battery_level: Number.NaN }),
		]);
		expect(Object.keys(fields((await status(IDS.member, "lamp")).reply.embeds?.[0]))).toEqual([
			"State",
			"Kind",
			"Last changed",
		]);
		expect(Object.keys(fields((await status(IDS.member, "temp")).reply.embeds?.[0]))).toEqual([
			"State",
			"Kind",
			"Last changed",
		]);
	});

	it("clamps brightness to a percentage", async () => {
		const { status } = setup([entity("light.lamp", "on", { brightness: 999 })]);
		expect(fields((await status(IDS.member, "lamp")).reply.embeds?.[0]).Brightness).toBe("100%");
	});

	it("warns about a jammed lock, an unavailable device and an unknown one", async () => {
		const jam = setup([entity("lock.front_door", "jammed")]);
		const jammed = (await jam.status(IDS.admin, "front-door")).reply.embeds?.[0];
		expect(fields(jammed).State).toBe("⚠️ `jammed`");
		expect(jammed?.accent).toBe("warning");

		const gone = setup([entity("light.lamp", "unavailable")]);
		const unavailable = (await gone.status(IDS.member, "lamp")).reply.embeds?.[0];
		expect(fields(unavailable).State).toBe("⚠️ unavailable");
		expect(unavailable?.accent).toBe("warning");

		const unk = setup([entity("light.lamp", "unknown")]);
		expect(fields((await unk.status(IDS.member, "lamp")).reply.embeds?.[0]).State).toBe(
			"❔ unknown",
		);
	});

	it("says when Home Assistant doesn't have the entity right now", async () => {
		const { status } = setup([]);
		const embed = (await status(IDS.member, "lamp")).reply.embeds?.[0];
		expect(fields(embed).State).toBe("❔ not in Home Assistant right now");
		expect(embed?.accent).toBe("warning");
	});

	it("shows an unknown change time as unknown", async () => {
		const { status } = setup([entity("light.lamp", "on", {}, null)]);
		expect(fields((await status(IDS.member, "lamp")).reply.embeds?.[0])["Last changed"]).toBe(
			"unknown",
		);
	});

	it("shows hostile attributes from Home Assistant as inert text", async () => {
		const evil = "**@everyone** [x](https://evil.example) <@123456789012345678>\n# heading";
		const { status } = setup([
			entity("sensor.temp", evil, { device_class: evil, unit_of_measurement: evil }),
		]);
		const embed = (await status(IDS.member, "temp")).reply.embeds?.[0];
		for (const value of [fields(embed).State, fields(embed).Type]) {
			expect(value).toMatch(/^`[^`\n]*`$/);
		}
	});

	it("reads fresh each time", async () => {
		const { status, getStates } = setup(ALL);
		await status(IDS.member, "lamp");
		await status(IDS.member, "lamp");
		expect(getStates).toHaveBeenCalledTimes(2);
		expect(getStates).toHaveBeenCalledWith(["light.lamp"]);
	});

	it("refuses an unknown device, and one the caller may not see, with exactly the same answer", async () => {
		const { status, getStates, logger } = setup(ALL);
		const unknown = await status(IDS.member, "no-such-thing");
		const tooHigh = await status(IDS.member, "front-door");
		const friendAndMember = await status(IDS.friend, "lamp");
		for (const result of [unknown, tooHigh, friendAndMember]) {
			expect(result.reply).toEqual({ text: HOME_DENIED, private: true });
			expect(result.private).toBe(true);
		}
		expect(getStates).not.toHaveBeenCalled();
		// The log has the real reasons, and not what was typed.
		const logged = logger.warn.mock.calls.map(([fields]) => fields);
		expect(logged).toEqual([
			{ event: "home.status_denied", reason: "unknown-device" },
			{ event: "home.status_denied", reason: "tier", device: "front-door" },
			{ event: "home.status_denied", reason: "tier", device: "lamp" },
		]);
		expect(JSON.stringify(logged)).not.toContain("no-such-thing");
	});

	it("is refused to guests at the dispatcher", async () => {
		const { status, getStates } = setup(ALL);
		expect((await status(IDS.guest, "sign")).reply.text).toBe(MESSAGES.deniedTier);
		expect(getStates).not.toHaveBeenCalled();
	});

	it("logs who looked at a door, and not at a light", async () => {
		const { status, logger } = setup(ALL);
		await status(IDS.admin, "front-door");
		await status(IDS.member, "lamp");
		const viewed = logger.info.mock.calls
			.map(([fields]) => fields)
			.filter((fields) => fields.event === "home.status_viewed");
		expect(viewed).toEqual([{ event: "home.status_viewed", device: "front-door", kind: "door" }]);
	});

	it("tells people plainly when Home Assistant can't be reached", async () => {
		const { status } = setup([], {
			getStates: async () => {
				throw new HomeUnavailableError(HOME_MESSAGES.unreachable);
			},
		});
		expect((await status(IDS.member, "lamp")).reply.text).toBe(HOME_MESSAGES.unreachable);
	});

	it("says it isn't set up when Home Assistant isn't configured", async () => {
		const { status } = setup(ALL, { yaml: null });
		expect((await status(IDS.admin, "lamp")).reply.text).toBe(HOME_MESSAGES.notSetUp);
	});
});

describe("autocomplete for /ha status", () => {
	it("suggests only what the caller may see, and never asks Home Assistant", async () => {
		const { suggest, getStates } = setup(ALL);
		expect((await suggest(IDS.friend)).map((s) => s.value)).toEqual(["sign"]);
		expect((await suggest(IDS.member)).map((s) => s.value)).toEqual([
			"lamp",
			"sign",
			"socket",
			"temp",
		]);
		expect((await suggest(IDS.admin)).map((s) => s.value)).toEqual([
			"front-door",
			"lamp",
			"sign",
			"socket",
			"temp",
		]);
		expect(getStates).not.toHaveBeenCalled();
	});

	it("gives a guest nothing", async () => {
		const { suggest } = setup(ALL);
		expect(await suggest(IDS.guest)).toEqual([]);
	});

	it("matches what was typed in the name or the description, best matches first", async () => {
		const { suggest } = setup(ALL);
		expect((await suggest(IDS.member, "SO")).map((s) => s.value)).toEqual(["socket"]);
		expect((await suggest(IDS.member, "by the door")).map((s) => s.value)).toEqual(["sign"]);
		expect((await suggest(IDS.member, "m")).map((s) => s.value)).toEqual(["lamp", "temp"]);
		// A name that starts with what was typed comes before ones that only contain it.
		expect((await suggest(IDS.member, "t")).map((s) => s.value)).toEqual([
			"temp",
			"sign",
			"socket",
		]);
		expect(await suggest(IDS.member, "zzz")).toEqual([]);
	});

	it("shows each device with its kind and description, and submits just the name", async () => {
		const { suggest } = setup(ALL);
		expect((await suggest(IDS.friend))[0]).toEqual({
			name: "sign (light) · The sign by the door",
			value: "sign",
		});
	});

	it("offers at most 25, nothing for a device that isn't there, and nothing when not set up", async () => {
		const many = Array.from(
			{ length: 40 },
			(_, i) =>
				`  - name: lamp-${String(i).padStart(2, "0")}\n    entity: light.l${i}\n    kind: light\n`,
		).join("");
		expect((await setup([], { yaml: `devices:\n${many}` }).suggest(IDS.member)).length).toBe(25);
		expect(await setup([], { yaml: null }).suggest(IDS.admin)).toEqual([]);
	});

	it("is only a convenience: the command checks again", async () => {
		const { status } = setup(ALL);
		// Not something a person could have been offered, but Discord doesn't stop them submitting it.
		expect((await status(IDS.friend, "front-door")).reply.text).toBe(HOME_DENIED);
	});
});

describe("describeState", () => {
	it("marks states that aren't a reading, case-insensitively, and shows the rest as code", () => {
		expect(describeState("Unavailable")).toBe("⚠️ unavailable");
		expect(describeState("UNKNOWN")).toBe("❔ unknown");
		expect(describeState("jammed", ["jammed"])).toBe("⚠️ `jammed`");
		expect(describeState("jammed")).toBe("`jammed`");
		expect(describeState("on")).toBe("`on`");
		expect(describeState("x".repeat(100))).toHaveLength(42);
	});
});
