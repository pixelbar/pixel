import { TIERS, type Tier, tierRank } from "./access.ts";
import { type CommandDefinition, isGroup, type SubcommandDefinition } from "./command.ts";
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

const MAX_SUBCOMMANDS = 25;
const MAX_OPTIONS = 25;

function validate(feature: string, def: CommandDefinition): void {
	const where = `command "${def.name}" in feature "${feature}"`;
	validateCommon(where, def);
	if (!isGroup(def)) {
		validateRunnable(where, def);
		return;
	}
	const subs: unknown = def.subcommands;
	if (!Array.isArray(subs) || subs.length < 1 || subs.length > MAX_SUBCOMMANDS) {
		throw new RegistryError(`Subcommands must number 1–${MAX_SUBCOMMANDS} for ${where}`);
	}
	if (def.handler !== undefined || def.options !== undefined) {
		throw new RegistryError(`A command with subcommands can't have a handler or options: ${where}`);
	}
	const seen = new Set<string>();
	for (const sub of def.subcommands) {
		const subWhere = `subcommand "${sub.name}" of ${where}`;
		validateCommon(subWhere, sub);
		validateRunnable(subWhere, sub);
		if (seen.has(sub.name)) throw new RegistryError(`Duplicate ${subWhere}`);
		seen.add(sub.name);
		if (tierRank(sub.access.minTier) < tierRank(def.access.minTier)) {
			throw new RegistryError(`${subWhere} can't be open to a lower tier than its command`);
		}
		const allowed = def.access.contexts;
		if (allowed && !sub.access.contexts?.every((c) => allowed.includes(c))) {
			throw new RegistryError(`${subWhere} can't be allowed in more contexts than its command`);
		}
	}
}

function validateCommon(
	where: string,
	def: Pick<CommandDefinition, "name" | "description" | "access">,
) {
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
}

function validateRunnable(where: string, def: SubcommandDefinition): void {
	if (typeof def.handler !== "function") throw new RegistryError(`Missing handler for ${where}`);
	if ((def.options?.length ?? 0) > MAX_OPTIONS) {
		throw new RegistryError(`At most ${MAX_OPTIONS} options allowed for ${where}`);
	}

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
