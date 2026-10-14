import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HomeEntity } from "../src/core/home.ts";
import { HOME_KINDS } from "../src/core/home-kinds/index.ts";
import { type HomeDevicesView, loadHomeDevices } from "../src/services/home-devices.ts";
import { buildInventory, MAX_INVENTORY } from "./ha-inventory.ts";

const entity = (entityId: string, extra: Partial<HomeEntity> = {}): HomeEntity => ({
	entityId,
	name: undefined,
	area: undefined,
	category: undefined,
	hidden: false,
	...extra,
});
const NO_DEVICES: HomeDevicesView = { devices: [], byName: new Map() };

describe("buildInventory", () => {
	it("keeps domains that have a kind, and leaves out the rest", () => {
		const { entries } = buildInventory(
			[
				entity("light.a"),
				entity("switch.b"),
				entity("lock.c"),
				entity("sensor.d"),
				entity("binary_sensor.e"),
				entity("update.f"),
				entity("automation.g"),
				entity("tag.h"),
			],
			HOME_KINDS,
			NO_DEVICES,
		);
		expect(entries.map((e) => [e.entity, e.kind])).toEqual([
			["light.a", "light"],
			["switch.b", "switch"],
			["lock.c", "door"],
			["binary_sensor.e", "sensor"],
			["sensor.d", "sensor"],
		]);
	});

	it("leaves out setup and diagnostic entities and hidden ones", () => {
		const { entries } = buildInventory(
			[
				entity("switch.real"),
				entity("switch.nightlight", { category: "config" }),
				entity("sensor.rssi", { category: "diagnostic" }),
				entity("light.hidden", { hidden: true }),
			],
			HOME_KINDS,
			NO_DEVICES,
		);
		expect(entries.map((e) => e.entity)).toEqual(["switch.real"]);
	});

	it("carries the friendly name and area, cleaned, and nothing about state or access", () => {
		const { entries } = buildInventory(
			[
				entity("light.a", { name: "  Kitchen\u0000 \n lights‮ ", area: "Hall" }),
				entity("light.b", { name: "x".repeat(300), area: "   " }),
			],
			HOME_KINDS,
			NO_DEVICES,
		);
		expect(entries[0]).toEqual({
			name: "kitchen-lights",
			entity: "light.a",
			kind: "light",
			friendlyName: "Kitchen lights",
			area: "Hall",
		});
		expect(entries[1]?.friendlyName).toHaveLength(100);
		expect(entries[1]).not.toHaveProperty("area");
		for (const entry of entries) {
			expect(
				Object.keys(entry).every((k) =>
					["name", "entity", "kind", "friendlyName", "area", "inDevicesFile"].includes(k),
				),
			).toBe(true);
		}
	});

	describe("suggested names", () => {
		const names = (entities: HomeEntity[]) =>
			buildInventory(entities, HOME_KINDS, NO_DEVICES).entries.map((e) => e.name);

		it("are lowercase words from the friendly name, else from the entity", () => {
			expect(
				names([
					entity("light.a", { name: "Kallax1 Segment 3" }),
					entity("light.bug_light"),
					entity("light.c", { name: "Café Ünïcode!!" }),
				]),
			).toEqual(["kallax1-segment-3", "bug-light", "cafe-unicode"]);
		});

		it("start with a letter, and are never empty", () => {
			expect(
				names([entity("light.a", { name: "3D printer" }), entity("sensor.b", { name: "!!!" })]),
			).toEqual(["light-3d-printer", "b"]);
			expect(names([entity("light.b", { name: "日本語" })])).toEqual(["b"]);
		});

		it("are at most 32 characters, and still valid when cut", () => {
			const [name] = names([entity("light.a", { name: `${"a".repeat(30)} bc def` })]);
			expect(name).toMatch(/^[a-z][a-z0-9-]{0,31}$/);
			expect(name?.length).toBeLessThanOrEqual(32);
			expect(name?.endsWith("-")).toBe(false);
		});

		it("are unique, with a number added, within the limit", () => {
			const long = "a".repeat(32);
			const result = names([
				entity("light.a", { name: "Lamp" }),
				entity("light.b", { name: "Lamp" }),
				entity("light.c", { name: "lamp" }),
				entity("light.d", { name: long }),
				entity("light.e", { name: long }),
			]);
			expect(result).toEqual(["lamp", "lamp-2", "lamp-3", long, `${"a".repeat(30)}-2`]);
			expect(new Set(result).size).toBe(result.length);
			for (const name of result) expect(name).toMatch(/^[a-z][a-z0-9-]{0,31}$/);
		});

		it("don't depend on the order Home Assistant lists them in", () => {
			const list = [entity("light.b", { name: "Lamp" }), entity("light.a", { name: "Lamp" })];
			expect(names(list)).toEqual(names([...list].reverse()));
			expect(names(list)).toEqual(["lamp", "lamp-2"]);
		});
	});

	describe("devices already in devices.yaml", () => {
		let dir: string;
		beforeEach(() => {
			dir = mkdtempSync(join(tmpdir(), "pixel-inv-"));
		});
		afterEach(() => rmSync(dir, { recursive: true, force: true }));

		it("are marked, keep their own name, and keep that name from being suggested again", () => {
			writeFileSync(
				join(dir, "devices.yaml"),
				"devices:\n  - name: lamp\n    entity: light.b\n    kind: light\n    actions: [on]\n",
			);
			const devices = loadHomeDevices(dir, HOME_KINDS);
			const { entries } = buildInventory(
				[entity("light.a", { name: "Lamp" }), entity("light.b", { name: "Something else" })],
				HOME_KINDS,
				devices,
			);
			expect(entries).toEqual([
				{ name: "lamp-2", entity: "light.a", kind: "light", friendlyName: "Lamp" },
				{
					name: "lamp",
					entity: "light.b",
					kind: "light",
					friendlyName: "Something else",
					inDevicesFile: true,
				},
			]);
		});
	});

	it("lists an entity once, and cuts the list at the limit, sensors first to go", () => {
		const lights = Array.from({ length: 10 }, (_, i) => entity(`light.l${i}`));
		const sensors = Array.from({ length: MAX_INVENTORY }, (_, i) => entity(`sensor.s${i}`));
		const { entries, dropped } = buildInventory(
			[...sensors, ...lights, entity("light.l0")],
			HOME_KINDS,
			NO_DEVICES,
		);
		expect(entries).toHaveLength(MAX_INVENTORY);
		expect(dropped).toBe(10);
		expect(entries.filter((e) => e.kind === "light")).toHaveLength(10);
	});
});
