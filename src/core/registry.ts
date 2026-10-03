import { type Access, TIERS, type Tier, tierRank } from "./access.ts";
import {
	type CommandDefinition,
	type GroupCommand,
	isGroup,
	isSubgroup,
	type SubcommandDefinition,
	type SubgroupDefinition,
} from "./command.ts";
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
	if (def.handler !== undefined || def.options !== undefined) {
		throw new RegistryError(`A command with subcommands can't have a handler or options: ${where}`);
	}
	validateChildren(where, def, 0);
}

/** Checks the subcommands and subgroups of a group (depth 0) or of a subgroup (depth 1). */
function validateChildren(
	where: string,
	parent: GroupCommand | SubgroupDefinition,
	depth: number,
): void {
	const children: unknown = parent.subcommands;
	if (!Array.isArray(children) || children.length < 1 || children.length > MAX_SUBCOMMANDS) {
		throw new RegistryError(`Subcommands must number 1–${MAX_SUBCOMMANDS} for ${where}`);
	}
	// Subcommands and subgroups share one namespace in Discord.
	const seen = new Set<string>();
	for (const child of parent.subcommands) {
		const isNested = isSubgroup(child);
		const childWhere = `${isNested ? "subgroup" : "subcommand"} "${child.name}" of ${where}`;
		validateCommon(childWhere, child);
		if (isNested) {
			// Discord allows one level of subgroup: command → subgroup → subcommand.
			if (depth > 0) throw new RegistryError(`${childWhere} is nested too deeply`);
			validateChildren(childWhere, child, depth + 1);
		} else {
			validateRunnable(childWhere, child);
		}
		if (seen.has(child.name)) throw new RegistryError(`Duplicate ${childWhere}`);
		seen.add(child.name);
		assertNotLooser(childWhere, parent.access, child.access);
	}
}

/** A child may tighten its parent's access but never loosen it. */
function assertNotLooser(childWhere: string, parent: Access, child: Access): void {
	if (tierRank(child.minTier) < tierRank(parent.minTier)) {
		throw new RegistryError(`${childWhere} can't be open to a lower tier than its parent`);
	}
	const allowed = parent.contexts;
	if (allowed && !child.contexts?.every((c) => allowed.includes(c))) {
		throw new RegistryError(`${childWhere} can't be allowed in more contexts than its parent`);
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
