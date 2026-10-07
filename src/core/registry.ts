import { type Access, TIERS, type Tier, tierRank } from "./access.ts";
import type { CapabilityRegistry } from "./capabilities.ts";
import {
	type CommandDefinition,
	type CommandOption,
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
	readonly #capabilities: Pick<CapabilityRegistry, "has">;

	/** `capabilities` is what commands may require. Without it, none exist. */
	constructor(options: { capabilities?: Pick<CapabilityRegistry, "has"> } = {}) {
		this.#capabilities = options.capabilities ?? { has: () => false };
	}

	register(feature: Feature): void {
		for (const definition of feature.commands ?? []) {
			validate(feature.name, definition, this.#capabilities);
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

type Known = Pick<CapabilityRegistry, "has">;

function validate(feature: string, def: CommandDefinition, known: Known): void {
	const where = `command "${def.name}" in feature "${feature}"`;
	validateCommon(where, def, known);
	if (!isGroup(def)) {
		validateRunnable(where, def);
		return;
	}
	if (def.handler !== undefined || def.options !== undefined) {
		throw new RegistryError(`A command with subcommands can't have a handler or options: ${where}`);
	}
	validateChildren(where, def, 0, known);
}

/** Checks the subcommands and subgroups of a group (depth 0) or of a subgroup (depth 1). */
function validateChildren(
	where: string,
	parent: GroupCommand | SubgroupDefinition,
	depth: number,
	known: Known,
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
		validateCommon(childWhere, child, known);
		if (isNested) {
			// Discord allows one level of subgroup: command → subgroup → subcommand.
			if (depth > 0) throw new RegistryError(`${childWhere} is nested too deeply`);
			validateChildren(childWhere, child, depth + 1, known);
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
	const platforms = parent.platforms;
	if (platforms && !child.platforms?.every((p) => platforms.includes(p))) {
		throw new RegistryError(`${childWhere} can't run on more platforms than its parent`);
	}
}

function validateCommon(
	where: string,
	def: Pick<CommandDefinition, "name" | "description" | "access">,
	known: Known,
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
	const capability: unknown = def.access.capability;
	if (capability !== undefined) {
		// A typo here would otherwise lock everyone out, or worse, match nothing silently.
		if (typeof capability !== "string" || !known.has(capability)) {
			throw new RegistryError(`Unknown capability required by ${where}`);
		}
		// Guests never pass a capability check, so a guest-tier command with one is a mistake.
		if (minTier === "guest") {
			throw new RegistryError(`A capability needs a minTier above guest for ${where}`);
		}
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
		validateSuggest(option, where);
	}
}

/** Suggestions are for string and integer options, and never go with fixed choices. */
function validateSuggest(option: CommandOption, where: string): void {
	const suggest: unknown = (option as { suggest?: unknown }).suggest;
	if (suggest === undefined) return;
	if (typeof suggest !== "function") {
		throw new RegistryError(
			`Option "${option.name}" has a suggest that isn't a function for ${where}`,
		);
	}
	if (option.type !== "string" && option.type !== "integer") {
		throw new RegistryError(
			`Only string and integer options can have suggestions: "${option.name}" for ${where}`,
		);
	}
	if (option.type === "string" && option.choices !== undefined) {
		throw new RegistryError(
			`Option "${option.name}" can't have both choices and suggestions for ${where}`,
		);
	}
}
