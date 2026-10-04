import { describe, expect, it } from "vitest";
import { defineKinds, HOME_KINDS, type HomeKind, HomeKindError } from "./index.ts";

const kind = (overrides: Partial<HomeKind> = {}): HomeKind => ({
	name: "blind",
	description: "A blind",
	domains: ["cover"],
	capability: "ha-blinds",
	actions: [
		{
			name: "close",
			description: "Close the blind",
			service: "close_cover",
			done: ["closed"],
			working: ["closing"],
		},
	],
	...overrides,
});

describe("the built-in kinds", () => {
	it("are light, switch, door and sensor", () => {
		expect([...HOME_KINDS.keys()]).toEqual(["light", "switch", "door", "sensor"]);
	});

	it.each([
		["light", ["light"], ["on", "off", "toggle"], "ha-lights"],
		["switch", ["switch"], ["on", "off", "toggle"], "ha-switches"],
		["door", ["lock"], ["lock", "unlock", "open"], "ha-doors"],
	])("%s offers its actions and names its capability", (name, domains, actions, capability) => {
		const found = HOME_KINDS.get(name);
		expect(found?.domains).toEqual(domains);
		expect(found?.actions.map((a) => a.name)).toEqual(actions);
		expect(found?.capability).toBe(capability);
	});

	it("makes a sensor read-only, with no capability to grant", () => {
		const sensor = HOME_KINDS.get("sensor");
		expect(sensor?.actions).toEqual([]);
		expect(sensor?.capability).toBeUndefined();
		expect(sensor?.domains).toEqual(["sensor", "binary_sensor"]);
	});

	it("calls the right service for each door action, and knows when it's done", () => {
		const door = HOME_KINDS.get("door");
		const by = (name: string) => door?.actions.find((a) => a.name === name);
		expect(by("lock")).toMatchObject({ service: "lock", done: ["locked"], working: ["locking"] });
		expect(by("unlock")).toMatchObject({
			service: "unlock",
			done: ["unlocked"],
			working: ["unlocking"],
		});
		expect(by("open")).toMatchObject({ service: "open", done: ["open"], working: ["opening"] });
	});

	it("lets a toggle end in either state", () => {
		expect(HOME_KINDS.get("light")?.actions.find((a) => a.name === "toggle")?.done).toEqual([
			"on",
			"off",
		]);
	});

	it("has a distinct capability for every kind that can change things", () => {
		const capabilities = [...HOME_KINDS.values()].flatMap((k) =>
			k.capability ? [k.capability] : [],
		);
		expect(new Set(capabilities).size).toBe(capabilities.length);
		for (const k of HOME_KINDS.values()) {
			if (k.actions.length > 0) expect(k.capability).toMatch(/^ha-[a-z-]+$/);
		}
	});
});

describe("defineKinds", () => {
	it("accepts a new kind, which is all it takes to add one", () => {
		const kinds = defineKinds([kind()]);
		expect(kinds.get("blind")?.actions[0]?.service).toBe("close_cover");
	});

	it("rejects every kind of mistake, naming the kind and action", () => {
		const bad: [string, HomeKind, RegExp][] = [
			["a bad name", kind({ name: "Blind" }), /Invalid name for kind "Blind"/],
			["no description", kind({ description: "" }), /Description must be 1–100/],
			["no domains", kind({ domains: [] }), /valid Home Assistant domains/],
			["a bad domain", kind({ domains: ["Cover!"] }), /valid Home Assistant domains/],
			[
				"a repeated action",
				kind({
					actions: [
						{ name: "close", description: "d", service: "close_cover", done: ["closed"] },
						{ name: "close", description: "d", service: "close_cover", done: ["closed"] },
					],
				}),
				/Duplicate action "close" of kind "blind"/,
			],
			[
				"a bad action name",
				kind({ actions: [{ name: "Close It", description: "d", service: "x", done: ["closed"] }] }),
				/Invalid name for action "Close It"/,
			],
			[
				"a bad service",
				kind({
					actions: [{ name: "close", description: "d", service: "Close!", done: ["closed"] }],
				}),
				/Invalid service for action "close"/,
			],
			[
				"a bad service domain",
				kind({
					actions: [
						{
							name: "close",
							description: "d",
							service: "x",
							serviceDomain: "Bad!",
							done: ["closed"],
						},
					],
				}),
				/Invalid service domain/,
			],
			[
				"no description on an action",
				kind({ actions: [{ name: "close", description: "", service: "x", done: ["closed"] }] }),
				/Description must be 1–100 characters for action "close"/,
			],
			[
				"no done state",
				kind({ actions: [{ name: "close", description: "d", service: "x", done: [] }] }),
				/valid done states/,
			],
			[
				"a working state that is also done",
				kind({
					actions: [
						{
							name: "close",
							description: "d",
							service: "x",
							done: ["closed"],
							working: ["closed"],
						},
					],
				}),
				/working state that is invalid or also a done state/,
			],
			[
				"a working state that is invalid",
				kind({
					actions: [
						{ name: "close", description: "d", service: "x", done: ["closed"], working: ["No!"] },
					],
				}),
				/working state that is invalid/,
			],
			["actions but no capability", kind({ capability: undefined as never }), /needs a capability/],
		];
		for (const [, definition, message] of bad) {
			expect(() => defineKinds([definition])).toThrow(HomeKindError);
			expect(() => defineKinds([definition])).toThrow(message);
		}
	});

	it("rejects two kinds with the same name", () => {
		expect(() => defineKinds([kind(), kind()])).toThrow(/Duplicate kind "blind"/);
	});

	it("allows a read-only kind with no capability", () => {
		expect(() =>
			defineKinds([kind({ name: "gauge", actions: [], capability: undefined as never })]),
		).not.toThrow();
	});
});
