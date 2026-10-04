import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stringify } from "yaml";
import { type Home, type HomeEntity, HomeUnavailableError } from "../core/home.ts";
import type { HomeKind } from "../core/home-kinds/index.ts";
import type { Logger } from "../core/logger.ts";
import type { HomeDevicesView } from "./home-devices.ts";

/**
 * The inventory of everything Home Assistant has that Pixel has a kind for,
 * written to `config/home-assistant/inventory.yaml`. It says what *exists*, so a
 * person can copy an entry into `devices.yaml` and give it a tier and actions.
 *
 * It is not an allow-list and nothing reads it to decide anything: entries have no
 * tier and no actions, and the file is never loaded back into Pixel. A device is
 * usable only when `devices.yaml` (written by a person) lists it.
 */

export const INVENTORY_FILE = "inventory.yaml";
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

const HEADER = `# Written by Pixel from Home Assistant, and rewritten on every sync: don't edit it.
# This is NOT an allow-list. Nothing listed here can be listed, read or controlled
# through Pixel. To use a device, copy it into devices.yaml and give it a tier and
# actions. Safe to delete.
`;

export type InventorySync =
	| { kind: "synced"; count: number; previous: number | undefined; changed: boolean }
	| { kind: "skipped"; reason: "not-set-up" | "unavailable" | "failed" };

export type HomeInventoryOptions = {
	home: Pick<Home, "status" | "listEntities">;
	kinds: ReadonlyMap<string, HomeKind>;
	devices: { readonly view: HomeDevicesView };
	/** Where to write it, such as `config/home-assistant/inventory.yaml`. */
	file: string;
	logger: Logger;
	/** How often the feature syncs. 0 means only at startup and on `/admin reload`. */
	intervalMs?: number;
	now?: () => Date;
};

export class HomeInventory {
	readonly #options: HomeInventoryOptions | undefined;
	readonly intervalMs: number;
	#last: { at: Date; count: number } | undefined;
	#skipLogged = false;
	#running: Promise<InventorySync> | undefined;

	constructor(options?: HomeInventoryOptions) {
		this.#options = options;
		this.intervalMs = options?.intervalMs ?? 0;
	}

	/** For when Home Assistant isn't set up: nothing to sync. */
	static off(): HomeInventory {
		return new HomeInventory();
	}

	get configured(): boolean {
		return this.#options !== undefined;
	}

	/** When it last synced and how many it found, if it has. */
	get last(): { at: Date; count: number } | undefined {
		return this.#last;
	}

	/** Syncs once, never throws, and never retries: the next run is the retry. Runs don't overlap. */
	sync(): Promise<InventorySync> {
		this.#running ??= this.#run().finally(() => {
			this.#running = undefined;
		});
		return this.#running;
	}

	async #run(): Promise<InventorySync> {
		const options = this.#options;
		if (!options || options.home.status().kind === "unconfigured") {
			return { kind: "skipped", reason: "not-set-up" };
		}
		const logger = options.logger.child({ component: "home-inventory" });
		const now = options.now ?? (() => new Date());
		try {
			const entities = await options.home.listEntities();
			const { entries, dropped } = buildInventory(entities, options.kinds, options.devices.view);
			const at = now();
			const changed = this.#write(options.file, entries, at);
			const previous = this.#last?.count;
			this.#last = { at, count: entries.length };
			this.#skipLogged = false;
			logger.info(
				{ event: "home.inventory_synced", count: entries.length, changed, dropped },
				"synced the Home Assistant inventory",
			);
			if (dropped > 0) {
				logger.warn(
					{ event: "home.inventory_truncated", limit: MAX_INVENTORY, dropped },
					"the Home Assistant inventory was cut short",
				);
			}
			return { kind: "synced", count: entries.length, previous, changed };
		} catch (error) {
			// Unreachable is an outage. Anything else (Home Assistant refusing the list, a
			// full disk, a bug) is "failed", and is logged every time.
			const unavailable = error instanceof HomeUnavailableError;
			// An outage is logged once, not every hour, until a sync works again.
			if (!unavailable || !this.#skipLogged) {
				this.#skipLogged = unavailable;
				logger.warn(
					{
						event: "home.inventory_skipped",
						why: unavailable ? "unavailable" : "failed",
						err: error,
					},
					"couldn't sync the Home Assistant inventory",
				);
			}
			return { kind: "skipped", reason: unavailable ? "unavailable" : "failed" };
		}
	}

	/** Writes the file atomically, and only when something other than the time changed. */
	#write(file: string, entries: readonly InventoryEntry[], at: Date): boolean {
		const body = stringify({ inventory: entries });
		let existing: string | undefined;
		try {
			existing = readFileSync(file, "utf8")
				.split("\n")
				.filter((line) => !line.startsWith("#"))
				.join("\n");
		} catch {
			existing = undefined;
		}
		if (existing === body) return false;
		mkdirSync(dirname(file), { recursive: true });
		const temp = `${file}.tmp`;
		writeFileSync(temp, `${HEADER}# Synced ${at.toISOString()}\n${body}`, { mode: 0o600 });
		renameSync(temp, file);
		return true;
	}
}
