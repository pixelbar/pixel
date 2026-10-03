import { highestTier, type PlatformActor, type Principal, type Tier } from "./access.ts";
import type { TierSource } from "./ports/tier-source.ts";

/**
 * Resolves an actor to a Principal by asking every tier source and taking the
 * highest answer. Unknown actors are guests.
 */
export class IdentityService {
	readonly #sources: readonly TierSource[];

	constructor(sources: readonly TierSource[]) {
		this.#sources = sources;
	}

	async resolve(actor: PlatformActor): Promise<Principal> {
		const answers = await Promise.all(this.#sources.map((source) => source.tierFor(actor)));
		const tier = highestTier(answers.filter((t): t is Tier => t !== null));
		return { ...actor, tier };
	}
}
