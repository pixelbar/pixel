import type { PlatformActor, Tier } from "../access.ts";

/**
 * Who is a member or friend, and what extra capabilities they have. Access is
 * decided from this data alone. The role sync may change it from Discord roles,
 * through `apply` like an admin (ADR 0020), but a role is never read to decide
 * a command. `admin` is not stored here, it comes only from admins.yaml.
 *
 * Phase 1 keeps it in a bot-managed file. A database can replace it later
 * behind this interface.
 */

/** `guest` marks someone who was demoted: the entry stays, but they have no tier. */
export type MemberTier = "member" | "friend" | "guest";

export type MemberRecord = {
	/**
	 * Every identity this person has, platform-prefixed ("discord:<id>"). One
	 * person can have several, for example one per platform. Immutable user
	 * IDs only, never names.
	 */
	ids: readonly string[];
	tier: MemberTier;
	/** Free text for humans. Never logged or sent anywhere. */
	note?: string;
	/** Named permissions. See the capability system (#28). */
	capabilities: readonly string[];
	/**
	 * Capabilities taken away from this person even though their level grants
	 * them (ADR 0022). A revocation wins over every grant, their own included.
	 */
	revoked: readonly string[];
};

/** A membership level that can be given capabilities as a whole. */
export type GrantTier = Exclude<MemberTier, "guest">;

/**
 * Capabilities given to everyone at a membership level, in the members file's
 * `tiers:` section. A grant reaches its level and every level above it (a
 * friend grant reaches members too). It follows the members entry's level, so
 * being an admin adds nothing, and a guest gets none.
 */
export type TierGrants = Readonly<Record<GrantTier, readonly string[]>>;

/** Everything the rest of Pixel reads. Replaced as a whole after every change. */
export type AccessView = {
	/** Discord user ID → tier. Only non-guest tiers appear; guest entries are left out. */
	readonly discord: ReadonlyMap<string, Exclude<Tier, "guest">>;
	/**
	 * Every entry in the members file, including guests, by Discord user ID.
	 * A person with several IDs appears under each (the same record).
	 */
	readonly records: ReadonlyMap<string, MemberRecord>;
	/** Capabilities given to whole membership levels. */
	readonly tierCapabilities: TierGrants;
	readonly counts: { readonly admins: number; readonly members: number; readonly friends: number };
	/** Non-fatal issues, safe to log (no IDs). */
	readonly warnings: readonly string[];
};

export type AccessChange =
	/**
	 * Sets (or creates) someone's tier, keeping their note and capabilities. `defaultNote`
	 * is written only when the entry in the file, as read for this change, has no note, so
	 * a note someone wrote (even by hand since the last reload) is never replaced.
	 */
	| { kind: "set-tier"; id: string; tier: MemberTier; defaultNote?: string; reason?: string }
	/**
	 * Replaces someone's capabilities, and their revocations when `revoked` is given
	 * (left out, they stay as they are). They must already have an entry.
	 */
	| {
			kind: "set-capabilities";
			id: string;
			capabilities: readonly string[];
			revoked?: readonly string[];
			reason?: string;
	  };

/** Longest reason accepted. It goes into the audit log, not the file. */
export const MAX_REASON_LENGTH = 200;

export type AccessChangeResult = {
	before: MemberRecord | null;
	after: MemberRecord;
};

/** Replaces the capabilities given to a whole membership level. */
export type TierCapabilityChange = {
	tier: GrantTier;
	capabilities: readonly string[];
	reason?: string;
};

export type TierCapabilityResult = {
	before: readonly string[];
	after: readonly string[];
};

export type ReloadResult = { before: AccessView["counts"]; after: AccessView["counts"] };

export type AccessStore = {
	/** The current state. Always a complete, validated snapshot. */
	readonly view: AccessView;
	/**
	 * Applies one change and records who made it. A failed change leaves both
	 * the stored data and `view` untouched, and throws a message safe to show.
	 */
	apply(change: AccessChange, by: PlatformActor): Promise<AccessChangeResult>;
	/**
	 * Like `apply`, for a whole membership level: the same checks, atomic write
	 * and audit record. Nobody is DMed, since it can reach everyone at once.
	 */
	setTierCapabilities(
		change: TierCapabilityChange,
		by: PlatformActor,
	): Promise<TierCapabilityResult>;
	/** Re-reads everything from storage, for edits made by hand. Keeps the old view if it's invalid. */
	reload(by: PlatformActor): Promise<ReloadResult>;
};
