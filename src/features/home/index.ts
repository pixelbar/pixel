import type { CommandContext, Suggestion } from "../../core/command.ts";
import { MAX_SUGGESTIONS } from "../../core/dispatcher.ts";
import type { Feature } from "../../core/feature.ts";
import { escapeMarkdown, formatDuration, inlineCode } from "../../core/format.ts";
import { type EntityState, HOME_MESSAGES, type Home } from "../../core/home.ts";
import {
	actionableDevices,
	canActOnDevice,
	canViewDevice,
	HOME_DENIED,
	visibleDevices,
} from "../../core/home-access.ts";
import type { KindAction, KindAttribute } from "../../core/home-kinds/index.ts";
import type { ErrorReporter } from "../../core/ports/error-reporter.ts";
import type { Embed, EmbedField, Reply } from "../../core/reply.ts";
import type { HomeDevice, HomeDeviceStore } from "../../services/home-devices.ts";
import type { KindSwitch } from "../../services/kind-switch.ts";
import { type ControlResult, DeviceControl } from "./control.ts";

export type HomeFeatureDeps = {
	home: Pick<Home, "getStates" | "callService">;
	homeDevices: Pick<HomeDeviceStore, "view" | "configured">;
	reporter?: Pick<ErrorReporter, "breadcrumb">;
	/** Runs the actions. Defaults to one that talks to `home`. */
	control?: Pick<DeviceControl, "run" | "timeoutMs">;
	/**
	 * Emergency switches (`/admin doors`): a kind that is switched off can't be acted
	 * on by anyone, whatever they hold. Everything is on when this is left out.
	 */
	switches?: Pick<KindSwitch, "isOn">;
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
	const control = deps.control ?? new DeviceControl({ home: deps.home });
	const isOff = (kind: string) => (deps.switches ? !deps.switches.isOn(kind) : false);
	const notSetUp = (): Reply => ({ text: HOME_MESSAGES.notSetUp, private: true });

	/**
	 * Runs one action for `/ha set` and `/ha open`: checks the device, the action and
	 * the person with the shared rule, refuses a kind an admin has switched off, then
	 * runs it through `DeviceControl` and logs it. Everything typed is checked here.
	 */
	const act = async (
		device: HomeDevice | undefined,
		wanted: string,
		{ principal, logger }: Pick<CommandContext, "principal" | "logger">,
	): Promise<Reply> => {
		// Everything typed is checked again, here, whatever was suggested.
		const decision = device ? canActOnDevice(device, wanted, principal) : undefined;
		const action = device?.actions.find((a) => a.name === wanted);
		if (!device || !decision?.allowed || !action) {
			// The real reason goes in the log. What was typed doesn't: it could be anything.
			logger.warn(
				{
					event: "home.action_denied",
					reason: !device
						? "unknown-device"
						: decision && !decision.allowed
							? decision.reason
							: "action",
					...(device ? { device: device.name } : {}),
				},
				"refused a device action",
			);
			return { text: HOME_DENIED, private: true };
		}
		if (isOff(device.kind.name)) {
			logger.warn(
				{
					event: "home.action_denied",
					reason: "kind-off",
					device: device.name,
					kind: device.kind.name,
				},
				"refused a device action: this kind is switched off",
			);
			return {
				text: `Controlling ${device.kind.name}s from Pixel is switched off by an admin right now.`,
				private: true,
			};
		}

		const result = await control.run(device, action);
		const fields = {
			event: "home.action",
			device: device.name,
			kind: device.kind.name,
			action: action.name,
			outcome: result.outcome,
			...(result.outcome === "not-attempted" ? { reason: result.reason } : {}),
			...(before(result) ? { before: shorten(before(result)) } : {}),
			...(after(result) ? { after: shorten(after(result)) } : {}),
			durationMs: result.durationMs,
		};
		logger.info(fields, "ran a device action");
		deps.reporter?.breadcrumb("home.action", `${action.name} ${device.name}: ${result.outcome}`, {
			user: `${principal.platform}:${principal.userId}`,
			device: device.name,
			action: action.name,
			outcome: result.outcome,
		});
		return {
			embeds: [describeResult(device, action, result, control.timeoutMs)],
			private: true,
		};
	};

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
					{
						name: "set",
						description: "Change a device, such as switching a light on or off",
						// The lowest floor any device can have. The shared rule decides per device and per action.
						access: { minTier: "friend" },
						private: true,
						placeholder: { text: "Working on it…", private: true },
						options: [
							{
								name: "device",
								description: "Which device",
								type: "string",
								required: true,
								suggest: async ({ typed, args, principal }) => {
									if (!deps.homeDevices.configured) return [];
									const devices = deps.homeDevices.view.devices;
									// Narrow by the state already chosen, when it's one that exists.
									const chosen = typeof args.state === "string" ? args.state : undefined;
									const known =
										chosen !== undefined &&
										devices.some((d) => d.actions.some((a) => a.name === chosen));
									return suggestDevices(
										actionableDevices(devices, principal, known ? chosen : undefined).filter(
											(device) => !isOff(device.kind.name),
										),
										typed,
									);
								},
							},
							{
								name: "state",
								description: "What to set it to, such as on or off",
								type: "string",
								required: true,
								suggest: async ({ typed, args, principal }) => {
									if (!deps.homeDevices.configured) return [];
									const device = deps.homeDevices.view.byName.get(String(args.device ?? ""));
									const usable = (d: HomeDevice) =>
										d.actions.filter(
											(a) => !isOff(d.kind.name) && canActOnDevice(d, a.name, principal).allowed,
										);
									// With a device chosen: what that device allows. Without: the values that work somewhere.
									const actions = device
										? usable(device)
										: uniqueActions(deps.homeDevices.view.devices.flatMap(usable));
									return suggestActions(actions, typed);
								},
							},
						],
						handler: async (context): Promise<Reply> => {
							if (!deps.homeDevices.configured) return notSetUp();
							const device = deps.homeDevices.view.byName.get(String(context.args.device ?? ""));
							return act(device, String(context.args.state ?? ""), context);
						},
					},
					{
						name: "open",
						description: "Open a door (unlatch it, or unlock it if it can't be unlatched)",
						access: { minTier: "member" },
						private: true,
						placeholder: { text: "Working on it…", private: true },
						options: [
							{
								name: "door",
								description: "Which door",
								type: "string",
								required: true,
								suggest: async ({ typed, principal }) => {
									if (!deps.homeDevices.configured || isOff("door")) return [];
									const doors = deps.homeDevices.view.devices.filter(
										(d) =>
											d.kind.name === "door" &&
											canActOnDevice(d, openingAction(d), principal).allowed,
									);
									return suggestDevices(doors, typed);
								},
							},
						],
						handler: async (context): Promise<Reply> => {
							if (!deps.homeDevices.configured) return notSetUp();
							const device = deps.homeDevices.view.byName.get(String(context.args.door ?? ""));
							// Only doors: anything else gets the same answer as a device that doesn't exist.
							const door = device?.kind.name === "door" ? device : undefined;
							if (device && !door) {
								context.logger.warn(
									{ event: "home.action_denied", reason: "not-a-door", device: device.name },
									"refused a device action",
								);
								return { text: HOME_DENIED, private: true };
							}
							return act(door, door ? openingAction(door) : "open", context);
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

const before = (result: ControlResult): string | undefined =>
	"before" in result ? result.before : undefined;
const after = (result: ControlResult): string | undefined =>
	"after" in result ? result.after : undefined;

/** A state from Home Assistant, short enough for a log line. */
function shorten(state: string | undefined): string {
	return (state ?? "").slice(0, STATE_MAX);
}

/** What happened, in plain words: exactly what the device reported, and that nothing is retried. */
function describeResult(
	device: HomeDevice,
	action: KindAction,
	result: ControlResult,
	timeoutMs: number,
): Embed {
	const name = `**${device.name}**`;
	const seconds = Math.round(timeoutMs / 1000);
	const code = (state: string) => describeState(state, device.kind.warnStates);
	const sent = "I sent the command once and won't send it again.";
	switch (result.outcome) {
		case "done":
			return {
				title: "✅ Done",
				description: `${name} is now ${code(result.after)} (it was ${code(result.before)}).`,
				accent: "positive",
			};
		case "already":
			return {
				title: "Already there",
				description: `${name} is already ${code(result.before)}. I didn't send anything.`,
				accent: "neutral",
			};
		case "in-progress":
			return {
				title: "⏳ Still working",
				description: `${name} is still ${code(result.after)} after ${seconds}s. ${sent} Check with \`/ha status\`.`,
				accent: "warning",
			};
		case "no-change":
			return {
				title: "⚠️ Nothing changed",
				description: `${name} still shows ${code(result.after)} after ${seconds}s. ${sent} Check with \`/ha status\`.`,
				accent: "warning",
			};
		case "failed":
			return {
				title: "⚠️ It didn't work",
				description: `${name} reports ${code(result.after)} after \`${action.name}\` (it was ${code(result.before)}). ${sent}`,
				accent: "negative",
			};
		case "unconfirmed":
			return {
				title: "⚠️ Can't confirm",
				description: `I couldn't confirm what happened to ${name}: the command may or may not have gone through. ${sent} Check with \`/ha status\`.`,
				accent: "warning",
			};
		case "rejected":
			return {
				title: "⚠️ Home Assistant refused",
				description: `${HOME_MESSAGES.refused} ${name} is still ${code(result.before)}. I didn't try again.`,
				accent: "negative",
			};
		case "not-attempted":
			return { title: "Not sent", description: notSent(name, result), accent: "warning" };
	}
}

function notSent(
	name: string,
	result: Extract<ControlResult, { outcome: "not-attempted" }>,
): string {
	switch (result.reason) {
		case "busy":
			return `Someone is already changing ${name}. Give it a moment.`;
		case "cooldown":
			return `${name} was only just changed. Give it a few seconds.`;
		case "missing":
			return `Home Assistant doesn't have ${name} right now, so I didn't send anything.`;
		case "unavailable":
			return `${name} is ${describeState(result.before ?? "unavailable")}, so I didn't send anything.`;
		case "under-way":
			return `${name} is already ${describeState(result.before ?? "")}, which means it's on its way. I didn't send anything.`;
	}
}

/** The same action on several devices, once. */
function uniqueActions(actions: readonly KindAction[]): KindAction[] {
	return [...new Map(actions.map((action) => [action.name, action])).values()];
}

/** Action names to complete, with what each does, best matches first. Never asks Home Assistant. */
function suggestActions(actions: readonly KindAction[], typed: string): Suggestion[] {
	const needle = typed.trim().toLowerCase();
	return actions
		.filter((action) => needle === "" || action.name.includes(needle))
		.sort(
			(a, b) =>
				Number(b.name.startsWith(needle)) - Number(a.name.startsWith(needle)) ||
				a.name.localeCompare(b.name),
		)
		.slice(0, MAX_SUGGESTIONS)
		.map((action) => ({
			name: `${action.name} · ${action.description}`.slice(0, 100),
			value: action.name,
		}));
}

/** What `/ha open` runs on a door: `open` (unlatch) when the devices file allows it, otherwise `unlock`. */
export function openingAction(door: Pick<HomeDevice, "actions">): string {
	return door.actions.some((a) => a.name === "open") ? "open" : "unlock";
}
