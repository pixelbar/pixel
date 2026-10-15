/**
 * The decisions behind `just ha-devices`, kept apart from the prompts and the
 * Azure calls so they can be tested. See `ha-devices.ts` for the flow.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMap, isSeq, parseDocument, type YAMLMap } from "yaml";
import type { HomeKind } from "../src/core/home-kinds/index.ts";
import {
	DEVICES_FILE,
	type HomeDevicesView,
	type HomeDeviceTier,
	loadHomeDevices,
} from "../src/services/home-devices.ts";
import type { Target } from "./envs.ts";
import type { InventoryEntry } from "./ha-inventory.ts";

/** Where `devices.yaml` sits on an env's file share (Pixel mounts it at `/app/persist`). */
export const DEVICES_PATH = `home-assistant/${DEVICES_FILE}`;

/** The local copy of an env's remote file. Gitignored, like every devices file. */
export function mirrorDir(target: Target): string {
	return join("config", "home-assistant", target);
}

/**
 * The remote is the truth and the local file only mirrors it. A local file that
 * differs has edits the remote never got, so the tool stops rather than guess.
 */
export function compareMirror(
	local: string | undefined,
	remote: string,
): "missing" | "same" | "differs" {
	if (local === undefined) return "missing";
	return local === remote ? "same" : "differs";
}

/** Checks a devices file's text exactly as Pixel will. Throws `HomeDevicesError`. */
export function validateDevices(
	text: string,
	kinds: ReadonlyMap<string, HomeKind>,
): HomeDevicesView {
	const dir = mkdtempSync(join(tmpdir(), "pixel-ha-devices-"));
	try {
		writeFileSync(join(dir, DEVICES_FILE), text, { mode: 0o600 });
		return loadHomeDevices(dir, kinds);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** One line in the picker: something Home Assistant has, something already listed, or both. */
export type DeviceChoice = {
	entry: InventoryEntry;
	/** In `devices.yaml` now, so it starts ticked and unticking removes it. */
	listed: boolean;
	/** False for a listed device Home Assistant doesn't offer (gone, hidden or filed as setup). */
	inHomeAssistant: boolean;
};

/**
 * Everything the picker shows: what's listed first (in file order, including any
 * Home Assistant no longer offers, so they can be removed too), then the rest of
 * what Home Assistant has.
 */
export function deviceChoices(
	entries: readonly InventoryEntry[],
	listed: HomeDevicesView,
): DeviceChoice[] {
	const byEntity = new Map(entries.map((entry) => [entry.entity, entry]));
	const onList = listed.devices.map((device): DeviceChoice => {
		const entry = byEntity.get(device.entityId);
		return entry
			? { entry, listed: true, inHomeAssistant: true }
			: {
					entry: {
						name: device.name,
						entity: device.entityId,
						kind: device.kind.name,
						inDevicesFile: true,
					},
					listed: true,
					inHomeAssistant: false,
				};
	});
	const rest = entries
		.filter((entry) => !entry.inDevicesFile)
		.map((entry): DeviceChoice => ({ entry, listed: false, inHomeAssistant: true }));
	return [...onList, ...rest];
}

/** One line per choice in the picker. Searching "listed" finds what's on the list. */
export function choiceLabel({ entry, listed, inHomeAssistant }: DeviceChoice): string {
	const where = entry.area ? ` · ${entry.area}` : "";
	const base = `${entry.kind.padEnd(6)} ${entry.friendlyName ?? entry.name}${where}  (${entry.entity})`;
	if (!listed) return base;
	return `${base}  [listed as ${entry.name}${inHomeAssistant ? "" : ", hidden or missing in Home Assistant"}]`;
}

/** What to change: ticked but not listed is added, listed but unticked is removed. */
export function planChanges(
	choices: readonly DeviceChoice[],
	ticked: readonly DeviceChoice[],
): { add: InventoryEntry[]; remove: string[] } {
	const keep = new Set(ticked.map((choice) => choice.entry.entity));
	return {
		add: ticked.filter((choice) => !choice.listed).map((choice) => choice.entry),
		remove: choices
			.filter((choice) => choice.listed && !keep.has(choice.entry.entity))
			.map((choice) => choice.entry.name),
	};
}

const TIERS: readonly HomeDeviceTier[] = ["friend", "member", "admin"];

/** The tiers a device of this kind may have: never below the kind's own floor. */
export function tiersFor(kind: HomeKind): HomeDeviceTier[] {
	const floor = kind.minTier ? TIERS.indexOf(kind.minTier) : 0;
	return TIERS.slice(floor);
}

/**
 * The actions to offer for a kind. Doors are never offered on dev (dev must not
 * control the real doors), and elsewhere start unticked so opening the building
 * is always a deliberate choice.
 */
export function actionChoices(
	kind: HomeKind,
	target: Target,
): { name: string; checked: boolean }[] {
	if (kind.name === "door" && target === "dev") return [];
	return kind.actions.map((action) => ({ name: action.name, checked: kind.name !== "door" }));
}

const NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** Checks a device name someone typed. Returns an error message, or true. */
export function checkName(name: string, taken: ReadonlySet<string>): true | string {
	if (!NAME.test(name)) return "Lowercase words joined by '-', up to 32 characters";
	if (taken.has(name)) return "Another device already has that name";
	return true;
}

/** The suggested description: the friendly name, with the area when it fits. */
export function defaultDescription(entry: InventoryEntry): string | undefined {
	if (!entry.friendlyName) return undefined;
	const withArea = entry.area ? `${entry.friendlyName} (${entry.area})` : entry.friendlyName;
	return withArea.length <= 100 ? withArea : entry.friendlyName;
}

/** Inline lists like `[on, off]`, as people write them, and no line wrapping. */
const WRITE_OPTIONS = { lineWidth: 0, flowCollectionPadding: false } as const;

export type NewDevice = {
	name: string;
	entity: string;
	kind: string;
	actions: readonly string[];
	description?: string;
	/** Left out when it's the default (member). */
	minTier?: HomeDeviceTier;
};

/**
 * Adds devices to the end of the list, leaving everything already in the file
 * (comments, order, spacing) as it was. Actions are written inline, like
 * `[on, off]`, and left out when there are none (read-only).
 */
export function appendDevices(source: string, additions: readonly NewDevice[]): string {
	if (additions.length === 0) return source;
	const doc = parseDocument(source);
	const devices = doc.get("devices", true);
	if (!isSeq(devices)) throw new Error(`${DEVICES_FILE} has no devices list`);
	devices.flow = false;
	for (const device of additions) {
		const node = doc.createNode({
			name: device.name,
			entity: device.entity,
			kind: device.kind,
			...(device.actions.length > 0 ? { actions: [...device.actions] } : {}),
			...(device.description ? { description: device.description } : {}),
			...(device.minTier && device.minTier !== "member" ? { minTier: device.minTier } : {}),
		}) as YAMLMap;
		const actions = node.get("actions", true);
		if (isSeq(actions)) actions.flow = true;
		devices.items.push(node);
	}
	return doc.toString(WRITE_OPTIONS);
}

/**
 * Takes devices off the list by name, leaving the rest of the file as it was.
 * A comment written just above a removed device goes with it.
 */
export function removeDevices(source: string, names: readonly string[]): string {
	if (names.length === 0) return source;
	const doc = parseDocument(source);
	const devices = doc.get("devices", true);
	if (!isSeq(devices)) throw new Error(`${DEVICES_FILE} has no devices list`);
	const drop = new Set(names);
	const before = devices.items.length;
	devices.items = devices.items.filter(
		(item) => !(isMap(item) && drop.has(String(item.get("name")))),
	);
	if (before - devices.items.length !== drop.size) {
		throw new Error(`${DEVICES_FILE} doesn't list every device being removed`);
	}
	return doc.toString(WRITE_OPTIONS);
}
