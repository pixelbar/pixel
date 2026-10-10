import { describe, expect, it } from "vitest";
import { type Principal, TIERS, type Tier } from "./access.ts";
import { CapabilityRegistry } from "./capabilities.ts";
import {
	type AccessibleDevice,
	actionableDevices,
	canActOnDevice,
	canViewDevice,
	HA_ADMIN,
	HOME_DENIED,
	homeCapabilities,
	visibleDevices,
} from "./home-access.ts";
import { defineKinds, HOME_KINDS } from "./home-kinds/index.ts";

const person = (tier: Tier, capabilities: string[] = []): Principal => ({
	platform: "discord",
	userId: "100000000000000001",
	displayName: "Someone",
	chat: "group",
	tier,
	capabilities,
});

const device = (
	kind: string,
	extra: Partial<AccessibleDevice> = {},
	actions = ["on", "off"],
): AccessibleDevice => ({
	minTier: "member",
	kind: { capability: HOME_KINDS.get(kind)?.capability },
	actions: actions.map((name) => ({ name })),
	...extra,
});

describe("the Home Assistant capabilities", () => {
	it("are ha-admin and one per kind that can be controlled, from the kinds themselves", () => {
		expect(homeCapabilities(HOME_KINDS).map((c) => c.name)).toEqual([
			"ha-admin",
			"ha-lights",
			"ha-switches",
			"ha-doors",
		]);
	});

	it("all have a description, and fit in a registry", () => {
		const definitions = homeCapabilities(HOME_KINDS);
		for (const definition of definitions) {
			expect(definition.description.length).toBeGreaterThan(0);
			expect(definition.description.length).toBeLessThanOrEqual(100);
		}
		expect(() => new CapabilityRegistry(definitions)).not.toThrow();
	});

	it("include a new kind's capability without anything else changing", () => {
		const kinds = defineKinds([
			...HOME_KINDS.values(),
			{
				name: "blind",
				description: "A blind",
				domains: ["cover"],
				capability: { name: "ha-blinds", description: "Move the blinds" },
				actions: [
					{ name: "close", description: "Close", service: "close_cover", done: ["closed"] },
				],
			},
		]);
		expect(homeCapabilities(kinds).map((c) => c.name)).toContain("ha-blinds");
	});
});

describe("viewing a device", () => {
	it.each<[Tier, "member" | "admin" | "friend", boolean]>([
		["guest", "member", false],
		["friend", "member", false],
		["member", "member", true],
		["admin", "member", true],
		["member", "admin", false],
		["admin", "admin", true],
		["friend", "friend", true],
		["guest", "friend", false],
	])("a %s may view a device with a %s floor: %s", (tier, floor, allowed) => {
		expect(canViewDevice(device("light", { minTier: floor }), person(tier)).allowed).toBe(allowed);
	});

	it("needs no capability, and a guest never passes whatever they hold", () => {
		expect(canViewDevice(device("door"), person("member")).allowed).toBe(true);
		expect(canViewDevice(device("door"), person("guest", [HA_ADMIN, "ha-doors"]))).toEqual({
			allowed: false,
			reason: "tier",
		});
	});
});

describe("acting on a device: every combination", () => {
	const holdings: [string, string[]][] = [
		["nothing", []],
		["ha-admin", [HA_ADMIN]],
		["the kind's capability", ["ha-lights"]],
		["another kind's capability", ["ha-doors", "ha-switches"]],
		["both", [HA_ADMIN, "ha-lights"]],
	];
	const holdsEnough = (held: string[]) => held.includes(HA_ADMIN) || held.includes("ha-lights");

	for (const floor of ["friend", "member", "admin"] as const) {
		for (const tier of TIERS) {
			for (const [label, held] of holdings) {
				const tierOk = tier !== "guest" && TIERS.indexOf(tier) >= TIERS.indexOf(floor);
				const expected = tierOk && holdsEnough(held);
				it(`a ${tier} holding ${label} on a light with a ${floor} floor: ${expected ? "allowed" : "refused"}`, () => {
					const decision = canActOnDevice(
						device("light", { minTier: floor }),
						"on",
						person(tier, held),
					);
					expect(decision.allowed).toBe(expected);
					if (!expected) {
						expect(decision).toEqual({
							allowed: false,
							reason: tierOk ? "capability" : "tier",
						});
					}
				});
			}
		}
	}

	it("refuses a Pixel admin who holds no capability: being an admin isn't one", () => {
		expect(canActOnDevice(device("light"), "on", person("admin"))).toEqual({
			allowed: false,
			reason: "capability",
		});
	});

	it("refuses a guest who holds ha-admin, and one who holds the kind's capability", () => {
		for (const held of [[HA_ADMIN], ["ha-lights"], [HA_ADMIN, "ha-lights"]]) {
			expect(canActOnDevice(device("light"), "on", person("guest", held))).toEqual({
				allowed: false,
				reason: "tier",
			});
		}
	});

	it("lets ha-lights act on lights, but not on a switch or a door", () => {
		const lights = person("member", ["ha-lights"]);
		expect(canActOnDevice(device("light"), "on", lights).allowed).toBe(true);
		expect(canActOnDevice(device("switch"), "on", lights).allowed).toBe(false);
		expect(canActOnDevice(device("door", {}, ["lock", "unlock"]), "unlock", lights).allowed).toBe(
			false,
		);
	});

	it("lets ha-admin act on every kind", () => {
		const admin = person("member", [HA_ADMIN]);
		for (const [kind, action] of [
			["light", "on"],
			["switch", "off"],
			["door", "lock"],
		] as const) {
			expect(canActOnDevice(device(kind, {}, [action]), action, admin).allowed).toBe(true);
		}
	});

	it("only allows the actions the devices file lists", () => {
		const lights = person("member", ["ha-lights"]);
		expect(canActOnDevice(device("light", {}, ["on"]), "on", lights).allowed).toBe(true);
		expect(canActOnDevice(device("light", {}, ["on"]), "off", lights)).toEqual({
			allowed: false,
			reason: "action",
		});
		expect(canActOnDevice(device("light", {}, ["on"]), "launch", lights).allowed).toBe(false);
		// Even ha-admin can't do what the file doesn't allow.
		expect(canActOnDevice(device("light", {}, []), "on", person("admin", [HA_ADMIN])).allowed).toBe(
			false,
		);
	});

	it("does not treat open/unlatch as an allowed door action", () => {
		const doors = person("member", ["ha-doors"]);
		const front = device("door", {}, ["lock", "unlock"]);
		expect(canActOnDevice(front, "unlock", doors).allowed).toBe(true);
		expect(canActOnDevice(front, "lock", doors).allowed).toBe(true);
		expect(canActOnDevice(front, "open", doors)).toEqual({ allowed: false, reason: "action" });
		expect(actionableDevices([{ name: "front-door", ...front }], doors, "open")).toEqual([]);
		expect(HOME_KINDS.get("door")?.actions.some((a) => a.name === "open")).toBe(false);
	});

	it("keeps a read-only kind read-only: a sensor has no capability, and ha-admin alone doesn't help", () => {
		const sensor = device("sensor", {}, []);
		expect(sensor.kind.capability).toBeUndefined();
		expect(canActOnDevice(sensor, "on", person("admin", [HA_ADMIN])).allowed).toBe(false);
	});

	it("checks the tier before anything else, so a lower tier is told 'tier'", () => {
		expect(canActOnDevice(device("light", { minTier: "admin" }), "nope", person("member"))).toEqual(
			{
				allowed: false,
				reason: "tier",
			},
		);
	});

	it("takes a demotion at once: the same person, now a guest, is refused", () => {
		const held = [HA_ADMIN, "ha-lights"];
		expect(canActOnDevice(device("light"), "on", person("member", held)).allowed).toBe(true);
		expect(canActOnDevice(device("light"), "on", person("guest", held)).allowed).toBe(false);
	});
});

describe("refusals", () => {
	it("use one message that says nothing about the device, its kind or the missing capability", () => {
		expect(HOME_DENIED).not.toMatch(/capabilit|ha-|light|door|switch|tier|member|admin/i);
	});
});

describe("listing devices for autocomplete and /ha list", () => {
	const lamp = { name: "lamp", ...device("light") };
	const socket = { name: "socket", ...device("switch") };
	const front = { name: "front-door", ...device("door", { minTier: "admin" }, ["lock", "unlock"]) };
	const temp = { name: "temp", ...device("sensor", {}, []) };
	const friendly = { name: "sign", ...device("light", { minTier: "friend" }) };
	const all = [lamp, socket, front, temp, friendly];

	it("shows what the tier floor allows, with no capability needed", () => {
		expect(visibleDevices(all, person("guest")).map((d) => d.name)).toEqual([]);
		expect(visibleDevices(all, person("friend")).map((d) => d.name)).toEqual(["sign"]);
		expect(visibleDevices(all, person("member")).map((d) => d.name)).toEqual([
			"lamp",
			"socket",
			"temp",
			"sign",
		]);
		expect(visibleDevices(all, person("admin")).map((d) => d.name)).toEqual([
			"lamp",
			"socket",
			"front-door",
			"temp",
			"sign",
		]);
	});

	it("offers for an action only what the person could run, by the same rule", () => {
		const lights = person("member", ["ha-lights"]);
		expect(actionableDevices(all, lights).map((d) => d.name)).toEqual(["lamp", "sign"]);
		expect(actionableDevices(all, lights, "on").map((d) => d.name)).toEqual(["lamp", "sign"]);
		expect(actionableDevices(all, lights, "lock")).toEqual([]);
		expect(
			actionableDevices(all, person("admin", [HA_ADMIN]), "unlock").map((d) => d.name),
		).toEqual(["front-door"]);
		expect(actionableDevices(all, person("admin"))).toEqual([]);
		expect(actionableDevices(all, person("guest", [HA_ADMIN]))).toEqual([]);
	});

	it("agrees with canActOnDevice for every device, person and action", () => {
		const people = [
			person("guest", [HA_ADMIN]),
			person("friend", ["ha-lights"]),
			person("member"),
			person("member", ["ha-lights"]),
			person("member", ["ha-doors"]),
			person("admin", [HA_ADMIN]),
		];
		for (const who of people) {
			for (const action of ["on", "off", "lock", "unlock", "open"]) {
				const offered = new Set(actionableDevices(all, who, action).map((d) => d.name));
				for (const d of all) {
					expect(offered.has(d.name)).toBe(canActOnDevice(d, action, who).allowed);
				}
			}
		}
	});
});
