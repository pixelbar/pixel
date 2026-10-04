import { CAPABILITY_NAME } from "../capabilities.ts";
import { HA_ADMIN } from "../home-access.ts";

/**
 * A *kind* of device says what Pixel may do with a Home Assistant entity of a
 * certain sort: which HA domains it can be, which actions people may run on it,
 * which service each action calls, and which states mean "done". Kinds are
 * defined in code, one small file each, so a new kind (a thermostat, a blind, a
 * scene) is a new file and one line in the list, never a rewrite. The devices
 * file only ever picks from what a kind offers, so it can't make up a service.
 */

export type KindAction = {
	/** What people type, such as "unlock". Lowercase words joined by '-'. */
	name: string;
	/** Shown to people, such as "Unlock the door". */
	description: string;
	/** The Home Assistant service this calls, such as "unlock". */
	service: string;
	/** The service's domain. Defaults to the entity's own domain (`lock.front_door` → `lock`). */
	serviceDomain?: string;
	/** Fixed data sent with every call. People can't add to it. */
	data?: Readonly<Record<string, unknown>>;
	/**
	 * The states that mean it worked, such as ["unlocked"]. For an action that
	 * flips the state (toggle) these are the states it can end in, and what counts
	 * as done is that the state changed.
	 */
	done: readonly string[];
	/** States that mean it's under way, such as ["unlocking"], so a slow lock isn't read as a failure. */
	working?: readonly string[];
};

/** The capability that lets someone control a kind. It's registered with the others, so a new kind brings its own. */
export type KindCapability = {
	/** Starts with "ha-", such as "ha-lights". Never "ha-admin", which is the general one. */
	name: string;
	/** 1–100 characters. Shown to admins when granting. */
	description: string;
};

export type HomeKind = {
	/** What goes in the devices file, such as "door". Lowercase words joined by '-'. */
	name: string;
	description: string;
	/** The Home Assistant domains an entity of this kind can have, such as ["lock"]. */
	domains: readonly string[];
	/** What may be done with it. Empty means read-only. */
	actions: readonly KindAction[];
	/**
	 * The capability that lets someone control this kind (see the capability
	 * system). Absent for a read-only kind. Acting on a device needs this one or `ha-admin`.
	 */
	capability?: KindCapability;
};

export class HomeKindError extends Error {
	override name = "HomeKindError";
}

const WORD = /^[a-z][a-z-]{0,19}$/;
const DOMAIN = /^[a-z][a-z_]*$/;
const SERVICE = /^[a-z][a-z_]*$/;
const STATE = /^[a-z][a-z_]*$/;

/**
 * Checks a list of kinds and returns them by name. A mistake here is a bug in the
 * code, so it throws at startup with a message that names the kind and action.
 */
export function defineKinds(kinds: readonly HomeKind[]): ReadonlyMap<string, HomeKind> {
	const byName = new Map<string, HomeKind>();
	const capabilities = new Set<string>();
	for (const kind of kinds) {
		const where = `kind "${kind.name}"`;
		if (!WORD.test(kind.name)) throw new HomeKindError(`Invalid name for ${where}`);
		if (byName.has(kind.name)) throw new HomeKindError(`Duplicate ${where}`);
		if (kind.description.length < 1 || kind.description.length > 100) {
			throw new HomeKindError(`Description must be 1–100 characters for ${where}`);
		}
		if (kind.domains.length === 0 || !kind.domains.every((d) => DOMAIN.test(d))) {
			throw new HomeKindError(`${where} needs one or more valid Home Assistant domains`);
		}
		const seen = new Set<string>();
		for (const action of kind.actions) {
			const at = `action "${action.name}" of ${where}`;
			if (!WORD.test(action.name)) throw new HomeKindError(`Invalid name for ${at}`);
			if (seen.has(action.name)) throw new HomeKindError(`Duplicate ${at}`);
			seen.add(action.name);
			if (!SERVICE.test(action.service)) throw new HomeKindError(`Invalid service for ${at}`);
			if (action.serviceDomain !== undefined && !DOMAIN.test(action.serviceDomain)) {
				throw new HomeKindError(`Invalid service domain for ${at}`);
			}
			if (action.description.length < 1 || action.description.length > 100) {
				throw new HomeKindError(`Description must be 1–100 characters for ${at}`);
			}
			if (action.done.length === 0 || !action.done.every((s) => STATE.test(s))) {
				throw new HomeKindError(`${at} needs one or more valid done states`);
			}
			if (action.working?.some((s) => !STATE.test(s) || action.done.includes(s))) {
				throw new HomeKindError(`${at} has a working state that is invalid or also a done state`);
			}
		}
		if (kind.actions.length > 0 && !kind.capability) {
			throw new HomeKindError(`${where} can change things, so it needs a capability`);
		}
		if (kind.capability) {
			const { name, description } = kind.capability;
			if (!CAPABILITY_NAME.test(name) || !name.startsWith("ha-") || name === HA_ADMIN) {
				throw new HomeKindError(
					`The capability of ${where} must be a valid name starting with "ha-", and not "${HA_ADMIN}"`,
				);
			}
			if (description.length < 1 || description.length > 100) {
				throw new HomeKindError(`Capability description must be 1–100 characters for ${where}`);
			}
			if (capabilities.has(name)) {
				throw new HomeKindError(`${where} shares the capability "${name}" with another kind`);
			}
			capabilities.add(name);
		}
		byName.set(kind.name, kind);
	}
	return byName;
}
