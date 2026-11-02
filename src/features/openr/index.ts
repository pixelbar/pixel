import { type Access, actorLogFields, actorRef } from "../../core/access.ts";
import type { CapabilityDefinition } from "../../core/capabilities.ts";
import { MAX_SUGGESTIONS } from "../../core/dispatcher.ts";
import type { Feature } from "../../core/feature.ts";
import type { DoorOpenResult, DoorSystem } from "../../core/ports/door-system.ts";
import type { ErrorReporter } from "../../core/ports/error-reporter.ts";
import type { Gate } from "../../core/ports/gate.ts";
import type { Reply } from "../../core/reply.ts";
import type { KindSwitch } from "../../services/kind-switch.ts";

/**
 * `/openr open`: opens one of the building's doors through OpenR, for a member with
 * the `openr` capability. Which doors exist comes only from the config (`OPENR_DOORS`);
 * the parking gate (`OPENR_GATE_DOOR`) is never among them, because only `/park` opens
 * it, for someone with a booking. `/admin doors off` stops both at once.
 *
 * Pixel decides who may open what: OpenR only sees Pixel's own account.
 */

export const OPENR_CAPABILITY: CapabilityDefinition = {
	name: "openr",
	description: "Open the building's doors through OpenR with /openr open",
};

const ACCESS: Access = { minTier: "member", capability: OPENR_CAPABILITY.name };

/** The switch `/admin doors` sets, shared with Home Assistant's doors. */
export const DOOR_SWITCH = "door";

/** A door Pixel may open: its name in Discord, and its ID in OpenR. */
export type OpenrDoor = { name: string; id: string };

export type OpenrFeatureDeps = {
	/** Undefined when OpenR isn't configured. */
	doors: Pick<DoorSystem, "open"> | undefined;
	/** The doors `/openr open` offers, from the config. */
	list: readonly OpenrDoor[];
	switches: Pick<KindSwitch, "isOn">;
	reporter?: Pick<ErrorReporter, "breadcrumb">;
};

export const OPENR_MESSAGES = {
	notSetUp: "Pixel can't open doors through OpenR here.",
	unknown: "I don't know that door. Pick one from the list.",
	off: "Opening doors from Pixel is switched off right now.",
} as const;

/** What to say after trying to open `door`. */
export function openedLine(door: string, result: DoorOpenResult): string {
	if (result.opened) return `🔓 **${door}** is opening.`;
	switch (result.reason) {
		case "logged-out":
			return "Pixel isn't logged in to OpenR right now, so it can't open doors. An admin can fix that with `/admin openr login`.";
		case "busy":
			return `**${door}** is already being opened.`;
		case "failed":
			return `⚠️ **${door}** didn't open. Try again in a moment.`;
	}
}

export function createOpenrFeature(deps: OpenrFeatureDeps): Feature {
	const byName = new Map(deps.list.map((door) => [door.name.toLowerCase(), door]));
	const isOff = () => !deps.switches.isOn(DOOR_SWITCH);

	return {
		name: "openr",
		commands: [
			{
				name: "openr",
				description: "The building's doors (OpenR)",
				access: ACCESS,
				subcommands: [
					{
						name: "open",
						description: "Open one of the building's doors",
						access: ACCESS,
						private: true,
						placeholder: { text: "Opening…", private: true },
						options: [
							{
								name: "door",
								description: "Which door",
								type: "string",
								required: true,
								suggest: async ({ typed }) => {
									if (!deps.doors || isOff()) return [];
									const needle = typed.trim().toLowerCase();
									return deps.list
										.filter((door) => door.name.toLowerCase().includes(needle))
										.slice(0, MAX_SUGGESTIONS)
										.map((door) => ({ name: door.name, value: door.name }));
								},
							},
						],
						handler: async ({ args, principal, logger }): Promise<Reply> => {
							if (!deps.doors) return { text: OPENR_MESSAGES.notSetUp, private: true };
							// Checked again here, whatever was suggested.
							const door = byName.get(
								String(args.door ?? "")
									.trim()
									.toLowerCase(),
							);
							if (!door) {
								// What was typed isn't logged: it could be anything.
								logger.warn(
									{
										event: "openr.door_denied",
										reason: "unknown-door",
										...actorLogFields(principal),
									},
									"refused to open a door",
								);
								return { text: OPENR_MESSAGES.unknown, private: true };
							}
							if (isOff()) {
								logger.warn(
									{
										event: "openr.door_denied",
										reason: "switched-off",
										door: door.name,
										...actorLogFields(principal),
									},
									"refused to open a door",
								);
								return { text: OPENR_MESSAGES.off, private: true };
							}
							const result = await deps.doors.open(door.id);
							logger.info(
								{
									event: result.opened ? "openr.door_opened" : "openr.door_failed",
									door: door.name,
									...(result.opened ? {} : { reason: result.reason }),
									...actorLogFields(principal),
								},
								result.opened ? "opened a door" : "a door didn't open",
							);
							deps.reporter?.breadcrumb(
								"openr.door",
								`${door.name}: ${result.opened ? "opened" : result.reason}`,
								{ user: actorRef(principal) },
							);
							return { text: openedLine(door.name, result), private: true };
						},
					},
				],
			},
		],
	};
}

/**
 * The parking gate, opened through OpenR. Unlike `/openr open` it needs no capability
 * of its own: `/park` only asks for someone it has just given a spot. Switched off with
 * the other doors.
 */
export function openrGate(deps: {
	doors: Pick<DoorSystem, "open">;
	gateDoor: string;
	switches: Pick<KindSwitch, "isOn">;
}): Gate {
	return {
		open: async () => {
			if (!deps.switches.isOn(DOOR_SWITCH)) return { opened: false, reason: "off" };
			const result = await deps.doors.open(deps.gateDoor);
			if (result.opened) return { opened: true };
			return { opened: false, reason: result.reason === "logged-out" ? "not-connected" : "failed" };
		},
	};
}
