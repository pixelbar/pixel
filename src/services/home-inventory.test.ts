import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { type HomeEntity, HomeRequestError, HomeUnavailableError } from "../core/home.ts";
import { HOME_KINDS } from "../core/home-kinds/index.ts";
import { silentLogger } from "../core/logger.ts";
import { type HomeDevicesView, loadHomeDevices } from "./home-devices.ts";
import { buildInventory, HomeInventory, INVENTORY_FILE, MAX_INVENTORY } from "./home-inventory.ts";

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

describe("HomeInventory", () => {
	let dir: string;
	let file: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pixel-inv-"));
		file = join(dir, INVENTORY_FILE);
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const logs = () => {
		const warn = vi.fn();
		const info = vi.fn();
		const logger = { ...silentLogger, warn, info };
		logger.child = () => logger;
		return { logger, warn, info };
	};
	const make = (
		listEntities: () => Promise<HomeEntity[]>,
		extra: { status?: () => { kind: string }; now?: () => Date; intervalMs?: number } = {},
	) => {
		const l = logs();
		const inventory = new HomeInventory({
			home: {
				status: (extra.status ?? (() => ({ kind: "connected" }))) as never,
				listEntities,
			},
			kinds: HOME_KINDS,
			devices: { view: NO_DEVICES },
			file,
			logger: l.logger,
			...(extra.now ? { now: extra.now } : {}),
			...(extra.intervalMs !== undefined ? { intervalMs: extra.intervalMs } : {}),
		});
		return { inventory, ...l };
	};
	const read = () => readFileSync(file, "utf8");

	it("is off, and does nothing, when Home Assistant isn't set up", async () => {
		const off = HomeInventory.off();
		expect(off.configured).toBe(false);
		expect(off.last).toBeUndefined();
		expect(off.intervalMs).toBe(0);
		expect(await off.sync()).toEqual({ kind: "skipped", reason: "not-set-up" });
		const unconfigured = make(async () => [], { status: () => ({ kind: "unconfigured" }) });
		expect(await unconfigured.inventory.sync()).toEqual({ kind: "skipped", reason: "not-set-up" });
	});

	it("writes the inventory, with a header saying what it is and isn't", async () => {
		const at = new Date("2026-10-04T12:00:00Z");
		const { inventory, info } = make(
			async () => [entity("light.a", { name: "Lamp", area: "Hall" })],
			{
				now: () => at,
				intervalMs: 5000,
			},
		);
		expect(inventory.configured).toBe(true);
		expect(inventory.intervalMs).toBe(5000);
		expect(await inventory.sync()).toEqual({
			kind: "synced",
			count: 1,
			previous: undefined,
			changed: true,
		});
		expect(inventory.last).toEqual({ at, count: 1 });
		const text = read();
		expect(text).toContain("NOT an allow-list");
		expect(text).toContain("# Synced 2026-10-04T12:00:00.000Z");
		expect(parse(text)).toEqual({
			inventory: [
				{ name: "lamp", entity: "light.a", kind: "light", friendlyName: "Lamp", area: "Hall" },
			],
		});
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(info).toHaveBeenCalledWith(
			expect.objectContaining({ event: "home.inventory_synced", count: 1, changed: true }),
			expect.any(String),
		);
	});

	it("only rewrites the file when the inventory changed, not just the time", async () => {
		let entities = [entity("light.a")];
		let now = new Date("2026-10-04T12:00:00Z");
		const { inventory } = make(async () => entities, { now: () => now });
		await inventory.sync();
		const first = read();
		now = new Date("2026-10-04T13:00:00Z");
		expect(await inventory.sync()).toEqual({
			kind: "synced",
			count: 1,
			previous: 1,
			changed: false,
		});
		expect(read()).toBe(first);
		expect(inventory.last?.at).toEqual(now);

		entities = [entity("light.a"), entity("light.b")];
		expect(await inventory.sync()).toEqual({
			kind: "synced",
			count: 2,
			previous: 1,
			changed: true,
		});
		expect(read()).toContain("# Synced 2026-10-04T13:00:00.000Z");
	});

	it("doesn't rewrite a file it finds already up to date, and replaces one that isn't", async () => {
		const { inventory } = make(async () => [entity("light.a")]);
		await inventory.sync();
		const mtime = statSync(file).mtimeMs;
		const again = make(async () => [entity("light.a")]).inventory;
		expect(await again.sync()).toMatchObject({ kind: "synced", changed: false });
		expect(statSync(file).mtimeMs).toBe(mtime);

		writeFileSync(file, "inventory: [tampered]\n");
		expect(await again.sync()).toMatchObject({ changed: true });
		expect(parse(read()).inventory[0].entity).toBe("light.a");
	});

	it("skips the run, keeping the old file, when Home Assistant is unreachable, and logs it once", async () => {
		let up = true;
		const { inventory, warn } = make(async () => {
			if (!up) throw new HomeUnavailableError("I can't reach Home Assistant right now.");
			return [entity("light.a")];
		});
		await inventory.sync();
		const before = read();
		up = false;
		for (let i = 0; i < 3; i++) {
			expect(await inventory.sync()).toEqual({ kind: "skipped", reason: "unavailable" });
		}
		expect(read()).toBe(before);
		expect(inventory.last?.count).toBe(1);
		expect(warn).toHaveBeenCalledTimes(1);

		up = true;
		await inventory.sync();
		up = false;
		await inventory.sync();
		expect(warn).toHaveBeenCalledTimes(2);
	});

	it("skips as 'failed', logging every time, for anything else: a refusal, a full disk, a bug", async () => {
		const refusal = make(async () => {
			throw new HomeRequestError("Home Assistant couldn't do that.", "unauthorized");
		});
		expect(await refusal.inventory.sync()).toEqual({ kind: "skipped", reason: "failed" });
		await refusal.inventory.sync();
		expect(refusal.warn).toHaveBeenCalledTimes(2);

		const bug = make(async () => {
			throw new TypeError("nope");
		});
		expect(await bug.inventory.sync()).toEqual({ kind: "skipped", reason: "failed" });

		// A directory where the file should go: the write fails, and that's caught too.
		const blocked = make(async () => [entity("light.a")]);
		rmSync(dir, { recursive: true, force: true });
		writeFileSync(dir, "a file, not a directory");
		expect(await blocked.inventory.sync()).toEqual({ kind: "skipped", reason: "failed" });
		rmSync(dir, { force: true });
	});

	it("warns when it had to cut the list short", async () => {
		const many = Array.from({ length: MAX_INVENTORY + 5 }, (_, i) => entity(`sensor.s${i}`));
		const { inventory, warn } = make(async () => many);
		expect(await inventory.sync()).toMatchObject({ kind: "synced", count: MAX_INVENTORY });
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({ event: "home.inventory_truncated", dropped: 5 }),
			expect.any(String),
		);
	});

	it("never runs two syncs at once", async () => {
		let release: () => void = () => {};
		const listEntities = vi.fn(
			() =>
				new Promise<HomeEntity[]>((resolve) => {
					release = () => resolve([entity("light.a")]);
				}),
		);
		const { inventory } = make(listEntities);
		const a = inventory.sync();
		const b = inventory.sync();
		release();
		expect(await a).toEqual(await b);
		expect(listEntities).toHaveBeenCalledTimes(1);

		// Once it has finished, the next sync runs again.
		const c = inventory.sync();
		release();
		await c;
		expect(listEntities).toHaveBeenCalledTimes(2);
	});
});
