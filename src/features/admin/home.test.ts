import { describe, expect, it, vi } from "vitest";
import type { EntityState, HomeStatus } from "../../core/home.ts";
import { type HomeDeviceStore, HomeDevicesError } from "../../services/home-devices.ts";
import type { InventorySync } from "../../services/home-inventory.ts";
import { describeHome, homeLines, inventoryLines, reloadDevices } from "./home.ts";

const connected = (
	extra: Partial<Extract<HomeStatus, { kind: "connected" }>> = {},
): HomeStatus => ({
	kind: "connected",
	haVersion: "2026.10.1",
	adminToken: false,
	...extra,
});

describe("describeHome", () => {
	it.each([
		[{ kind: "unconfigured" }, "Not configured"],
		[{ kind: "connecting" }, "Connecting…"],
		[{ kind: "reconnecting" }, "Not connected, trying to reconnect"],
		[{ kind: "off", reason: "the token was refused" }, "Off: the token was refused"],
	] as const)("describes %j", (status, text) => {
		expect(describeHome(status)).toBe(text);
	});

	it("says connected, with the version as a code span", () => {
		expect(describeHome(connected())).toBe("Connected (version `2026.10.1`)");
		expect(describeHome(connected({ haVersion: undefined }))).toBe("Connected");
	});

	it("shows an untrusted version inertly", () => {
		expect(describeHome(connected({ haVersion: "**@everyone** [x](https://evil.example)" }))).toBe(
			"Connected (version `**@everyone** [x](https://evil.example)`)",
		);
	});

	it("warns when the token belongs to an admin", () => {
		expect(describeHome(connected({ adminToken: true }))).toContain(
			"⚠ The token belongs to an admin user",
		);
		expect(describeHome(connected({ adminToken: undefined }))).not.toContain("⚠");
	});
});

describe("homeLines", () => {
	it("says nothing when all is well, or Home Assistant isn't used", () => {
		expect(homeLines(connected())).toEqual([]);
		expect(homeLines(connected({ adminToken: undefined }))).toEqual([]);
		expect(homeLines({ kind: "unconfigured" })).toEqual([]);
	});

	it("says what needs attention", () => {
		expect(homeLines({ kind: "off", reason: "the token was refused" })).toEqual([
			"Home Assistant is off: the token was refused.",
		]);
		expect(homeLines({ kind: "connecting" })).toEqual([
			"Home Assistant isn't connected right now.",
		]);
		expect(homeLines({ kind: "reconnecting" })).toEqual([
			"Home Assistant isn't connected right now.",
		]);
		expect(homeLines(connected({ adminToken: true }))).toEqual([
			"Home Assistant's token belongs to an admin user. Use a non-admin user's token.",
		]);
	});
});

const devicesOf = (count: number, configured = true) =>
	({
		configured,
		view: {
			devices: Array.from({ length: count }, (_, i) => ({
				name: `d${i}`,
				entityId: `light.d${i}`,
			})),
		},
	}) as unknown as Pick<HomeDeviceStore, "view" | "configured">;

describe("describeHome with devices", () => {
	it("adds how many devices are allowed", () => {
		expect(describeHome(connected(), devicesOf(1))).toBe(
			"Connected (version `2026.10.1`)\n1 device allowed",
		);
		expect(describeHome({ kind: "connecting" }, devicesOf(3))).toBe(
			"Connecting…\n3 devices allowed",
		);
		expect(describeHome({ kind: "connecting" }, devicesOf(0))).toBe(
			"Connecting…\n0 devices allowed",
		);
	});

	it("says nothing about devices when Home Assistant isn't set up", () => {
		expect(describeHome({ kind: "unconfigured" }, devicesOf(0, false))).toBe("Not configured");
	});
});

describe("reloadDevices", () => {
	const entity = (entityId: string): EntityState => ({
		entityId,
		state: "on",
		attributes: {},
		lastChanged: null,
	});
	const store = (reload: () => { before: number; after: number }, count = 2) =>
		({ ...devicesOf(count), reload }) as unknown as Parameters<typeof reloadDevices>[0];

	it("does nothing when Home Assistant isn't set up", async () => {
		const reload = vi.fn();
		const getStates = vi.fn();
		const none = { ...devicesOf(0, false), reload } as unknown as Parameters<
			typeof reloadDevices
		>[0];
		expect(await reloadDevices(none, { getStates })).toEqual([]);
		expect(reload).not.toHaveBeenCalled();
		expect(getStates).not.toHaveBeenCalled();
	});

	it("reports the new count, and devices Home Assistant doesn't know", async () => {
		const getStates = async () => new Map([["light.d0", entity("light.d0")]]);
		expect(
			await reloadDevices(
				store(() => ({ before: 1, after: 2 })),
				{ getStates },
			),
		).toEqual(["Home Assistant devices: 2 (was 1).", "Not found in Home Assistant: d1."]);
	});

	it("stays quiet about missing devices when all exist, or when it can't tell", async () => {
		const all = async () =>
			new Map([
				["light.d0", entity("light.d0")],
				["light.d1", entity("light.d1")],
			]);
		expect(
			await reloadDevices(
				store(() => ({ before: 2, after: 2 })),
				{ getStates: all },
			),
		).toEqual(["Home Assistant devices: 2 (was 2)."]);
		const down = async () => {
			throw new Error("down");
		};
		expect(
			await reloadDevices(
				store(() => ({ before: 2, after: 2 })),
				{ getStates: down },
			),
		).toEqual(["Home Assistant devices: 2 (was 2)."]);
	});

	it("keeps the old list and says why when the file is invalid", async () => {
		const reload = () => {
			throw new HomeDevicesError("devices.yaml: invalid devices file\n  - devices[0].name: bad");
		};
		const lines = await reloadDevices(store(reload, 0), { getStates: async () => new Map() });
		expect(lines).toEqual([
			"Home Assistant devices weren't reloaded, so I'm keeping the old list.\ndevices.yaml: invalid devices file\n  - devices[0].name: bad",
		]);
	});

	it("doesn't swallow errors that aren't about the file", async () => {
		const reload = () => {
			throw new Error("boom");
		};
		await expect(
			reloadDevices(store(reload), { getStates: async () => new Map() }),
		).rejects.toThrow("boom");
	});
});

describe("describeHome with the inventory", () => {
	const at = new Date("2026-10-04T12:00:00Z");
	const later = new Date("2026-10-04T13:05:00Z");

	it("shows how many are known and how long ago it synced, apart from how many are allowed", () => {
		expect(
			describeHome({ kind: "connecting" }, devicesOf(2), { last: { at, count: 408 } }, later),
		).toBe("Connecting…\n2 devices allowed\n408 known, synced 1h 5m ago");
	});

	it("says when it hasn't synced yet", () => {
		expect(describeHome({ kind: "connecting" }, devicesOf(0), { last: undefined }, later)).toBe(
			"Connecting…\n0 devices allowed\nInventory not synced yet",
		);
	});

	it("says nothing about it when Home Assistant isn't set up", () => {
		expect(describeHome({ kind: "unconfigured" }, devicesOf(0, false), { last: undefined })).toBe(
			"Not configured",
		);
	});
});

describe("inventoryLines", () => {
	it.each<[InventorySync, string[]]>([
		[
			{ kind: "synced", count: 408, previous: 400, changed: true },
			["Home Assistant inventory: 408 known (was 400)."],
		],
		[
			{ kind: "synced", count: 408, previous: undefined, changed: true },
			["Home Assistant inventory: 408 known."],
		],
		[
			{ kind: "skipped", reason: "unavailable" },
			["The Home Assistant inventory wasn't synced: Home Assistant isn't reachable."],
		],
		[
			{ kind: "skipped", reason: "failed" },
			["The Home Assistant inventory couldn't be synced, see the logs."],
		],
		[{ kind: "skipped", reason: "not-set-up" }, []],
	])("says what happened for %j", (result, lines) => {
		expect(inventoryLines(result)).toEqual(lines);
	});
});
