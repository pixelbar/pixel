import type { PlatformActor } from "../access.ts";

/**
 * Something that knows which capabilities a person has been granted. Like a
 * `TierSource`, it only reports what it knows: whether a capability counts is
 * decided by the dispatcher, together with the person's tier.
 */
export type CapabilitySource = {
	name: string;
	capabilitiesFor(actor: PlatformActor): Promise<readonly string[]>;
};
