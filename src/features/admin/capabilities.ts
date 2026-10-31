import { highestTier, splitRef, TIER_LABELS, type Tier } from "../../core/access.ts";
import { type CapabilityRegistry, tierGrantsFor } from "../../core/capabilities.ts";
import type {
	ResolvedUser,
	SubcommandDefinition,
	SubgroupDefinition,
	Suggestion,
} from "../../core/command.ts";
import { UserFacingError } from "../../core/errors.ts";
import { escapeMarkdown } from "../../core/format.ts";
import {
	type AccessStore,
	type GrantTier,
	MAX_REASON_LENGTH,
} from "../../core/ports/access-store.ts";

/**
 * `/admin capabilities grant|grant-all|revoke|grant-level|revoke-level|list`: who
 * holds which named permission. Grants live in the members file, change only
 * through the access store (so they are audited), and are by immutable user ID
 * or by membership level. A capability does nothing for a guest, and never
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
		// Suggestions, not choices: Discord counts every choice towards /admin's size limit,
		// once per subcommand. The handlers check the name is registered.
		suggest: async ({ typed }: { typed: string }) => suggestCapabilities(capabilities.all(), typed),
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
				const held = view.records.get(target.id)?.capabilities ?? [];
				if (held.includes(name)) {
					return { text: `${describe(target)} already has ${name}. Nothing changed.` };
				}
				await access.apply(
					{
						kind: "set-capabilities",
						id: target.id,
						capabilities: [...held, name],
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
				const held = view.records.get(target.id)?.capabilities ?? [];
				const missing = names.filter((name) => !held.includes(name));
				if (missing.length === 0) {
					return { text: `${describe(target)} already has every capability. Nothing changed.` };
				}
				await access.apply(
					{
						kind: "set-capabilities",
						id: target.id,
						capabilities: [...held, ...missing],
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
				const held = record?.capabilities ?? [];
				if (!held.includes(name)) {
					const level = record?.tier ?? "guest";
					const fromLevel = tierGrantsFor(view.tierCapabilities, level).includes(name);
					return {
						text: fromLevel
							? `${describe(target)} gets ${name} from their ${level} level, not a grant of their own. Nothing changed. Use /admin capabilities revoke-level to take it from the level.`
							: `${describe(target)} doesn't have ${name}. Nothing changed.`,
					};
				}
				await access.apply(
					{
						kind: "set-capabilities",
						id: target.id,
						capabilities: held.filter((held) => held !== name),
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
					const lines = capabilities.all().map((c) => {
						// A person can appear under several IDs, so count each record once.
						const holders = [...new Set(view.records.values())].filter(
							(r) =>
								r.capabilities.includes(c.name) &&
								highestTier(
									r.ids.map((ref) => view.discord.get(splitRef(ref).userId) ?? "guest"),
								) !== "guest",
						).length;
						const level = LEVELS.filter((l) => view.tierCapabilities[l].includes(c.name))
							.map((l) => REACHES[l])
							.at(-1);
						return `**${c.name}**: ${c.description} (${holders} ${holders === 1 ? "person" : "people"}${level ? `, and ${level}` : ""})`;
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
				const held = record?.capabilities ?? [];
				const level = record?.tier ?? "guest";
				const fromLevel = tierGrantsFor(view.tierCapabilities, level).filter(
					(name) => !held.includes(name),
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

/** Registered capabilities whose name or description has what was typed, at most 25. */
export function suggestCapabilities(
	all: readonly { name: string; description: string }[],
	typed: string,
): Suggestion[] {
	const needle = typed.trim().toLowerCase();
	return all
		.filter(
			(c) => c.name.toLowerCase().includes(needle) || c.description.toLowerCase().includes(needle),
		)
		.slice(0, 25)
		.map((c) => ({ name: `${c.name}: ${c.description}`.slice(0, 100), value: c.name }));
}

/** The level an admin picked. The platform doesn't check it came from the choices. */
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
