import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EntityState } from "../core/home.ts";
import { HOME_KINDS } from "../core/home-kinds/index.ts";
import {
	DEVICES_FILE,
	findMissingDevices,
	HomeDeviceStore,
	HomeDevicesError,
	loadHomeDevices,
	MAX_DEVICES,
} from "./home-devices.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pixel-ha-devices-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (text: string) => writeFileSync(join(dir, DEVICES_FILE), text);
const load = () => loadHomeDevices(dir, HOME_KINDS);
const failure = (): Error => {
	try {
		load();
	} catch (error) {
		return error as Error;
	}
	throw new Error("expected loading to fail");
};

const VALID = `devices:
  - name: workshop-light
    entity: light.workshop
    kind: light
    actions: [on, off]
    description: The main light
  - name: front-door
    entity: lock.front_door
    kind: door
    actions: [lock, unlock]
    minTier: admin
  - name: workshop-temperature
    entity: sensor.workshop_temperature
    kind: sensor
`;

describe("loadHomeDevices", () => {
	it("gives named devices with their kind, entity, allowed actions and access", () => {
		write(VALID);
		const { devices, byName } = load();
		expect(devices.map((d) => d.name)).toEqual([
			"workshop-light",
			"front-door",
			"workshop-temperature",
		]);
		const light = byName.get("workshop-light");
		expect(light).toMatchObject({
			entityId: "light.workshop",
			description: "The main light",
			minTier: "member",
		});
		expect(light?.kind).toBe(HOME_KINDS.get("light"));
		expect(light?.actions.map((a) => a.name)).toEqual(["on", "off"]);
		const door = byName.get("front-door");
		expect(door?.minTier).toBe("admin");
		expect(door?.actions.map((a) => [a.name, a.service])).toEqual([
			["lock", "lock"],
			["unlock", "unlock"],
		]);
	});

	it("allows only what's listed: leaving actions out means read-only, even for a light", () => {
		write("devices:\n  - name: lamp\n    entity: light.lamp\n    kind: light\n");
		expect(load().devices[0]?.actions).toEqual([]);
	});

	it("keeps the kind's own order for the actions, whatever order they're listed in", () => {
		write(
			"devices:\n  - name: lamp\n    entity: light.lamp\n    kind: light\n    actions: [toggle, on]\n",
		);
		expect(load().devices[0]?.actions.map((a) => a.name)).toEqual(["on", "toggle"]);
	});

	it("accepts an empty list, and every tier except guest", () => {
		write("devices: []\n");
		expect(load().devices).toEqual([]);
		for (const tier of ["friend", "member", "admin"]) {
			write(
				`devices:\n  - name: lamp\n    entity: light.lamp\n    kind: light\n    minTier: ${tier}\n`,
			);
			expect(load().devices[0]?.minTier).toBe(tier);
		}
	});

	it("accepts a binary sensor for a sensor, and a door's lock domain", () => {
		write(
			"devices:\n  - name: contact\n    entity: binary_sensor.front_door_contact\n    kind: sensor\n",
		);
		expect(load().devices[0]?.entityId).toBe("binary_sensor.front_door_contact");
	});

	describe("refuses, without echoing a value from the file", () => {
		const SECRET = "very-private-room-name";

		it.each([
			[
				"an unknown key",
				`devices:\n  - name: lamp\n    entity: light.lamp\n    kind: light\n    colour: ${SECRET}\n`,
				/devices\[0\]/,
			],
			["an unknown top-level key", `devices: []\nextra: ${SECRET}\n`, /\(root\)/],
			[
				"a duplicate name",
				`devices:\n  - name: ${SECRET}\n    entity: light.a\n    kind: light\n  - name: ${SECRET}\n    entity: light.b\n    kind: light\n`,
				/devices\[1\]\.name duplicates devices\[0\]\.name/,
			],
			[
				"a duplicate entity",
				`devices:\n  - name: one\n    entity: light.${SECRET.replace(/-/g, "_")}\n    kind: light\n  - name: two\n    entity: light.${SECRET.replace(/-/g, "_")}\n    kind: light\n`,
				/devices\[1\]\.entity duplicates devices\[0\]\.entity/,
			],
			[
				"an entity whose domain doesn't match the kind",
				`devices:\n  - name: lamp\n    entity: switch.${SECRET.replace(/-/g, "_")}\n    kind: light\n`,
				/devices\[0\]\.entity: its domain doesn't match the kind/,
			],
			[
				"an action the kind doesn't offer",
				`devices:\n  - name: lamp\n    entity: light.lamp\n    kind: light\n    actions: [${SECRET}]\n`,
				/devices\[0\]\.actions\[0\]: isn't an action this kind offers/,
			],
			[
				"an action that belongs to another kind",
				"devices:\n  - name: lamp\n    entity: light.lamp\n    kind: light\n    actions: [unlock]\n",
				/devices\[0\]\.actions\[0\]/,
			],
			[
				"actions on a read-only kind",
				"devices:\n  - name: temp\n    entity: sensor.temp\n    kind: sensor\n    actions: [on]\n",
				/devices\[0\]\.actions\[0\]/,
			],
			[
				"a repeated action",
				"devices:\n  - name: lamp\n    entity: light.lamp\n    kind: light\n    actions: [on, on]\n",
				/devices\[0\]\.actions: must not repeat an action/,
			],
			[
				"an unknown kind",
				`devices:\n  - name: lamp\n    entity: light.lamp\n    kind: ${SECRET}\n`,
				/devices\[0\]\.kind: must be one of: light, switch, door, sensor/,
			],
			[
				"guest as the tier",
				"devices:\n  - name: lamp\n    entity: light.lamp\n    kind: light\n    minTier: guest\n",
				/devices\[0\]\.minTier/,
			],
			[
				"an unknown tier",
				`devices:\n  - name: lamp\n    entity: light.lamp\n    kind: light\n    minTier: ${SECRET}\n`,
				/devices\[0\]\.minTier/,
			],
			[
				"a name that's too long",
				`devices:\n  - name: ${"a".repeat(33)}\n    entity: light.lamp\n    kind: light\n`,
				/devices\[0\]\.name: must be lowercase words/,
			],
			[
				"a name with capitals or spaces",
				`devices:\n  - name: ${SECRET.toUpperCase()} one\n    entity: light.lamp\n    kind: light\n`,
				/devices\[0\]\.name/,
			],
			[
				"an entity that isn't an entity",
				`devices:\n  - name: lamp\n    entity: ${SECRET}\n    kind: light\n`,
				/devices\[0\]\.entity: must look like light\.workshop/,
			],
			[
				"a missing name",
				"devices:\n  - entity: light.lamp\n    kind: light\n",
				/devices\[0\]\.name/,
			],
			[
				"a missing kind",
				"devices:\n  - name: lamp\n    entity: light.lamp\n",
				/devices\[0\]\.kind/,
			],
			[
				"a description that's empty",
				"devices:\n  - name: lamp\n    entity: light.lamp\n    kind: light\n    description: '  '\n",
				/devices\[0\]\.description/,
			],
			[
				"a description that's too long",
				`devices:\n  - name: lamp\n    entity: light.lamp\n    kind: light\n    description: ${"x".repeat(101)}\n`,
				/devices\[0\]\.description/,
			],
			[
				"a name that isn't text",
				"devices:\n  - name: 12\n    entity: light.lamp\n    kind: light\n",
				/devices\[0\]\.name: must be a string/,
			],
			["the wrong shape", "- name: lamp\n", /\(root\)/],
			["an empty file", "", /\(root\)/],
		])("%s", (_label, text, message) => {
			write(text);
			const error = failure();
			expect(error).toBeInstanceOf(HomeDevicesError);
			expect(error.message).toMatch(message);
			expect(error.message).not.toContain(SECRET);
			expect(error.message).not.toContain(SECRET.toUpperCase());
			expect(error.message).toContain(join(dir, DEVICES_FILE));
		});

		it("more devices than the limit", () => {
			const many = Array.from(
				{ length: MAX_DEVICES + 1 },
				(_, i) => `  - name: d${i}\n    entity: sensor.s${i}\n    kind: sensor\n`,
			).join("");
			write(`devices:\n${many}`);
			expect(failure().message).toMatch(/at most 200 devices/);
		});

		it("invalid YAML, naming only the position", () => {
			write(`devices:\n  - name: "${SECRET}\n    entity: [\n`);
			const error = failure();
			expect(error.message).toMatch(/invalid YAML at line \d+, column \d+/);
			expect(error.message).not.toContain(SECRET);
		});

		it("a missing file", () => {
			rmSync(join(dir, DEVICES_FILE), { force: true });
			expect(failure().message).toMatch(/devices\.yaml: cannot read file \(ENOENT\)/);
		});

		it("a directory where the file should be", () => {
			mkdirSync(join(dir, DEVICES_FILE));
			expect(failure().message).toMatch(/cannot read file \(EISDIR\)/);
		});
	});

	it("reports every problem at once, so they can all be fixed in one go", () => {
		write("devices:\n  - name: A\n    entity: nope\n    kind: nope\n");
		const message = failure().message;
		expect(message).toMatch(/devices\[0\]\.name/);
		expect(message).toMatch(/devices\[0\]\.entity/);
		expect(message).toMatch(/devices\[0\]\.kind/);
	});
});

describe("HomeDeviceStore", () => {
	it("is empty and not configured when Home Assistant isn't set up, and has nothing to reload", () => {
		const store = HomeDeviceStore.empty();
		expect(store.configured).toBe(false);
		expect(store.view.devices).toEqual([]);
		expect(store.reload()).toEqual({ before: 0, after: 0 });
	});

	it("loads the file when opened, and stops (throws) if it's missing or invalid", () => {
		expect(() => HomeDeviceStore.open({ dir, kinds: HOME_KINDS })).toThrow(/cannot read file/);
		write("devices:\n  - name: BAD\n");
		expect(() => HomeDeviceStore.open({ dir, kinds: HOME_KINDS })).toThrow(HomeDevicesError);
		write(VALID);
		const store = HomeDeviceStore.open({ dir, kinds: HOME_KINDS });
		expect(store.configured).toBe(true);
		expect(store.view.devices).toHaveLength(3);
	});

	it("picks up an edit on reload and reports before and after", () => {
		write(VALID);
		const store = HomeDeviceStore.open({ dir, kinds: HOME_KINDS });
		write(
			`${VALID}  - name: laser\n    entity: switch.laser\n    kind: switch\n    actions: [on]\n`,
		);
		expect(store.reload()).toEqual({ before: 3, after: 4 });
		expect(store.view.byName.get("laser")?.kind.name).toBe("switch");
	});

	it("keeps the old list, completely, when the new file is invalid", () => {
		write(VALID);
		const store = HomeDeviceStore.open({ dir, kinds: HOME_KINDS });
		const before = store.view;
		write("devices:\n  - name: BAD\n");
		expect(() => store.reload()).toThrow(HomeDevicesError);
		expect(store.view).toBe(before);
		rmSync(join(dir, DEVICES_FILE));
		expect(() => store.reload()).toThrow(/cannot read file/);
		expect(store.view).toBe(before);
		expect(store.view.devices).toHaveLength(3);
	});
});

describe("findMissingDevices", () => {
	const entity = (entityId: string): EntityState => ({
		entityId,
		state: "on",
		attributes: {},
		lastChanged: null,
	});

	it("names devices whose entity Home Assistant doesn't know", async () => {
		write(VALID);
		const { view } = HomeDeviceStore.open({ dir, kinds: HOME_KINDS });
		const getStates = vi.fn(async () => new Map([["light.workshop", entity("light.workshop")]]));
		expect(await findMissingDevices(view, { getStates })).toEqual([
			"front-door",
			"workshop-temperature",
		]);
		expect(getStates).toHaveBeenCalledWith([
			"light.workshop",
			"lock.front_door",
			"sensor.workshop_temperature",
		]);
	});

	it("says nothing is missing when everything is there, and doesn't ask when there's nothing to check", async () => {
		write(VALID);
		const { view } = HomeDeviceStore.open({ dir, kinds: HOME_KINDS });
		const all = new Map(view.devices.map((d) => [d.entityId, entity(d.entityId)]));
		expect(await findMissingDevices(view, { getStates: async () => all })).toEqual([]);
		const getStates = vi.fn(async () => new Map<string, EntityState>());
		expect(await findMissingDevices(HomeDeviceStore.empty().view, { getStates })).toEqual([]);
		expect(getStates).not.toHaveBeenCalled();
	});

	it("can't tell, and says so, when Home Assistant is unreachable", async () => {
		write(VALID);
		const { view } = HomeDeviceStore.open({ dir, kinds: HOME_KINDS });
		const getStates = async () => {
			throw new Error("down");
		};
		expect(await findMissingDevices(view, { getStates })).toBeUndefined();
	});
});

describe("the committed example file", () => {
	it("loads cleanly, so CI notices if it goes stale", () => {
		write(readFileSync("config/home-assistant/devices.example.yaml", "utf8"));
		const { devices } = load();
		expect(devices.map((d) => d.name)).toEqual([
			"workshop-light",
			"laser-cutter",
			"front-door",
			"workshop-temperature",
		]);
	});
});
