import type { Access } from "../../core/access.ts";
import type { CommandContext, CommandOption, Suggestion } from "../../core/command.ts";
import { MAX_SUGGESTIONS } from "../../core/dispatcher.ts";
import { UserFacingError } from "../../core/errors.ts";
import type { Feature } from "../../core/feature.ts";
import { escapeMarkdown, formatDuration, inlineCode } from "../../core/format.ts";
import { type EntityState, HOME_MESSAGES, type Home } from "../../core/home.ts";
import {
	canActOnDevice,
	canViewDevice,
	HOME_DENIED,
	visibleDevices,
} from "../../core/home-access.ts";
import type { KindAction, KindAttribute } from "../../core/home-kinds/index.ts";
import type { ErrorReporter } from "../../core/ports/error-reporter.ts";
import type { Embed, EmbedField, Reply } from "../../core/reply.ts";
import type {
	ActionContext,
	ActionDefinition,
	ActionResult,
	Control,
	ControlRow,
} from "../../core/ui.ts";
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
	 * Emergency switches (`/admin` → Doors): a kind that is switched off can't be acted
	 * on by anyone, whatever they hold. Everything is on when this is left out.
	 */
	switches?: Pick<KindSwitch, "isOn">;
	now?: () => Date;
};

/** The lowest floor any device can have. Each device's own floor is checked by the shared rule. */
const FLOOR: Access = { minTier: "friend" };

/** Devices on one page of the list (Discord shows 25 options in a menu). */
export const PAGE_SIZE = 25;

/** The actions behind `/ha`'s menu and buttons. */
export const HOME_ACTIONS = {
	list: "ha.list",
	device: "ha.device",
	act: "ha.act",
} as const;

const button = (
	label: string,
	action: string,
	args: Record<string, string | number> = {},
	disabled = false,
	style: "primary" | "secondary" = "secondary",
): Control => ({
	kind: "button",
	label,
	style,
	call: { action, args },
	...(disabled ? { disabled } : {}),
});

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
 * `/ha`: the Home Assistant devices Pixel knows about, as a private panel (see
 * docs/discord-components.md). The list shows every device this person may see,
 * with a menu to pick one; a device shows its live state and a button for each
 * action they may take on it. Who may see and change which device comes only from
 * the shared rule in `core/home-access.ts`, checked again on every click, and every
 * change goes through `DeviceControl`. Everything Home Assistant says is shown as
 * inert text. Each read asks Home Assistant fresh: nothing is cached.
 */
export function createHomeFeature(deps: HomeFeatureDeps): Feature {
	const now = deps.now ?? (() => new Date());
	const control = deps.control ?? new DeviceControl({ home: deps.home });
	const isOff = (kind: string) => (deps.switches ? !deps.switches.isOn(kind) : false);
	const notSetUp = (): Reply => ({ text: HOME_MESSAGES.notSetUp, private: true });

	/**
	 * Runs one action from a device's button: checks the device, the action and
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

	/** Who may see a device, checked fresh every time; the real reason goes in the log. */
	const viewable = (
		name: string,
		{ principal, logger }: Pick<CommandContext, "principal" | "logger">,
	): HomeDevice | undefined => {
		const device = deps.homeDevices.view.byName.get(name);
		const decision = device ? canViewDevice(device, principal) : undefined;
		if (device && decision?.allowed) return device;
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
		return undefined;
	};

	/** Every device this person may see, a page at a time, with a menu to pick one. */
	const listPanel = async (
		{ principal, logger }: Pick<CommandContext, "principal" | "logger">,
		page = 0,
	): Promise<Reply> => {
		const devices = visibleDevices(deps.homeDevices.view.devices, principal);
		if (devices.length === 0) {
			return { text: "There are no devices available to you.", private: true };
		}
		const pages = Math.ceil(devices.length / PAGE_SIZE);
		const current = Math.min(Math.max(0, page), pages - 1);
		const shown = devices.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
		const states = await deps.home.getStates(shown.map((d) => d.entityId));
		logger.info({ event: "home.list", devices: devices.length }, "listed devices");
		const rows: ControlRow[] = [
			[
				{
					kind: "select",
					placeholder: "Choose a device…",
					call: { action: HOME_ACTIONS.device },
					arg: "device",
					options: shown.map((device) => ({
						label: device.name,
						value: device.name,
						// Plain text: a menu shows no markdown.
						description:
							`${capitalize(device.kind.name)} · ${plainReading(states.get(device.entityId))}${device.description ? ` · ${device.description}` : ""}`.slice(
								0,
								100,
							),
					})),
				},
			],
		];
		if (pages > 1) {
			rows.push([
				button("‹ Previous", HOME_ACTIONS.list, { page: current - 1 }, current === 0),
				button("Next ›", HOME_ACTIONS.list, { page: current + 1 }, current >= pages - 1),
			]);
		}
		rows.push([button("Refresh", HOME_ACTIONS.list, { page: current })]);
		return {
			embeds: [
				describeList(shown, states, pages > 1 ? `Page ${current + 1} of ${pages}.` : undefined),
			],
			private: true,
			controls: rows,
		};
	};

	/**
	 * One device: its live state, and a button for each action this person may take on
	 * it now. Only the shared rule decides which; the buttons are a convenience, and the
	 * action checks everything again.
	 */
	const devicePanel = async (
		device: HomeDevice,
		{ principal, logger }: Pick<CommandContext, "principal" | "logger">,
		notice: Embed[] = [],
	): Promise<Reply> => {
		const state = (await deps.home.getStates([device.entityId])).get(device.entityId);
		// Who looked at what is logged for doors, like looking someone's level up.
		if (device.kind.name === "door") {
			logger.info(
				{ event: "home.status_viewed", device: device.name, kind: device.kind.name },
				"viewed the status of a door",
			);
		}
		const status = describeStatus(device, state, now());
		const usable = device.actions.filter((a) => canActOnDevice(device, a.name, principal).allowed);
		const off = usable.length > 0 && isOff(device.kind.name);
		if (off) {
			status.description = [
				status.description,
				`Controlling ${device.kind.name}s from Pixel is switched off by an admin right now.`,
			]
				.filter(Boolean)
				.join("\n");
		}
		const current = state?.state.toLowerCase();
		const actions: Control[] = off
			? []
			: usable.slice(0, 4).map((action) =>
					button(
						capitalize(action.name),
						HOME_ACTIONS.act,
						{ device: device.name, action: action.name },
						// Already there: nothing to do (a toggle always has something to do).
						action.done.length === 1 && action.done[0] === current,
						"primary",
					),
				);
		return {
			embeds: [...notice, status],
			private: true,
			controls: [
				...(actions.length > 0 ? [actions] : []),
				[
					button("← All devices", HOME_ACTIONS.list),
					button("Refresh", HOME_ACTIONS.device, { device: device.name }),
				],
			],
		};
	};

	const deviceArg: CommandOption = {
		name: "device",
		description: "Which device",
		type: "string",
		required: true,
	};
	const action = (
		name: string,
		options: readonly CommandOption[],
		handler: (ctx: ActionContext) => Promise<ActionResult>,
	): ActionDefinition => ({ name, access: FLOOR, options, handler });

	const actions: ActionDefinition[] = [
		action(
			HOME_ACTIONS.list,
			[{ name: "page", description: "Which page", type: "integer" }],
			async (ctx) => {
				if (!deps.homeDevices.configured) return { reply: notSetUp() };
				return { reply: await listPanel(ctx, Number(ctx.args.page ?? 0)) };
			},
		),
		action(HOME_ACTIONS.device, [deviceArg], async (ctx) => {
			if (!deps.homeDevices.configured) return { reply: notSetUp() };
			const device = viewable(String(ctx.args.device), ctx);
			if (!device) throw new UserFacingError(HOME_DENIED);
			return { reply: await devicePanel(device, ctx) };
		}),
		action(
			HOME_ACTIONS.act,
			[deviceArg, { name: "action", description: "What to do", type: "string", required: true }],
			async (ctx) => {
				if (!deps.homeDevices.configured) return { reply: notSetUp() };
				const device = deps.homeDevices.view.byName.get(String(ctx.args.device));
				const result = await act(device, String(ctx.args.action), ctx);
				// Refused: say so privately and leave the panel as it was.
				if (!result.embeds || !device) throw new UserFacingError(result.text ?? HOME_DENIED);
				try {
					return { reply: await devicePanel(device, ctx, result.embeds) };
				} catch (error) {
					if (!(error instanceof UserFacingError)) throw error;
					// Home Assistant went away after the action: still say what happened to it.
					return {
						reply: {
							embeds: [
								...result.embeds,
								{
									title: device.name,
									description: `${error.message} Press **Refresh** to see its state.`,
									accent: "warning",
								},
							],
							private: true,
							controls: [
								[
									button("← All devices", HOME_ACTIONS.list),
									button("Refresh", HOME_ACTIONS.device, { device: device.name }),
								],
							],
						},
					};
				}
			},
		),
	];

	return {
		name: "home",
		commands: [
			{
				name: "ha",
				description: "The Home Assistant devices you may use: see them, and change them",
				// The lowest floor any device can have. Each device's own floor is checked by the shared rule.
				access: FLOOR,
				private: true,
				options: [
					{
						name: "device",
						description: "Go straight to one device (leave out to choose)",
						type: "string",
						suggest: async ({ typed, principal }) =>
							deps.homeDevices.configured
								? suggestDevices(visibleDevices(deps.homeDevices.view.devices, principal), typed)
								: [],
					},
				],
				handler: async (ctx): Promise<Reply> => {
					if (!deps.homeDevices.configured) return notSetUp();
					if (typeof ctx.args.device !== "string") return listPanel(ctx);
					// Autocomplete isn't validation: look the device up again, and check this person may see it.
					const device = viewable(ctx.args.device, ctx);
					return device ? devicePanel(device, ctx) : { text: HOME_DENIED, private: true };
				},
			},
		],
		actions,
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

/** The state as plain text, for a menu: no marks, no code spans. */
function plainReading(entity: EntityState | undefined): string {
	if (!entity) return "not in Home Assistant";
	const unit = entity.attributes.unit_of_measurement;
	const state = tidyNumber(entity.state).replace(/\s+/g, " ").slice(0, STATE_MAX);
	return typeof unit === "string" && unit.trim() !== "" ? `${state} ${unit.slice(0, 10)}` : state;
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
	page?: string,
): Embed {
	const byKind = new Map<string, HomeDevice[]>();
	for (const device of devices) {
		byKind.set(device.kind.name, [...(byKind.get(device.kind.name) ?? []), device]);
	}
	const fields: EmbedField[] = [...byKind.entries()].map(([kind, members]) => ({
		name: kindHeading(kind, members.length),
		value: joinWithinLimit(
			members.map((device) => `**${device.name}** ${reading(device, states.get(device.entityId))}`),
		),
	}));
	return {
		title: "🏠 Devices",
		description: [
			"Choose a device below to see more, or to change it.",
			...(page ? [page] : []),
		].join(" "),
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

/** "Light · 1", "Lights · 2", "Switches · 2" (not "Switchs"). */
function kindHeading(kind: string, count: number): string {
	return `${capitalize(count === 1 ? kind : pluralize(kind))} · ${count}`;
}

function pluralize(kind: string): string {
	if (
		kind.endsWith("s") ||
		kind.endsWith("x") ||
		kind.endsWith("z") ||
		kind.endsWith("ch") ||
		kind.endsWith("sh")
	) {
		return `${kind}es`;
	}
	return `${kind}s`;
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
				description: `${name} is still ${code(result.after)} after ${seconds}s. ${sent} Press **Refresh** to check.`,
				accent: "warning",
			};
		case "no-change":
			return {
				title: "⚠️ Nothing changed",
				description: `${name} still shows ${code(result.after)} after ${seconds}s. ${sent} Press **Refresh** to check.`,
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
				description: `I couldn't confirm what happened to ${name}: the command may or may not have gone through. ${sent} Press **Refresh** to check.`,
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
