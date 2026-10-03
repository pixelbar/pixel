import { TIERS, type Tier } from "./access.ts";
import type { CommandDefinition } from "./command.ts";
import type { Feature } from "./feature.ts";

export type RegisteredCommand = {
	feature: string;
	definition: CommandDefinition;
};

const NAME_PATTERN = /^[-_a-z0-9]{1,32}$/;

export class RegistryError extends Error {
	override name = "RegistryError";
}

/**
 * Holds every command Pixel knows about. Registration is strict: anything
 * malformed — above all a command without `access.minTier` — is rejected at
 * startup rather than becoming reachable at runtime.
 */
export class CommandRegistry {
	readonly #commands = new Map<string, RegisteredCommand>();

	register(feature: Feature): void {
		for (const definition of feature.commands ?? []) {
			validate(feature.name, definition);
			if (this.#commands.has(definition.name)) {
				throw new RegistryError(
					`Duplicate command "${definition.name}" in feature "${feature.name}"`,
				);
			}
			this.#commands.set(definition.name, { feature: feature.name, definition });
		}
	}

	get(name: string): RegisteredCommand | undefined {
		return this.#commands.get(name);
	}

	all(): RegisteredCommand[] {
		return [...this.#commands.values()];
	}
}

function validate(feature: string, def: CommandDefinition): void {
	const where = `command "${def.name}" in feature "${feature}"`;
	if (!NAME_PATTERN.test(def.name)) throw new RegistryError(`Invalid name for ${where}`);
	if (def.description.length < 1 || def.description.length > 100) {
		throw new RegistryError(`Description must be 1–100 characters for ${where}`);
	}
	// Types already require this, but features are code and code has bugs:
	// check at runtime too, because a missing tier must never mean "open".
	const minTier: unknown = (def.access as { minTier?: unknown } | undefined)?.minTier;
	if (!TIERS.includes(minTier as Tier)) {
		throw new RegistryError(`Missing or invalid access.minTier for ${where}`);
	}
	if (typeof def.handler !== "function") throw new RegistryError(`Missing handler for ${where}`);

	const seen = new Set<string>();
	let optionalSeen = false;
	for (const option of def.options ?? []) {
		if (!NAME_PATTERN.test(option.name)) {
			throw new RegistryError(`Invalid option name "${option.name}" for ${where}`);
		}
		if (seen.has(option.name)) {
			throw new RegistryError(`Duplicate option "${option.name}" for ${where}`);
		}
		seen.add(option.name);
		if (option.required && optionalSeen) {
			throw new RegistryError(`Required options must come before optional ones for ${where}`);
		}
		if (!option.required) optionalSeen = true;
	}
}
