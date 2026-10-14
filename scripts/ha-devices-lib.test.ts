import { describe, expect, it } from "vitest";
import { HOME_KINDS } from "../src/core/home-kinds/index.ts";
import { HomeDevicesError } from "../src/services/home-devices.ts";
import {
	actionChoices,
	appendDevices,
	azDownloadArgs,
	azUploadArgs,
	checkName,
	choiceLabel,
	compareMirror,
	type DeviceChoice,
	defaultDescription,
	deviceChoices,
	mirrorDir,
	planChanges,
	REMOTES,
	removeDevices,
	tiersFor,
	validateDevices,
} from "./ha-devices-lib.ts";
import type { InventoryEntry } from "./ha-inventory.ts";

const kind = (name: string) => {
	const found = HOME_KINDS.get(name);
	if (!found) throw new Error(`no kind ${name}`);
	return found;
};

const SOURCE = `# A comment that must survive.
devices:
  - name: workshop-light
    entity: light.workshop
    kind: light
    actions: [on, off, toggle]
    description: The main light in the workshop

  # Doors are member-only.
  - name: front-door
    entity: lock.front_door
    kind: door
    actions: [lock, unlock]
`;

const entries: InventoryEntry[] = [
	{ name: "workshop-light", entity: "light.workshop", kind: "light", inDevicesFile: true },
	{
		name: "traffic-light-red",
		entity: "light.relay_l1",
		kind: "light",
		friendlyName: "Traffic Light Red",
		area: "Hacking Room",
	},
	{ name: "laser-cutter", entity: "switch.laser_cutter", kind: "switch" },
	{ name: "back-door", entity: "lock.back_door", kind: "door", friendlyName: "Back door" },
];

describe("remotes", () => {
	it("points each env at its own share and the file Pixel reads", () => {
		expect(REMOTES.dev.account).toBe("pixeldevdata");
		expect(REMOTES.prod.account).toBe("pixelproddata");
		expect(REMOTES.prod.path).toBe("home-assistant/devices.yaml");
		expect(mirrorDir("prod")).toBe("config/home-assistant/prod");
	});

	it("builds az arguments with login auth and no shell", () => {
		const down = azDownloadArgs(REMOTES.dev, "/tmp/x.yaml");
		expect(down.slice(0, 3)).toEqual(["storage", "file", "download"]);
		expect(down).toContain("login");
		expect(down[down.indexOf("--account-name") + 1]).toBe("pixeldevdata");
		expect(down[down.indexOf("--dest") + 1]).toBe("/tmp/x.yaml");
		const up = azUploadArgs(REMOTES.prod, "/tmp/y.yaml");
		expect(up.slice(0, 3)).toEqual(["storage", "file", "upload"]);
		expect(up[up.indexOf("--source") + 1]).toBe("/tmp/y.yaml");
		expect(up[up.indexOf("--path") + 1]).toBe("home-assistant/devices.yaml");
	});
});

describe("compareMirror", () => {
	it("treats the remote as the truth", () => {
		expect(compareMirror(undefined, SOURCE)).toBe("missing");
		expect(compareMirror(SOURCE, SOURCE)).toBe("same");
		expect(compareMirror(`${SOURCE}  - name: local-only\n`, SOURCE)).toBe("differs");
	});
});

describe("validateDevices", () => {
	it("checks the text as Pixel does", () => {
		expect(validateDevices(SOURCE, HOME_KINDS).devices.map((d) => d.name)).toEqual([
			"workshop-light",
			"front-door",
		]);
	});

	it("refuses a bad file", () => {
		expect(() =>
			validateDevices("devices:\n  - name: x\n    entity: light.x\n    kind: lamp\n", HOME_KINDS),
		).toThrow(HomeDevicesError);
	});
});

describe("deviceChoices", () => {
	const listed = validateDevices(SOURCE, HOME_KINDS);
	const choices = deviceChoices(entries, listed);

	it("puts what's listed first and ticked, then the rest of Home Assistant", () => {
		expect(choices.map((c) => [c.entry.name, c.listed, c.inHomeAssistant])).toEqual([
			["workshop-light", true, true],
			["front-door", true, false],
			["traffic-light-red", false, true],
			["laser-cutter", false, true],
			["back-door", false, true],
		]);
	});

	it("keeps a listed device Home Assistant doesn't offer, so it can be removed", () => {
		expect(choices[1]?.entry).toEqual({
			name: "front-door",
			entity: "lock.front_door",
			kind: "door",
			inDevicesFile: true,
		});
	});

	it("labels a choice with what people recognise, and marks what's listed", () => {
		expect(choiceLabel(choices[2] as DeviceChoice)).toBe(
			"light  Traffic Light Red · Hacking Room  (light.relay_l1)",
		);
		expect(choiceLabel(choices[3] as DeviceChoice)).toBe(
			"switch laser-cutter  (switch.laser_cutter)",
		);
		expect(choiceLabel(choices[0] as DeviceChoice)).toBe(
			"light  workshop-light  (light.workshop)  [listed as workshop-light]",
		);
		expect(choiceLabel(choices[1] as DeviceChoice)).toMatch(
			/\[listed as front-door, hidden or missing in Home Assistant\]$/,
		);
	});

	it("adds what's newly ticked and removes what's unticked", () => {
		const [workshop, , red] = choices as [DeviceChoice, DeviceChoice, DeviceChoice];
		const plan = planChanges(choices, [workshop, red]);
		expect(plan.add.map((e) => e.name)).toEqual(["traffic-light-red"]);
		expect(plan.remove).toEqual(["front-door"]);
	});

	it("changes nothing when the ticks are left as they were", () => {
		expect(
			planChanges(
				choices,
				choices.filter((c) => c.listed),
			),
		).toEqual({ add: [], remove: [] });
	});
});

describe("removeDevices", () => {
	it("takes a device off and leaves the rest of the file alone", () => {
		expect(removeDevices(SOURCE, ["front-door"])).toBe(`# A comment that must survive.
devices:
  - name: workshop-light
    entity: light.workshop
    kind: light
    actions: [on, off, toggle]
    description: The main light in the workshop
`);
		expect(removeDevices(SOURCE, ["workshop-light"])).toContain(
			"  # Doors are member-only.\n  - name: front-door",
		);
	});

	it("can empty the list, and the file still loads", () => {
		const empty = removeDevices(SOURCE, ["workshop-light", "front-door"]);
		expect(validateDevices(empty, HOME_KINDS).devices).toEqual([]);
	});

	it("leaves the file alone when nothing is removed", () => {
		expect(removeDevices(SOURCE, [])).toBe(SOURCE);
	});

	it("refuses to remove a device that isn't there", () => {
		expect(() => removeDevices(SOURCE, ["nope"])).toThrow(/every device/);
		expect(() => removeDevices("other: 1\n", ["x"])).toThrow(/no devices list/);
	});
});

describe("device settings", () => {
	it("never offers a tier below the kind's floor", () => {
		expect(tiersFor(kind("light"))).toEqual(["friend", "member", "admin"]);
		expect(tiersFor(kind("door"))).toEqual(["member", "admin"]);
	});

	it("ticks every action except a door's", () => {
		expect(actionChoices(kind("light"), "prod")).toEqual([
			{ name: "on", checked: true },
			{ name: "off", checked: true },
			{ name: "toggle", checked: true },
		]);
		expect(actionChoices(kind("door"), "prod")).toEqual([
			{ name: "lock", checked: false },
			{ name: "unlock", checked: false },
		]);
		expect(actionChoices(kind("sensor"), "prod")).toEqual([]);
	});

	it("offers no door actions on dev", () => {
		expect(actionChoices(kind("door"), "dev")).toEqual([]);
		expect(actionChoices(kind("light"), "dev")).toHaveLength(3);
	});

	it("checks names like the devices file does", () => {
		const taken = new Set(["kallax"]);
		expect(checkName("traffic-light", taken)).toBe(true);
		expect(checkName("kallax", taken)).toMatch(/already/);
		expect(checkName("Traffic Light", taken)).toMatch(/Lowercase/);
		expect(checkName("a".repeat(33), taken)).toMatch(/32/);
	});

	it("suggests a description from the friendly name and area", () => {
		expect(defaultDescription(entries[1] as InventoryEntry)).toBe(
			"Traffic Light Red (Hacking Room)",
		);
		expect(defaultDescription(entries[3] as InventoryEntry)).toBe("Back door");
		expect(defaultDescription(entries[2] as InventoryEntry)).toBeUndefined();
		const long = { ...(entries[1] as InventoryEntry), friendlyName: "x".repeat(95) };
		expect(defaultDescription(long)).toBe("x".repeat(95));
	});
});

describe("appendDevices", () => {
	it("leaves the file as it was when nothing is added", () => {
		expect(appendDevices(SOURCE, [])).toBe(SOURCE);
	});

	it("adds devices at the end in the file's own style", () => {
		const next = appendDevices(SOURCE, [
			{
				name: "traffic-light-red",
				entity: "light.relay_l1",
				kind: "light",
				actions: ["on", "off", "toggle"],
				description: "Traffic Light Red (Hacking Room)",
				minTier: "member",
			},
			{ name: "back-door", entity: "lock.back_door", kind: "door", actions: [], minTier: "admin" },
		]);
		expect(next.startsWith(SOURCE)).toBe(true);
		expect(next.slice(SOURCE.length)).toBe(`  - name: traffic-light-red
    entity: light.relay_l1
    kind: light
    actions: [on, off, toggle]
    description: Traffic Light Red (Hacking Room)
  - name: back-door
    entity: lock.back_door
    kind: door
    minTier: admin
`);
		expect(validateDevices(next, HOME_KINDS).devices).toHaveLength(4);
	});

	it("quotes a description that YAML would misread", () => {
		const next = appendDevices(SOURCE, [
			{ name: "x", entity: "light.x", kind: "light", actions: [], description: "on: #1" },
		]);
		expect(validateDevices(next, HOME_KINDS).byName.get("x")?.description).toBe("on: #1");
	});

	it("turns an empty inline list into a block list", () => {
		expect(
			appendDevices("devices: []\n", [
				{ name: "a", entity: "light.a", kind: "light", actions: ["on"] },
			]),
		).toBe("devices:\n  - name: a\n    entity: light.a\n    kind: light\n    actions: [on]\n");
	});

	it("refuses a file without a devices list", () => {
		expect(() =>
			appendDevices("other: 1\n", [{ name: "a", entity: "light.a", kind: "light", actions: [] }]),
		).toThrow(/no devices list/);
	});
});
