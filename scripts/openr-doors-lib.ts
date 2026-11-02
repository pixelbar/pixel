/**
 * The parts of `just openr-doors` that don't talk to anyone: asking for each list
 * (an account may not be allowed some of them), and turning what came back into a
 * listing plus suggested settings. Names come from OpenR, so they're cleaned before
 * they reach a terminal.
 */
import {
	type OpenrBuilding,
	type OpenrClient,
	type OpenrDoorInfo,
	OpenrError,
	type OpenrSession,
} from "../src/adapters/openr/client.ts";

/** A list, or why it isn't there: the account may not see it. */
export type Listed<T> = { kind: "ok"; items: T[] } | { kind: "not-allowed"; status: number };

export type OpenrInventory = {
	buildings: Listed<OpenrBuilding>;
	/** Each listed building's doors, by building ID. */
	doors: Map<string, Listed<OpenrDoorInfo>>;
	/** The doors the account itself may open. */
	mine: Listed<OpenrDoorInfo>;
};

export type OpenrLister = Pick<OpenrClient, "listBuildings" | "listDoors" | "myDoors">;

/** Asks for every list once. A list the account may not see is noted, not an error. */
export async function collectInventory(
	api: OpenrLister,
	session: OpenrSession,
): Promise<OpenrInventory> {
	const buildings = await listed(() => api.listBuildings(session));
	const doors = new Map<string, Listed<OpenrDoorInfo>>();
	if (buildings.kind === "ok") {
		for (const building of buildings.items) {
			doors.set(building.id, await listed(() => api.listDoors(session, building.id)));
		}
	}
	const mine = await listed(() => api.myDoors(session));
	return { buildings, doors, mine };
}

async function listed<T>(get: () => Promise<T[]>): Promise<Listed<T>> {
	try {
		return { kind: "ok", items: await get() };
	} catch (error) {
		if (
			error instanceof OpenrError &&
			error.status !== undefined &&
			[401, 403, 404].includes(error.status)
		) {
			return { kind: "not-allowed", status: error.status };
		}
		throw error;
	}
}

/** Text from OpenR, safe to print: no control characters, one line, at most 80 characters. */
export function clean(text: string): string {
	const plain = text
		.replace(/\p{Cc}/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
	return plain.length > 80 ? `${plain.slice(0, 79)}…` : plain || "(no name)";
}

/** The listing `just openr-doors` prints. */
export function formatInventory(inventory: OpenrInventory, limit: number): string {
	const lines: string[] = [];
	const mineIds = new Set(
		inventory.mine.kind === "ok" ? inventory.mine.items.map((d) => d.id) : [],
	);
	const full = (n: number) => (n >= limit ? ` (OpenR's limit of ${limit}: there may be more)` : "");
	const doorLine = (door: OpenrDoorInfo) =>
		`    ${door.id.padStart(6)}  ${clean(door.name)}${mineIds.has(door.id) ? "  ✓ Pixel's account can open it" : ""}`;

	if (inventory.buildings.kind === "ok") {
		lines.push(
			`Buildings (${inventory.buildings.items.length})${full(inventory.buildings.items.length)}:`,
		);
		for (const building of inventory.buildings.items) {
			lines.push(`  ${building.id.padStart(6)}  ${clean(building.name)}`);
			const doors = inventory.doors.get(building.id);
			if (doors?.kind === "ok") {
				if (doors.items.length === 0) lines.push("    (no doors)");
				for (const door of doors.items) lines.push(doorLine(door));
				if (full(doors.items.length)) lines.push(`   ${full(doors.items.length)}`);
			} else if (doors) {
				lines.push(`    (this account can't list its doors: HTTP ${doors.status})`);
			}
		}
	} else {
		lines.push(
			`This account can't list buildings (HTTP ${inventory.buildings.status}), only the doors it may open.`,
		);
	}

	lines.push("");
	if (inventory.mine.kind === "ok") {
		lines.push(
			`Doors Pixel's account can open (${inventory.mine.items.length})${full(inventory.mine.items.length)}:`,
		);
		if (inventory.mine.items.length === 0) lines.push("  (none)");
		for (const door of inventory.mine.items) {
			const where = door.buildingId === undefined ? "" : `  (building ${door.buildingId})`;
			lines.push(`  ${door.id.padStart(6)}  ${clean(door.name)}${where}`);
		}
	} else {
		lines.push(`This account can't list its own doors (HTTP ${inventory.mine.status}).`);
	}

	const suggested = suggestSettings(inventory);
	if (suggested.length > 0) {
		lines.push("", "Suggested settings (check the names, and move the gate to OPENR_GATE_DOOR):");
		for (const line of suggested) lines.push(`  ${line}`);
	}
	return `${lines.join("\n")}\n`;
}

/**
 * `OPENR_BUILDING_ID` and `OPENR_DOORS` for the doors the account can open, when
 * they're all in one building. Names are made valid for `OPENR_DOORS` (no `,` or `=`,
 * at most 50 characters, none twice).
 */
export function suggestSettings(inventory: OpenrInventory): string[] {
	if (inventory.mine.kind !== "ok" || inventory.mine.items.length === 0) return [];
	const buildings = new Set(inventory.mine.items.map((d) => d.buildingId));
	// Pixel opens doors in one building: with several, pick by hand from the listing.
	if (buildings.size > 1) return [];
	const [building] = buildings;
	const seen = new Set<string>();
	const pairs = inventory.mine.items.slice(0, 25).map((door) => {
		let name = clean(door.name)
			.replace(/[,=]/g, " ")
			.replace(/\s+/g, " ")
			.replace("…", "")
			.trim()
			.slice(0, 40)
			.trim();
		if (name === "" || seen.has(name.toLowerCase())) name = `${name} ${door.id}`.trim();
		seen.add(name.toLowerCase());
		return `${name}=${door.id}`;
	});
	return [
		...(building === undefined ? [] : [`OPENR_BUILDING_ID=${building}`]),
		`OPENR_DOORS=${pairs.join(", ")}`,
	];
}
