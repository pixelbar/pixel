import type { PlatformActor, Tier } from "../access.ts";

/**
 * Something that can vouch for an actor's tier: phase 1 has only the access
 * config files; Discord role sync and database grants will implement this too.
 * Return null when the source knows nothing about the actor.
 */
export type TierSource = {
	name: string;
	tierFor(actor: PlatformActor): Promise<Tier | null>;
};
