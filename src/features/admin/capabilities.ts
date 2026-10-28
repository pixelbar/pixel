import { highestTier, splitRef, TIER_LABELS, type Tier } from "../../core/access.ts";
import {
	type CapabilityRegistry,
	heldCapabilities,
	tierGrantsFor,
} from "../../core/capabilities.ts";
import type { ResolvedUser, SubcommandDefinition, SubgroupDefinition } from "../../core/command.ts";
import { UserFacingError } from "../../core/errors.ts";
import { escapeMarkdown } from "../../core/format.ts";
import {
	type AccessStore,
	type GrantTier,
	MAX_REASON_LENGTH,
	type MemberRecord,
	type TierGrants,
} from "../../core/ports/access-store.ts";

/**
 * `/admin capabilities grant|grant-all|revoke|grant-level|revoke-level|list`: who
 * holds which named permission. Grants live in the members file, change only
 * through the access store (so they are audited), and are by immutable user ID
 * or by membership level. Revoking from a person also works on what their level
 * gives them: it is recorded as a revocation on their entry, which wins over
 * every grant (ADR 0022). A capability does nothing for a guest, and never
 * replaces the tier a command requires.
 */

const LEVELS: readonly GrantTier[] = ["member", "friend"];

/** Who a level grant reaches, for admins reading it. */
const REACHES: Record<GrantTier, string> = {
	friend: "every friend and member",
	member: "every member",
};

export type CapabilityCommandDeps = {
	access: Pick<AccessStore, "view" | "apply" | "setTierCapabilities">;
	capabilities: Pick<CapabilityRegistry, "all" | "has" | "get">;
};

export function createCapabilitySubgroup(deps: CapabilityCommandDeps): SubgroupDefinition {
	const { access, capabilities } = deps;
	const names = capabilities.all().map((c) => c.name);

	const capabilityOption = {
		name: "capability",
		description: "Which capability",
		type: "string",
		required: true,
		// Discord shows a picker when there are choices, and free text when there are none.
		...(names.length > 0 ? { choices: names } : {}),
	} as const;
	const levelOption = {
		name: "level",
		description: "Which membership level (a friend grant reaches members too)",
		type: "string",
		required: true,
		choices: [...LEVELS],
	} as const;
	const reasonOption = {
		name: "reason",
		description: `Why, for the audit log (max ${MAX_REASON_LENGTH} characters)`,
		type: "string",
	} as const;

	const subcommands: SubcommandDefinition[] = [
		{
			name: "grant",
			description: "Give someone a capability",
			access: { minTier: "admin" },
			private: true,
			options: [
				{ name: "user", description: "The person", type: "user", required: true },
				capabilityOption,
				reasonOption,
			],
			handler: async ({ args, users, principal }) => {
				const name = registered(String(args.capability));
				const target = pickedUser(users);
				const reason = checkedReason(args.reason);
				const view = access.view;
				const tier: Tier = view.discord.get(target.id) ?? "guest";
				if (tier === "guest") {
					throw new UserFacingError(
						`${describe(target)} is a guest, so a capability would do nothing. Make them a member or friend first.`,
					);
				}
				const record = view.records.get(target.id);
				if (record && heldCapabilities(record, view.tierCapabilities).includes(name)) {
					return { text: `${describe(target)} already has ${name}. Nothing changed.` };
				}
				await access.apply(
					{
						...granting(record, [name], view.tierCapabilities),
						id: target.id,
						...(reason ? { reason } : {}),
					},
					principal,
				);
				return {
					embeds: [
						{
							title: "Capability granted",
							accent: "positive",
							fields: [
								{ name: "Person", value: describe(target) },
								{ name: "Capability", value: label(name) },
							],
						},
					],
				};
			},
		},
		{
			name: "grant-all",
			description: "Give someone every capability that exists",
			access: { minTier: "admin" },
			private: true,
			options: [
				{ name: "user", description: "The person", type: "user", required: true },
				reasonOption,
			],
			handler: async ({ args, users, principal }) => {
				if (names.length === 0) throw new UserFacingError("No capabilities are registered yet.");
				const target = pickedUser(users);
				const reason = checkedReason(args.reason);
				const view = access.view;
				const tier: Tier = view.discord.get(target.id) ?? "guest";
				if (tier === "guest") {
					throw new UserFacingError(
						`${describe(target)} is a guest, so a capability would do nothing. Make them a member or friend first.`,
					);
				}
				const record = view.records.get(target.id);
				const held = record ? heldCapabilities(record, view.tierCapabilities) : [];
				const missing = names.filter((name) => !held.includes(name));
				if (missing.length === 0) {
					return { text: `${describe(target)} already has every capability. Nothing changed.` };
				}
				await access.apply(
					{
						...granting(record, missing, view.tierCapabilities),
						id: target.id,
						...(reason ? { reason } : {}),
					},
					principal,
				);
				return {
					embeds: [
						{
							title: "Capabilities granted",
							accent: "positive",
							fields: [
								{ name: "Person", value: describe(target) },
								{ name: "Capabilities", value: missing.map(label).join("\n") },
							],
						},
					],
				};
			},
		},
		{
			name: "revoke",
			description: "Take a capability away from someone",
			access: { minTier: "admin" },
			private: true,
			options: [
				{ name: "user", description: "The person", type: "user", required: true },
				capabilityOption,
				reasonOption,
			],
			handler: async ({ args, users, principal }) => {
				const name = registered(String(args.capability));
				const target = pickedUser(users);
				const reason = checkedReason(args.reason);
				const view = access.view;
				const record = view.records.get(target.id);
				if (!record || !heldCapabilities(record, view.tierCapabilities).includes(name)) {
					return { text: `${describe(target)} doesn't have ${name}. Nothing changed.` };
				}
				// Their level still gives it, so taking away their own grant isn't enough: record a
				// revocation, which wins over the level's grant for them alone.
				const fromLevel = tierGrantsFor(view.tierCapabilities, record.tier).includes(name);
				await access.apply(
					{
						kind: "set-capabilities",
						id: target.id,
						capabilities: record.capabilities.filter((held) => held !== name),
						...(fromLevel ? { revoked: [...record.revoked, name] } : {}),
						...(reason ? { reason } : {}),
					},
					principal,
				);
				return {
					embeds: [
						{
							title: "Capability revoked",
							accent: "warning",
							fields: [
								{ name: "Person", value: describe(target) },
								{ name: "Capability", value: label(name) },
								...(fromLevel
									? [
											{
												name: "Note",
												value: `Their ${record.tier} level gives it, so it's revoked for them alone and stays revoked if their level changes. Everyone else at the level keeps it. /admin capabilities grant gives it back.`,
											},
										]
									: []),
							],
						},
					],
				};
			},
		},
		{
			name: "grant-level",
			description: "Give a capability to everyone at a membership level",
			access: { minTier: "admin" },
			private: true,
			options: [levelOption, capabilityOption, reasonOption],
			handler: async ({ args, principal }) => {
				const level = pickedLevel(args.level);
				const name = registered(String(args.capability));
				const reason = checkedReason(args.reason);
				const held = access.view.tierCapabilities[level];
				if (held.includes(name)) {
					return { text: `The ${level} level already has ${name}. Nothing changed.` };
				}
				await access.setTierCapabilities(
					{ tier: level, capabilities: [...held, name], ...(reason ? { reason } : {}) },
					principal,
				);
				return {
					embeds: [
						{
							title: "Capability granted to a level",
							accent: "positive",
							fields: [
								{ name: "Level", value: level, inline: true },
								{ name: "Reaches", value: REACHES[level], inline: true },
								{ name: "Capability", value: label(name) },
								{
									name: "Note",
									value: "Anyone it was revoked from on their own still doesn't have it.",
								},
							],
						},
					],
				};
			},
		},
		{
			name: "revoke-level",
			description: "Take a capability away from a membership level",
			access: { minTier: "admin" },
			private: true,
			options: [levelOption, capabilityOption, reasonOption],
			handler: async ({ args, principal }) => {
				const level = pickedLevel(args.level);
				const name = registered(String(args.capability));
				const reason = checkedReason(args.reason);
				const held = access.view.tierCapabilities[level];
				if (!held.includes(name)) {
					return { text: `The ${level} level doesn't have ${name}. Nothing changed.` };
				}
				await access.setTierCapabilities(
					{
						tier: level,
						capabilities: held.filter((other) => other !== name),
						...(reason ? { reason } : {}),
					},
					principal,
				);
				return {
					embeds: [
						{
							title: "Capability revoked from a level",
							accent: "warning",
							fields: [
								{ name: "Level", value: level, inline: true },
								{ name: "Capability", value: label(name) },
								{
									name: "Note",
									value: "People who were also granted it on their own keep it.",
								},
							],
						},
					],
				};
			},
		},
		{
			name: "list",
			description: "See which capabilities exist, or what one person has",
			access: { minTier: "admin" },
			private: true,
			options: [{ name: "user", description: "Show just this person", type: "user" }],
			handler: async ({ users, logger }) => {
				if (capabilities.all().length === 0) {
					return { text: "No capabilities are registered yet." };
				}
				const target = users.user;
				if (!target) {
					const view = access.view;
					// A person can appear under several IDs, so count each record once.
					const active = [...new Set(view.records.values())].filter(
						(r) =>
							highestTier(r.ids.map((ref) => view.discord.get(splitRef(ref).userId) ?? "guest")) !==
							"guest",
					);
					const lines = capabilities.all().map((c) => {
						const holders = active.filter(
							(r) => r.capabilities.includes(c.name) && !r.revoked.includes(c.name),
						).length;
						const revoked = active.filter((r) => r.revoked.includes(c.name)).length;
						const level = LEVELS.filter((l) => view.tierCapabilities[l].includes(c.name))
							.map((l) => REACHES[l])
							.at(-1);
						return `**${c.name}**: ${c.description} (${holders} ${holders === 1 ? "person" : "people"}${level ? `, and ${level}` : ""}${revoked > 0 ? `; revoked from ${revoked}` : ""})`;
					});
					return { embeds: [{ title: "Capabilities", description: lines.join("\n") }] };
				}

				logger.info(
					{ event: "admin.capabilities_lookup", target: `discord:${target.id}` },
					"looked up someone's capabilities",
				);
				const view = access.view;
				const tier: Tier = view.discord.get(target.id) ?? "guest";
				const record = view.records.get(target.id);
				const revoked = record?.revoked ?? [];
				const held = (record?.capabilities ?? []).filter((name) => !revoked.includes(name));
				const level = record?.tier ?? "guest";
				const fromLevel = tierGrantsFor(view.tierCapabilities, level).filter(
					(name) => !held.includes(name) && !revoked.includes(name),
				);
				const lines = [
					...held.map((name) =>
						capabilities.has(name) ? label(name) : `${name} (not registered, ignored)`,
					),
					...fromLevel.map((name) =>
						capabilities.has(name)
							? `${label(name)} (from the ${level} level)`
							: `${name} (from the ${level} level, not registered, ignored)`,
					),
				];
				return {
					embeds: [
						{
							title: escapeMarkdown(target.displayName),
							fields: [
								{ name: "Access level", value: TIER_LABELS[tier], inline: true },
								{
									name: "Capabilities",
									value:
										lines.length === 0
											? "None"
											: lines.join("\n") + (tier === "guest" ? "\n(inactive while a guest)" : ""),
								},
								...(revoked.length > 0 ? [{ name: "Revoked", value: revoked.join("\n") }] : []),
							],
						},
					],
				};
			},
		},
	];

	return {
		name: "capabilities",
		description: "Named permissions for people or membership levels",
		access: { minTier: "admin" },
		subcommands,
	};

	/** A capability that exists, or a message saying why not. */
	function registered(name: string): string {
		if (capabilities.all().length === 0) {
			throw new UserFacingError("No capabilities are registered yet.");
		}
		if (!capabilities.has(name)) throw new UserFacingError("That capability doesn't exist.");
		return name;
	}

	function label(name: string): string {
		const description = capabilities.get(name)?.description;
		return description ? `${name}: ${description}` : name;
	}
}

/**
 * The change that gives someone `names`: lifts any revocation of them, and adds
 * a grant of their own only for those their level doesn't already give.
 */
function granting(
	record: MemberRecord | undefined,
	names: readonly string[],
	grants: TierGrants,
): { kind: "set-capabilities"; capabilities: string[]; revoked: string[] } {
	const own = record?.capabilities ?? [];
	const fromLevel = record ? tierGrantsFor(grants, record.tier) : [];
	return {
		kind: "set-capabilities",
		capabilities: [
			...own,
			...names.filter((name) => !own.includes(name) && !fromLevel.includes(name)),
		],
		revoked: (record?.revoked ?? []).filter((name) => !names.includes(name)),
	};
}

/** The level an admin picked.
 The platform doesn't check it came from the choices. */
function pickedLevel(value: unknown): GrantTier {
	const level = LEVELS.find((l) => l === value);
	if (!level) throw new UserFacingError("Pick the member or friend level.");
	return level;
}

function checkedReason(value: unknown): string {
	const reason = typeof value === "string" ? value.trim() : "";
	if ([...reason].length > MAX_REASON_LENGTH) {
		throw new UserFacingError(`A reason can be at most ${MAX_REASON_LENGTH} characters.`);
	}
	return reason;
}

function describe(user: ResolvedUser): string {
	return `${escapeMarkdown(user.displayName)} (${user.id})`;
}

function pickedUser(users: Readonly<Record<string, ResolvedUser>>): ResolvedUser {
	const user = users.user;
	// The dispatcher only calls a handler once a required user option is resolved.
	if (!user) throw new Error('missing resolved user "user"');
	return user;
}
