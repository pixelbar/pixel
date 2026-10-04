import { checkAccess, type Principal, type Tier } from "./access.ts";
import type { CapabilityDefinition } from "./capabilities.ts";
import type { HomeKind } from "./home-kinds/kind.ts";

/**
 * Who may do what to a Home Assistant device: one rule, used by every `/ha`
 * command and by autocomplete, so they can't disagree.
 *
 * - **Reading** a device needs only its tier floor (`minTier`, member unless the
 *   devices file says otherwise).
 * - **Acting** on it needs the tier floor **and** either `ha-admin` (any device) or
 *   the capability of the device's kind (`ha-lights` for lights and so on), **and**
 *   the action must be one the devices file allows for that device.
 *
 * Nothing implies a capability: not a tier, not being a Pixel admin, not a Discord
 * role. A guest never passes. This builds on `checkAccess`, so the tier and
 * capability semantics are the same as for any command.
 */

/** Lets someone control any device on the allow-list, whatever its kind. */
export const HA_ADMIN = "ha-admin";

export const HA_ADMIN_CAPABILITY: CapabilityDefinition = {
	name: HA_ADMIN,
	description: "Control any device on the Home Assistant list, whatever its kind",
};

/**
 * What people are told when they can't use a device. It's the same whether the
 * device doesn't exist, they lack the tier or they lack the capability, so it never
 * confirms that a device is there, what kind it is or what they'd need. The real
 * reason goes in the log.
 */
export const HOME_DENIED = "I can't find that device, or you can't use it.";

/** The capabilities Home Assistant adds: `ha-admin` and one for each kind that can be controlled. */
export function homeCapabilities(kinds: ReadonlyMap<string, HomeKind>): CapabilityDefinition[] {
	return [
		HA_ADMIN_CAPABILITY,
		...[...kinds.values()].flatMap((kind) => (kind.capability ? [kind.capability] : [])),
	];
}

/** The parts of a device the rule looks at. A `HomeDevice` has them. */
export type AccessibleDevice = {
	/** The lowest tier that may use it. Never guest. */
	minTier: Exclude<Tier, "guest">;
	kind: { capability?: { name: string } | undefined };
	/** The actions the devices file allows on it. */
	actions: readonly { name: string }[];
};

export type DeviceDecision =
	| { allowed: true }
	| {
			allowed: false;
			/** For the log only: never shown to the person. */
			reason: "tier" | "capability" | "action";
	  };

/** May this person see the device and read its status? The tier floor, and nothing more. */
export function canViewDevice(device: AccessibleDevice, principal: Principal): DeviceDecision {
	return checkAccess({ minTier: device.minTier }, principal).allowed
		? { allowed: true }
		: { allowed: false, reason: "tier" };
}

/** May this person run this action on the device? */
export function canActOnDevice(
	device: AccessibleDevice,
	action: string,
	principal: Principal,
): DeviceDecision {
	// The floor first: it also keeps a guest out, whatever they hold.
	if (!checkAccess({ minTier: device.minTier }, principal).allowed) {
		return { allowed: false, reason: "tier" };
	}
	const granted = [HA_ADMIN, ...(device.kind.capability ? [device.kind.capability.name] : [])];
	const holds = granted.some(
		(capability) => checkAccess({ minTier: device.minTier, capability }, principal).allowed,
	);
	if (!holds) return { allowed: false, reason: "capability" };
	if (!device.actions.some((allowed) => allowed.name === action)) {
		return { allowed: false, reason: "action" };
	}
	return { allowed: true };
}

/** The devices this person may see. For listing and for autocomplete: never offer what they couldn't use. */
export function visibleDevices<T extends AccessibleDevice>(
	devices: readonly T[],
	principal: Principal,
): T[] {
	return devices.filter((device) => canViewDevice(device, principal).allowed);
}

/**
 * The devices this person may run `action` on, or any action if none is named.
 * For autocomplete, so it offers only what the command would accept.
 */
export function actionableDevices<T extends AccessibleDevice>(
	devices: readonly T[],
	principal: Principal,
	action?: string,
): T[] {
	return devices.filter((device) =>
		action === undefined
			? device.actions.some((allowed) => canActOnDevice(device, allowed.name, principal).allowed)
			: canActOnDevice(device, action, principal).allowed,
	);
}
