/**
 * Tiers, from least to most privileged. Order matters: a higher tier includes
 * everything a lower tier can do. See docs/identity-and-access.md.
 */
export const TIERS = ["guest", "friend", "member", "admin"] as const;

export type Tier = (typeof TIERS)[number];

/** How a tier is shown to people. */
export const TIER_LABELS: Record<Tier, string> = {
	guest: "Guest",
	friend: "Friend of Pixelbar",
	member: "Pixelbar member",
	admin: "Pixel admin",
};

export type ChatContext = "dm" | "group";

export type Platform = "discord";

export type Access = {
	/** Required on every command; there is deliberately no default. */
	minTier: Tier;
	/** Where the command may run. Omitted means everywhere. */
	contexts?: readonly ChatContext[];
	/**
	 * A named permission the person must also hold, on top of `minTier`. Not
	 * implied by any tier (admin included) or by a Discord role. Guests never
	 * pass, whatever they hold. See `core/capabilities.ts`.
	 */
	capability?: string;
};

/** Who is talking to Pixel, as reported by a platform adapter. */
export type PlatformActor = {
	platform: Platform;
	/** Immutable platform user ID. The only field used for identification. */
	userId: string;
	/** Server nickname or display name. For display and logs only — never for authorisation. */
	displayName: string;
	/** Unique platform username (e.g. Discord handle), if any. For logs only — never for authorisation. */
	handle?: string;
	chat: ChatContext;
};

/** An actor whose tier and capabilities have been resolved by the IdentityService. */
export type Principal = PlatformActor & {
	tier: Tier;
	/** Granted capabilities. Always empty for a guest. */
	capabilities: readonly string[];
};

/**
 * Stable user identifier, e.g. "discord:494477157062672404". Prefixed with
 * the platform so IDs stay unique once more platforms exist. This is the
 * authoritative identity — ban and grant by this, not by name.
 */
export function actorRef(actor: Pick<PlatformActor, "platform" | "userId">): string {
	return `${actor.platform}:${actor.userId}`;
}

export type ActorLogFields = { user: string; userName: string; userHandle?: string };

/**
 * Fields identifying who performed an action, for logs: the stable ID plus
 * names so humans can recognise the user. Names are user-controlled and can
 * change, so act on `user`, never on the names.
 */
/** Splits "discord:123…" into its platform and user ID. */
export function splitRef(ref: string): { platform: string; userId: string } {
	const colon = ref.indexOf(":");
	return { platform: ref.slice(0, colon), userId: ref.slice(colon + 1) };
}

export function actorLogFields(actor: PlatformActor): ActorLogFields {
	return {
		user: actorRef(actor),
		userName: actor.displayName,
		...(actor.handle ? { userHandle: actor.handle } : {}),
	};
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

export type AccessDecision =
	| { allowed: true }
	| { allowed: false; reason: "tier" | "context" | "capability" };

/** Both the tier and, if the command names one, the capability must hold. */
export function checkAccess(access: Access, principal: Principal): AccessDecision {
	if (!tierAtLeast(principal.tier, access.minTier)) return { allowed: false, reason: "tier" };
	if (access.contexts && !access.contexts.includes(principal.chat)) {
		return { allowed: false, reason: "context" };
	}
	if (access.capability !== undefined) {
		// A guest has no valid tier, so a capability on its own gets them nowhere.
		if (principal.tier === "guest") return { allowed: false, reason: "tier" };
		if (!principal.capabilities.includes(access.capability)) {
			return { allowed: false, reason: "capability" };
		}
	}
	return { allowed: true };
}
