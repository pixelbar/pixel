import { highestTier, type PlatformActor, type Principal, type Tier } from "./access.ts";
import type { CapabilitySource } from "./ports/capability-source.ts";
import type { TierSource } from "./ports/tier-source.ts";

/**
 * Resolves an actor to a Principal by asking every tier source and taking the
 * highest answer, and every capability source for what they've been granted.
 * Unknown actors are guests. A guest has no capabilities, whatever a source says.
 */
export class IdentityService {
	readonly #sources: readonly TierSource[];
	readonly #capabilitySources: readonly CapabilitySource[];

	constructor(sources: readonly TierSource[], capabilitySources: readonly CapabilitySource[] = []) {
		this.#sources = sources;
		this.#capabilitySources = capabilitySources;
	}

	async resolve(actor: PlatformActor): Promise<Principal> {
		const answers = await Promise.all(this.#sources.map((source) => source.tierFor(actor)));
		const tier = highestTier(answers.filter((t): t is Tier => t !== null));
		if (tier === "guest") return { ...actor, tier, capabilities: [] };
		const granted = await Promise.all(
			this.#capabilitySources.map((source) => source.capabilitiesFor(actor)),
		);
		return { ...actor, tier, capabilities: [...new Set(granted.flat())] };
	}
}
