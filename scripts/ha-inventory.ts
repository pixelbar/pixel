import type { HomeEntity } from "../src/core/home.ts";
import type { HomeKind } from "../src/core/home-kinds/index.ts";
import type { HomeDevicesView } from "../src/services/home-devices.ts";

/**
 * What Home Assistant has that Pixel has a kind for, as entries `just ha-devices`
 * can offer: a suggested name, the entity, its kind, and the friendly name and area
 * to recognise it by. It says what *exists*, never what may be used: a device is
 * usable only when `devices.yaml` lists it. Nothing here is written to a file.
 */

export const MAX_INVENTORY = 1000;
const NAME_MAX = 32;
const TEXT_MAX = 100;

export type InventoryEntry = {
	/** A suggested name for `devices.yaml`: valid, unique and at most 32 characters. */
	name: string;
	entity: string;
	kind: string;
	friendlyName?: string;
	area?: string;
	/** Already listed in `devices.yaml`, under `name`. */
	inDevicesFile?: true;
};

export type InventoryBuild = { entries: InventoryEntry[]; dropped: number };

/** Text from Home Assistant, made safe to put in a file and show to people. */
function clean(text: string | undefined): string | undefined {
	if (text === undefined) return undefined;
	const tidy = text.replace(/\p{C}/gu, " ").replace(/\s+/g, " ").trim();
	return tidy === "" ? undefined : tidy.slice(0, TEXT_MAX);
}

function slug(text: string): string {
	return text
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** A name people can type, from what Home Assistant calls it. Not yet unique. */
function suggest(entity: HomeEntity, kind: HomeKind): string {
	const objectId = entity.entityId.slice(entity.entityId.indexOf(".") + 1);
	let base = slug(entity.name ?? "") || slug(objectId) || kind.name;
	if (!/^[a-z]/.test(base)) base = `${kind.name}-${base}`;
	return base.slice(0, NAME_MAX).replace(/-+$/, "");
}

/** Adds a number until the name is free, keeping within the length limit. */
function unique(base: string, taken: Set<string>): string {
	let name = base;
	for (let n = 2; taken.has(name); n++) {
		const suffix = `-${n}`;
		name = `${base.slice(0, NAME_MAX - suffix.length).replace(/-+$/, "")}${suffix}`;
	}
	taken.add(name);
	return name;
}

/**
 * Picks what belongs in the inventory: entities with a kind that Home Assistant
 * hasn't filed as setup or diagnostics and nobody hid. Sorted (by kind, then
 * entity) so the file only changes when something real does.
 */
export function buildInventory(
	entities: readonly HomeEntity[],
	kinds: ReadonlyMap<string, HomeKind>,
	devices: HomeDevicesView,
): InventoryBuild {
	const kindOrder = [...kinds.values()];
	const kindByDomain = new Map<string, HomeKind>();
	for (const kind of kindOrder) for (const domain of kind.domains) kindByDomain.set(domain, kind);

	const listedByEntity = new Map(devices.devices.map((device) => [device.entityId, device]));
	const taken = new Set(devices.devices.map((device) => device.name));

	const wanted = new Map<string, { entity: HomeEntity; kind: HomeKind }>();
	for (const entity of entities) {
		if (entity.category !== undefined || entity.hidden) continue;
		const kind = kindByDomain.get(entity.entityId.slice(0, entity.entityId.indexOf(".")));
		if (kind) wanted.set(entity.entityId, { entity, kind });
	}

	const sorted = [...wanted.values()].sort(
		(a, b) =>
			kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind) ||
			(a.entity.entityId < b.entity.entityId ? -1 : a.entity.entityId > b.entity.entityId ? 1 : 0),
	);
	const kept = sorted.slice(0, MAX_INVENTORY);

	const entries = kept.map(({ entity, kind }): InventoryEntry => {
		const listed = listedByEntity.get(entity.entityId);
		const friendlyName = clean(entity.name);
		const area = clean(entity.area);
		return {
			name: listed ? listed.name : unique(suggest(entity, kind), taken),
			entity: entity.entityId,
			kind: kind.name,
			...(friendlyName ? { friendlyName } : {}),
			...(area ? { area } : {}),
			...(listed ? { inDevicesFile: true as const } : {}),
		};
	});
	return { entries, dropped: sorted.length - kept.length };
}
