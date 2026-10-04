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
	 * system). Absent for a read-only kind. A person also needs `ha-admin` or this one.
	 */
	capability?: string;
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
		byName.set(kind.name, kind);
	}
	return byName;
}
