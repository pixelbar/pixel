import { describe, expect, it, vi } from "vitest";
import { type OpenrDoorInfo, OpenrError, type OpenrSession } from "../src/adapters/openr/client.ts";
import {
	clean,
	collectInventory,
	formatInventory,
	type OpenrInventory,
	type OpenrLister,
	suggestSettings,
} from "./openr-doors-lib.ts";

const session = {} as OpenrSession;
const door = (id: string, name: string, buildingId: string | undefined = "49"): OpenrDoorInfo => ({
	id,
	name,
	buildingId,
});

function lister(overrides: Partial<OpenrLister> = {}) {
	return {
		listBuildings: vi.fn<OpenrLister["listBuildings"]>(async () => [{ id: "49", name: "Main" }]),
		listDoors: vi.fn<OpenrLister["listDoors"]>(async () => [
			door("103", "Entrance"),
			door("125", "Car barrier"),
		]),
		myDoors: vi.fn<OpenrLister["myDoors"]>(async () => [door("103", "Entrance")]),
		...overrides,
	};
}

describe("collectInventory", () => {
	it("lists the buildings, each building's doors and the account's own doors", async () => {
		const api = lister();
		const inventory = await collectInventory(api, session);
		expect(inventory.buildings).toEqual({ kind: "ok", items: [{ id: "49", name: "Main" }] });
		expect(inventory.doors.get("49")).toMatchObject({ kind: "ok" });
		expect(inventory.mine).toEqual({ kind: "ok", items: [door("103", "Entrance")] });
		expect(api.listDoors).toHaveBeenCalledWith(session, "49");
	});

	it("notes what the account may not see, and carries on", async () => {
		const refused = (status: number) => async () => {
			throw new OpenrError("http", "x", { status });
		};
		const api = lister({ listBuildings: refused(403), myDoors: refused(404) });
		const inventory = await collectInventory(api, session);
		expect(inventory.buildings).toEqual({ kind: "not-allowed", status: 403 });
		expect(inventory.doors.size).toBe(0);
		expect(inventory.mine).toEqual({ kind: "not-allowed", status: 404 });

		const doorsRefused = await collectInventory(lister({ listDoors: refused(401) }), session);
		expect(doorsRefused.doors.get("49")).toEqual({ kind: "not-allowed", status: 401 });
	});

	it("stops on anything else", async () => {
		const outage = new OpenrError("http", "x", { status: 503 });
		await expect(
			collectInventory(lister({ myDoors: async () => Promise.reject(outage) }), session),
		).rejects.toBe(outage);
		await expect(
			collectInventory(lister({ myDoors: async () => Promise.reject(new Error("boom")) }), session),
		).rejects.toThrow("boom");
	});
});

describe("clean", () => {
	it("makes text from OpenR safe to print", () => {
		expect(clean("Front\u001b[31m door\n\u009b")).toBe("Front [31m door");
		expect(clean("   ")).toBe("(no name)");
		expect(clean("x".repeat(100))).toBe(`${"x".repeat(79)}…`);
	});
});

describe("formatInventory", () => {
	it("lists buildings with their doors, marks the ones Pixel can open, and suggests settings", async () => {
		const text = formatInventory(await collectInventory(lister(), session), 250);
		expect(text).toBe(
			[
				"Buildings (1):",
				"      49  Main",
				"       103  Entrance  ✓ Pixel's account can open it",
				"       125  Car barrier",
				"",
				"Doors Pixel's account can open (1):",
				"     103  Entrance  (building 49)",
				"",
				"Suggested settings (check the names, and move the gate to OPENR_GATE_DOOR):",
				"  OPENR_BUILDING_ID=49",
				"  OPENR_DOORS=Entrance=103",
				"",
			].join("\n"),
		);
	});

	it("says what the account couldn't list, when a list is empty, and when one may be cut short", () => {
		const inventory: OpenrInventory = {
			buildings: {
				kind: "ok",
				items: [
					{ id: "1", name: "A" },
					{ id: "2", name: "B" },
					{ id: "3", name: "C" },
				],
			},
			doors: new Map([
				["1", { kind: "ok", items: [] }],
				["2", { kind: "not-allowed", status: 403 }],
				["3", { kind: "ok", items: [door("9", "Nine", "3")] }],
			]),
			mine: { kind: "ok", items: [] },
		};
		const text = formatInventory(inventory, 1);
		expect(text).toContain("Buildings (3) (OpenR's limit of 1: there may be more):");
		expect(text).toContain("    (no doors)");
		expect(text).toContain("    (this account can't list its doors: HTTP 403)");
		expect(text).toContain("        9  Nine\n    (OpenR's limit of 1: there may be more)");
		expect(text).toContain("Doors Pixel's account can open (0):\n  (none)");
		expect(text).not.toContain("Suggested");
	});

	it("falls back to the account's own doors when it can't list buildings", () => {
		const text = formatInventory(
			{
				buildings: { kind: "not-allowed", status: 403 },
				doors: new Map(),
				mine: { kind: "ok", items: [{ id: "103", name: "Entrance", buildingId: undefined }] },
			},
			250,
		);
		expect(text).toContain(
			"This account can't list buildings (HTTP 403), only the doors it may open.",
		);
		expect(text).toContain("     103  Entrance\n");
		expect(text).toContain("  OPENR_DOORS=Entrance=103\n");
		expect(text).not.toContain("OPENR_BUILDING_ID");
	});

	it("says when it can't list its own doors either", () => {
		const text = formatInventory(
			{
				buildings: { kind: "not-allowed", status: 403 },
				doors: new Map(),
				mine: { kind: "not-allowed", status: 403 },
			},
			250,
		);
		expect(text).toContain("This account can't list its own doors (HTTP 403).");
	});
});

describe("suggestSettings", () => {
	const mine = (...doors: OpenrDoorInfo[]): OpenrInventory => ({
		buildings: { kind: "not-allowed", status: 403 },
		doors: new Map(),
		mine: { kind: "ok", items: doors },
	});

	it("makes names valid for OPENR_DOORS, and never repeats one", () => {
		expect(
			suggestSettings(
				mine(
					door("1", "Front, main = door"),
					door("2", "front  MAIN door"),
					door("3", ""),
					door("4", "y".repeat(60)),
				),
			),
		).toEqual([
			"OPENR_BUILDING_ID=49",
			`OPENR_DOORS=Front main door=1, front MAIN door 2=2, (no name)=3, ${"y".repeat(40)}=4`,
		]);
	});

	it("suggests nothing for doors in several buildings, or none at all", () => {
		expect(suggestSettings(mine(door("1", "A", "49"), door("2", "B", "50")))).toEqual([]);
		expect(suggestSettings(mine())).toEqual([]);
	});

	it("suggests at most 25 doors", () => {
		const many = Array.from({ length: 30 }, (_, i) => door(String(i), `Door ${i}`));
		expect(suggestSettings(mine(...many))[1]?.split(", ")).toHaveLength(25);
	});
});
