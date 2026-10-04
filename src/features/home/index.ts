import type { Suggestion } from "../../core/command.ts";
import { MAX_SUGGESTIONS } from "../../core/dispatcher.ts";
import type { Feature } from "../../core/feature.ts";
import { escapeMarkdown, formatDuration, inlineCode } from "../../core/format.ts";
import { type EntityState, HOME_MESSAGES, type Home } from "../../core/home.ts";
import { canViewDevice, HOME_DENIED, visibleDevices } from "../../core/home-access.ts";
import type { KindAttribute } from "../../core/home-kinds/index.ts";
import type { Embed, EmbedField, Reply } from "../../core/reply.ts";
import type { HomeDevice, HomeDeviceStore } from "../../services/home-devices.ts";

export type HomeFeatureDeps = {
	home: Pick<Home, "getStates">;
	homeDevices: Pick<HomeDeviceStore, "view" | "configured">;
	now?: () => Date;
};

/** An embed field holds at most 1024 characters. */
const FIELD_LIMIT = 1000;
const STATE_MAX = 40;
const VALUE_MAX = 60;

/** The sort of thing a state can say that isn't a real reading, shown as itself and never as "off". */
const NO_READING: Readonly<Record<string, string>> = {
	unavailable: "⚠️ unavailable",
	unknown: "❔ unknown",
};

/**
 * `/ha`: the Home Assistant devices Pixel knows about. `list` and `status` only
 * read. Who may see which device comes from the shared rule in `core/home-access.ts`
 * (the tier floor of each device), and everything Home Assistant says is shown as
 * inert text. Each read asks Home Assistant fresh: nothing is cached.
 */
export function createHomeFeature(deps: HomeFeatureDeps): Feature {
	const now = deps.now ?? (() => new Date());
	const notSetUp = (): Reply => ({ text: HOME_MESSAGES.notSetUp, private: true });

	return {
		name: "home",
		commands: [
			{
				name: "ha",
				description: "See the Home Assistant devices you may use",
				// The lowest floor any device can have. Each device's own floor is checked by the shared rule.
				access: { minTier: "friend" },
				subcommands: [
					{
						name: "list",
						description: "The devices you may use, and their state",
						access: { minTier: "friend" },
						private: true,
						handler: async ({ principal, logger }): Promise<Reply> => {
							if (!deps.homeDevices.configured) return notSetUp();
							const devices = visibleDevices(deps.homeDevices.view.devices, principal);
							if (devices.length === 0) {
								return { text: "There are no devices available to you.", private: true };
							}
							const states = await deps.home.getStates(devices.map((d) => d.entityId));
							logger.info({ event: "home.list", devices: devices.length }, "listed devices");
							return { embeds: [describeList(devices, states)] };
						},
					},
					{
						name: "status",
						description: "The live state of one device",
						access: { minTier: "friend" },
						private: true,
						options: [
							{
								name: "device",
								description: "Which device",
								type: "string",
								required: true,
								suggest: async ({ typed, principal }) =>
									deps.homeDevices.configured
										? suggestDevices(
												visibleDevices(deps.homeDevices.view.devices, principal),
												typed,
											)
										: [],
							},
						],
						handler: async ({ args, principal, logger }): Promise<Reply> => {
							if (!deps.homeDevices.configured) return notSetUp();
							// Autocomplete isn't validation: look the device up again, and check this person may see it.
							const device = deps.homeDevices.view.byName.get(String(args.device ?? ""));
							const decision = device ? canViewDevice(device, principal) : undefined;
							if (!device || !decision?.allowed) {
								// The real reason goes in the log. The typed text doesn't: it could be anything.
								logger.warn(
									{
										event: "home.status_denied",
										reason: device
											? decision && !decision.allowed
												? decision.reason
												: "tier"
											: "unknown-device",
										...(device ? { device: device.name } : {}),
									},
									"refused a device status",
								);
								return { text: HOME_DENIED, private: true };
							}
							const state = (await deps.home.getStates([device.entityId])).get(device.entityId);
							// Who looked at what is logged for doors, like looking someone's level up.
							if (device.kind.name === "door") {
								logger.info(
									{ event: "home.status_viewed", device: device.name, kind: device.kind.name },
									"viewed the status of a door",
								);
							}
							return { embeds: [describeStatus(device, state, now())] };
						},
					},
				],
			},
		],
	};
}

/** What shows for a state: itself in a code span, or a mark for one that isn't a reading. */
export function describeState(raw: string, warn: readonly string[] = []): string {
	const key = raw.toLowerCase();
	const mark = NO_READING[key];
	if (mark) return mark;
	if (warn.includes(key)) return `⚠️ ${inlineCode(raw, STATE_MAX)}`;
	return inlineCode(raw, STATE_MAX);
}

/** The state with its unit, when it has one, such as `21.5 °C`. */
function reading(device: HomeDevice, entity: EntityState | undefined): string {
	if (!entity) return "❔ not in Home Assistant";
	const mark = NO_READING[entity.state.toLowerCase()];
	if (mark) return mark;
	const unit = entity.attributes.unit_of_measurement;
	if (typeof unit === "string" && unit.trim() !== "") {
		return inlineCode(`${tidyNumber(entity.state)} ${unit}`, STATE_MAX);
	}
	return describeState(tidyNumber(entity.state), device.kind.warnStates);
}

function describeList(
	devices: readonly HomeDevice[],
	states: ReadonlyMap<string, EntityState>,
): Embed {
	const byKind = new Map<string, HomeDevice[]>();
	for (const device of devices) {
		byKind.set(device.kind.name, [...(byKind.get(device.kind.name) ?? []), device]);
	}
	const fields: EmbedField[] = [...byKind.entries()].map(([kind, members]) => ({
		name: `${capitalize(kind)} · ${members.length}`,
		value: joinWithinLimit(
			members.map((device) => `**${device.name}** ${reading(device, states.get(device.entityId))}`),
		),
	}));
	return {
		title: "🏠 Devices",
		description: "Use `/ha status` for more about one.",
		fields,
		accent: "brand",
	};
}

/** Joins lines up to a field's limit, saying how many didn't fit. */
function joinWithinLimit(lines: readonly string[]): string {
	const kept: string[] = [];
	let length = 0;
	for (const [index, line] of lines.entries()) {
		const left = lines.length - index;
		const reserve = left > 1 ? 40 : 0;
		if (length + line.length + 1 + reserve > FIELD_LIMIT) {
			kept.push(`…and ${left} more.`);
			return kept.join("\n");
		}
		kept.push(line);
		length += line.length + 1;
	}
	return kept.join("\n");
}

function describeStatus(device: HomeDevice, entity: EntityState | undefined, now: Date): Embed {
	const description = device.description ? escapeMarkdown(device.description) : undefined;
	if (!entity) {
		return {
			title: device.name,
			...(description ? { description } : {}),
			fields: [{ name: "State", value: "❔ not in Home Assistant right now" }],
			accent: "warning",
		};
	}
	const fields: EmbedField[] = [
		{ name: "State", value: reading(device, entity), inline: true },
		{ name: "Kind", value: capitalize(device.kind.name), inline: true },
		{
			name: "Last changed",
			value: entity.lastChanged
				? `${formatDuration(now.getTime() - entity.lastChanged.getTime())} ago`
				: "unknown",
			inline: true,
		},
	];
	for (const attribute of device.kind.attributes ?? []) {
		const value = formatAttribute(attribute, entity.attributes[attribute.key]);
		if (value) fields.push({ name: attribute.label, value, inline: true });
	}
	const state = entity.state.toLowerCase();
	const bad = state in NO_READING || (device.kind.warnStates ?? []).includes(state);
	return {
		title: device.name,
		...(description ? { description } : {}),
		fields,
		accent: bad ? "warning" : "brand",
	};
}

/** Shows an attribute from Home Assistant as inert text, or nothing when it's missing or the wrong sort of value. */
function formatAttribute(attribute: KindAttribute, value: unknown): string | undefined {
	switch (attribute.format) {
		case "text":
			return typeof value === "string" && value.trim() !== ""
				? inlineCode(value, VALUE_MAX)
				: undefined;
		case "number":
			return typeof value === "number" && Number.isFinite(value) ? `${round(value)}` : undefined;
		case "percent":
			return typeof value === "number" && Number.isFinite(value) ? `${round(value)}%` : undefined;
		case "percent255":
			return typeof value === "number" && Number.isFinite(value)
				? `${Math.round((Math.min(Math.max(value, 0), 255) / 255) * 100)}%`
				: undefined;
	}
}

/** A reading like 23.7000007629395 as 23.7. Anything that isn't a plain number is left alone. */
function tidyNumber(state: string): string {
	if (!/^-?\d+(\.\d+)?$/.test(state)) return state;
	const value = Number(state);
	return Number.isFinite(value) ? `${Math.round(value * 100) / 100}` : state;
}

function round(value: number): number {
	return Math.round(value * 10) / 10;
}

/** Devices matching what's been typed, best matches first, within Discord's limit. Never asks Home Assistant. */
function suggestDevices(devices: readonly HomeDevice[], typed: string): Suggestion[] {
	const needle = typed.trim().toLowerCase();
	const matches = devices.filter(
		(device) =>
			needle === "" ||
			device.name.includes(needle) ||
			device.description?.toLowerCase().includes(needle) === true,
	);
	matches.sort(
		(a, b) =>
			Number(b.name.startsWith(needle)) - Number(a.name.startsWith(needle)) ||
			a.name.localeCompare(b.name),
	);
	return matches.slice(0, MAX_SUGGESTIONS).map((device) => ({
		name: `${device.name} (${device.kind.name})${device.description ? ` · ${device.description}` : ""}`.slice(
			0,
			100,
		),
		value: device.name,
	}));
}

function capitalize(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}
