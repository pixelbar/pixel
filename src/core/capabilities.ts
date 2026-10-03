import type { Logger } from "./logger.ts";
import type { MemberRecord } from "./ports/access-store.ts";
import type { ErrorReporter } from "./ports/error-reporter.ts";

/**
 * Capabilities are named permissions granted to individual people, on top of
 * their tier: not implied by a tier, a Discord role or being an admin. A
 * command that needs one declares `access: { minTier, capability }`, and the
 * dispatcher requires both.
 *
 * Every capability that exists is declared in code (`features/capabilities.ts`),
 * so admins can only grant real names and a typo can't create a silent grant.
 */

/** Lowercase words joined by '-', e.g. "front-door". */
export const CAPABILITY_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** Discord shows at most 25 choices for an option, and admins pick from them. */
export const MAX_REGISTERED_CAPABILITIES = 25;

export type CapabilityDefinition = {
	name: string;
	/** 1–100 characters. Shown to admins when granting. */
	description: string;
};

export class CapabilityError extends Error {
	override name = "CapabilityError";
}

export class CapabilityRegistry {
	readonly #byName = new Map<string, CapabilityDefinition>();

	constructor(definitions: readonly CapabilityDefinition[] = []) {
		if (definitions.length > MAX_REGISTERED_CAPABILITIES) {
			throw new CapabilityError(
				`At most ${MAX_REGISTERED_CAPABILITIES} capabilities are supported`,
			);
		}
		for (const definition of definitions) {
			if (!CAPABILITY_NAME.test(definition.name)) {
				throw new CapabilityError(`Invalid capability name "${definition.name}"`);
			}
			if (definition.description.length < 1 || definition.description.length > 100) {
				throw new CapabilityError(
					`Description must be 1–100 characters for capability "${definition.name}"`,
				);
			}
			if (this.#byName.has(definition.name)) {
				throw new CapabilityError(`Duplicate capability "${definition.name}"`);
			}
			this.#byName.set(definition.name, definition);
		}
	}

	has(name: string): boolean {
		return this.#byName.has(name);
	}

	get(name: string): CapabilityDefinition | undefined {
		return this.#byName.get(name);
	}

	all(): CapabilityDefinition[] {
		return [...this.#byName.values()];
	}
}

/**
 * Capability names people hold in the members file that no longer exist in
 * code, with how many people hold each. Nothing can require them, so they do
 * nothing, but they point at a stale file or a rolled-back release.
 */
export function unknownCapabilities(
	records: Iterable<Pick<MemberRecord, "capabilities">>,
	registry: Pick<CapabilityRegistry, "has">,
): Map<string, number> {
	const unknown = new Map<string, number>();
	for (const { capabilities } of records) {
		for (const name of capabilities) {
			if (!registry.has(name)) unknown.set(name, (unknown.get(name) ?? 0) + 1);
		}
	}
	return unknown;
}

/**
 * Warns about unknown capability names and reports them to the error tracker,
 * without failing: they are ignored. Returns their names. Names only, no IDs.
 */
export function reportUnknownCapabilities(
	records: Iterable<Pick<MemberRecord, "capabilities">>,
	registry: Pick<CapabilityRegistry, "has">,
	{ logger, reporter }: { logger: Logger; reporter: ErrorReporter },
): string[] {
	const unknown = unknownCapabilities(records, registry);
	const names = [...unknown.keys()].sort();
	if (names.length === 0) return names;
	logger.warn(
		{ event: "access.unknown_capabilities", capabilities: names },
		"the members file has capabilities that don't exist; ignoring them",
	);
	reporter.captureBackground(
		new CapabilityError(`Unknown capabilities in the members file: ${names.join(", ")}`),
		"access-config",
	);
	return names;
}
