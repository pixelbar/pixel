import { type APIRole, PermissionFlagsBits, Routes } from "discord.js";
import type {
	Inspection,
	MirrorBackend,
	MirroredTier,
	MirrorResult,
	TierMirrorState,
	TierOff,
	WantedLevel,
} from "../../core/role-mirror.ts";
import { MIRRORED_TIERS } from "../../core/role-mirror.ts";

/**
 * The Discord side of the role mirror: Pixel's tiers pushed to the roles named
 * in config. It reads the server's roles and the bot's own standing fresh on
 * every call, never trusts a cached answer, and never reads a role to decide a
 * tier. Everything that decides something is a plain function, tested on its
 * own; the class only talks to Discord.
 */

/** Which Discord role (a name, or an ID) belongs to each tier. Unset means not mirrored. */
export type RoleMapping = Readonly<Record<MirroredTier, string | undefined>>;

export type DiscordRole = Pick<APIRole, "id" | "name" | "position" | "managed" | "permissions">;

/** Where the bot stands in the server's role list. */
export type BotStanding = { topPosition: number; canManageRoles: boolean };

export type ResolvedTier =
	| { tier: MirroredTier; status: "unconfigured" }
	| { tier: MirroredTier; status: "on"; roleId: string; roleName: string }
	| { tier: MirroredTier; status: "off"; reason: string };

const SNOWFLAKE = /^\d{17,20}$/;

/** The bot's highest role position, and whether any of its roles can manage roles. */
export function botStanding(
	roles: readonly DiscordRole[],
	heldRoleIds: readonly string[],
	guildId: string,
): BotStanding {
	// Everyone in a server has the @everyone role, whose ID is the server's ID.
	const held = new Set([...heldRoleIds, guildId]);
	const mine = roles.filter((role) => held.has(role.id));
	const permitted = PermissionFlagsBits.Administrator | PermissionFlagsBits.ManageRoles;
	return {
		topPosition: Math.max(0, ...mine.map((role) => role.position)),
		canManageRoles: mine.some((role) => (BigInt(role.permissions) & permitted) !== 0n),
	};
}

/**
 * Works out, for each tier, which role it maps to and whether it can be
 * mirrored. A problem turns off only that tier, and says why in words that
 * don't repeat the configured name.
 */
export function resolveTiers(
	mapping: RoleMapping,
	roles: readonly DiscordRole[],
	standing: BotStanding,
	guildId: string,
): ResolvedTier[] {
	const used = new Set<string>();
	return MIRRORED_TIERS.map((tier): ResolvedTier => {
		const ref = mapping[tier];
		if (ref === undefined) return { tier, status: "unconfigured" };
		const off = (reason: string): ResolvedTier => ({ tier, status: "off", reason });

		if (!standing.canManageRoles) return off("the bot doesn't have the Manage Roles permission");

		const matches = SNOWFLAKE.test(ref)
			? roles.filter((role) => role.id === ref)
			: roles.filter((role) => role.name === ref);
		if (matches.length === 0) return off("no role matches the configured name or ID");
		const [role] = matches;
		if (matches.length > 1 || !role) {
			return off("more than one role has the configured name, so use its ID instead");
		}
		if (role.id === guildId) return off("@everyone can't be mirrored");
		if (role.managed) return off("that role is managed by an integration");
		if (role.position >= standing.topPosition) {
			return off("that role isn't below the bot's highest role");
		}
		if (used.has(role.id)) return off("it's the same role as another tier, so each needs its own");
		used.add(role.id);
		return { tier, status: "on", roleId: role.id, roleName: role.name };
	});
}

/**
 * What to change so the person holds the role of `wanted` and no other mapped
 * role. A tier that is off or unconfigured is left alone entirely: it is
 * neither granted nor taken away.
 */
export function planChanges(
	wanted: WantedLevel,
	tiers: readonly ResolvedTier[],
	held: ReadonlySet<string>,
): { add: { roleId: string; roleName: string }[]; remove: { roleId: string; roleName: string }[] } {
	const add: { roleId: string; roleName: string }[] = [];
	const remove: { roleId: string; roleName: string }[] = [];
	for (const state of tiers) {
		if (state.status !== "on") continue;
		const has = held.has(state.roleId);
		const shouldHave = state.tier === wanted;
		if (shouldHave && !has) add.push({ roleId: state.roleId, roleName: state.roleName });
		if (!shouldHave && has) remove.push({ roleId: state.roleId, roleName: state.roleName });
	}
	return { add, remove };
}

/** The audit-log reason Discord shows: one line, 512 characters at most. */
export function auditReason(reason: string): string {
	const clean = reason
		.replace(/[\p{Cc}\p{Cf}]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
	return [...clean].slice(0, 512).join("");
}

const NOT_IN_SERVER = "that person isn't in the Discord server";

/** A safe sentence for a Discord API error we know how to explain, otherwise undefined. */
export function describeDiscordError(error: unknown): string | undefined {
	const code =
		typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
	switch (code) {
		case 10007: // Unknown Member
		case 10013: // Unknown User
			return NOT_IN_SERVER;
		case 50013: // Missing Permissions
			return "Discord says the bot isn't allowed to change that role";
		case 50001: // Missing Access
			return "Discord says the bot can't access the server";
		default:
			return undefined;
	}
}

/** The parts of discord.js's REST client this uses. */
export type RoleRest = {
	get(route: `/${string}`): Promise<unknown>;
	put(route: `/${string}`, options?: { reason?: string }): Promise<unknown>;
	delete(route: `/${string}`, options?: { reason?: string }): Promise<unknown>;
};

export type DiscordRoleMirrorOptions = {
	rest: RoleRest;
	guildId: string;
	/** The bot's own user ID. */
	botId: string;
	mapping: RoleMapping;
};

export class DiscordRoleMirror implements MirrorBackend {
	readonly #rest: RoleRest;
	readonly #guildId: string;
	readonly #botId: string;
	readonly #mapping: RoleMapping;

	constructor({ rest, guildId, botId, mapping }: DiscordRoleMirrorOptions) {
		this.#rest = rest;
		this.#guildId = guildId;
		this.#botId = botId;
		this.#mapping = mapping;
	}

	async states(): Promise<TierMirrorState[]> {
		return (await this.#resolve()).map(toState);
	}

	async apply(userId: string, wanted: WantedLevel, reason: string): Promise<MirrorResult> {
		const tiers = await this.#resolve();
		const early = earlyResult(tiers);
		if (early) return early;

		const held = await this.#heldBy(userId);
		if (typeof held === "string") return { kind: "failed", reason: held };

		const { add, remove } = planChanges(wanted, tiers, held);
		const off = offTiers(tiers);
		const why = auditReason(reason);
		try {
			for (const role of remove) {
				await this.#rest.delete(Routes.guildMemberRole(this.#guildId, userId, role.roleId), {
					reason: why,
				});
			}
			for (const role of add) {
				await this.#rest.put(Routes.guildMemberRole(this.#guildId, userId, role.roleId), {
					reason: why,
				});
			}
		} catch (error) {
			const known = describeDiscordError(error);
			if (!known) throw error;
			return { kind: "failed", reason: known };
		}
		if (add.length === 0 && remove.length === 0) return { kind: "in-sync", off };
		return {
			kind: "updated",
			added: add.map((role) => role.roleName),
			removed: remove.map((role) => role.roleName),
			off,
		};
	}

	async inspect(userId: string): Promise<Inspection> {
		const tiers = await this.#resolve();
		if (tiers.every((tier) => tier.status === "unconfigured")) return { kind: "unconfigured" };
		const active = tiers.filter((tier) => tier.status === "on");
		if (active.length === 0) return { kind: "failed", reason: offReasons(tiers) };

		const held = await this.#heldBy(userId);
		if (held === NOT_IN_SERVER) return { kind: "not-in-server" };
		if (typeof held === "string") return { kind: "failed", reason: held };
		return {
			kind: "ok",
			holdings: active.map((tier) => ({
				tier: tier.tier,
				role: tier.roleName,
				has: held.has(tier.roleId),
			})),
		};
	}

	/** Asks Discord for the roles and the bot's standing right now. */
	async #resolve(): Promise<ResolvedTier[]> {
		if (MIRRORED_TIERS.every((tier) => this.#mapping[tier] === undefined)) {
			return MIRRORED_TIERS.map((tier) => ({ tier, status: "unconfigured" }));
		}
		const roles = (await this.#rest.get(Routes.guildRoles(this.#guildId))) as DiscordRole[];
		const me = (await this.#rest.get(Routes.guildMember(this.#guildId, this.#botId))) as {
			roles: string[];
		};
		return resolveTiers(
			this.#mapping,
			roles,
			botStanding(roles, me.roles, this.#guildId),
			this.#guildId,
		);
	}

	/** The role IDs a person holds, or a sentence if they can't be looked up. */
	async #heldBy(userId: string): Promise<Set<string> | string> {
		try {
			const member = (await this.#rest.get(Routes.guildMember(this.#guildId, userId))) as {
				roles: string[];
			};
			return new Set(member.roles);
		} catch (error) {
			const known = describeDiscordError(error);
			if (!known) throw error;
			return known;
		}
	}
}

function toState(tier: ResolvedTier): TierMirrorState {
	if (tier.status === "on") return { tier: tier.tier, status: "on", role: tier.roleName };
	return tier;
}

function offTiers(tiers: readonly ResolvedTier[]): TierOff[] {
	return tiers.flatMap((tier) =>
		tier.status === "off" ? [{ tier: tier.tier, reason: tier.reason }] : [],
	);
}

function offReasons(tiers: readonly ResolvedTier[]): string {
	return offTiers(tiers)
		.map((tier) => `${tier.tier}: ${tier.reason}`)
		.join("; ");
}

/** Nothing to do (not configured), or nothing that can be done (every configured tier is off). */
function earlyResult(tiers: readonly ResolvedTier[]): MirrorResult | undefined {
	if (tiers.every((tier) => tier.status === "unconfigured")) return { kind: "unconfigured" };
	if (tiers.every((tier) => tier.status !== "on")) {
		return { kind: "failed", reason: offReasons(tiers) };
	}
	return undefined;
}
