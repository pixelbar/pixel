import type { PlatformActor, Tier } from "../access.ts";

/**
 * Who is a member or friend, and what extra capabilities they have. Pixel's
 * own data is the source of truth for this: Discord roles are never read to
 * decide a tier. `admin` is not stored here, it comes only from admins.yaml.
 *
 * Phase 1 keeps it in a bot-managed file. A database can replace it later
 * behind this interface.
 */

/** `guest` marks someone who was demoted: the entry stays, but they have no tier. */
export type MemberTier = "member" | "friend" | "guest";

export type MemberRecord = {
	/** Immutable platform user ID. The only way to identify a person. */
	discordId: string;
	tier: MemberTier;
	/** Free text for humans. Never logged or sent anywhere. */
	note?: string;
	/** Named permissions. See the capability system (#28). */
	capabilities: readonly string[];
};

/** Everything the rest of Pixel reads. Replaced as a whole after every change. */
export type AccessView = {
	/** Discord user ID → tier. Only non-guest tiers appear; guest entries are left out. */
	readonly discord: ReadonlyMap<string, Exclude<Tier, "guest">>;
	/** Every entry in the members file, including guests, by Discord user ID. */
	readonly records: ReadonlyMap<string, MemberRecord>;
	readonly counts: { readonly admins: number; readonly members: number; readonly friends: number };
	/** Non-fatal issues, safe to log (no IDs). */
	readonly warnings: readonly string[];
};

export type AccessChange =
	/** Sets (or creates) someone's tier. Keeps their note and capabilities unless `note` is given. */
	| { kind: "set-tier"; id: string; tier: MemberTier; note?: string; reason?: string }
	/** Replaces someone's capabilities. They must already have an entry. */
	| { kind: "set-capabilities"; id: string; capabilities: readonly string[]; reason?: string };

/** Longest reason accepted. It goes into the audit log, not the file. */
export const MAX_REASON_LENGTH = 200;

export type AccessChangeResult = {
	before: MemberRecord | null;
	after: MemberRecord;
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
	/** Re-reads everything from storage, for edits made by hand. Keeps the old view if it's invalid. */
	reload(by: PlatformActor): Promise<ReloadResult>;
};
