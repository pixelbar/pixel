/**
 * Tiers, from least to most privileged. Order matters: a higher tier includes
 * everything a lower tier can do. See docs/identity-and-access.md.
 */
export const TIERS = ["guest", "friend", "member", "admin"] as const;

export type Tier = (typeof TIERS)[number];

export type ChatContext = "dm" | "group";

export type Platform = "discord";

export type Access = {
	/** Required on every command; there is deliberately no default. */
	minTier: Tier;
	/** Where the command may run. Omitted means everywhere. */
	contexts?: readonly ChatContext[];
};

/** Who is talking to Pixel, as reported by a platform adapter. */
export type PlatformActor = {
	platform: Platform;
	/** Immutable platform user ID. The only field used for identification. */
	userId: string;
	/** For display only. Never use for authorisation. */
	displayName: string;
	chat: ChatContext;
};

/** An actor whose tier has been resolved by the IdentityService. */
export type Principal = PlatformActor & { tier: Tier };

/**
 * Stable user identifier for logs and Sentry, e.g. "discord:494477157062672404".
 * Prefixed with the platform so IDs stay unique once more platforms exist.
 * Never includes display names.
 */
export function actorRef(actor: Pick<PlatformActor, "platform" | "userId">): string {
	return `${actor.platform}:${actor.userId}`;
}

export function tierRank(tier: Tier): number {
	return TIERS.indexOf(tier);
}

export function tierAtLeast(tier: Tier, required: Tier): boolean {
	return tierRank(tier) >= tierRank(required);
}

export function highestTier(tiers: Iterable<Tier>): Tier {
	let best: Tier = "guest";
	for (const tier of tiers) {
		if (tierRank(tier) > tierRank(best)) best = tier;
	}
	return best;
}

export type AccessDecision = { allowed: true } | { allowed: false; reason: "tier" | "context" };

export function checkAccess(access: Access, principal: Principal): AccessDecision {
	if (!tierAtLeast(principal.tier, access.minTier)) return { allowed: false, reason: "tier" };
	if (access.contexts && !access.contexts.includes(principal.chat)) {
		return { allowed: false, reason: "context" };
	}
	return { allowed: true };
}
