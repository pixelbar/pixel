import { highestTier, TIER_LABELS, type Tier } from "../../core/access.ts";
import type { CapabilityRegistry } from "../../core/capabilities.ts";
import type { ResolvedUser, SubcommandDefinition, SubgroupDefinition } from "../../core/command.ts";
import { UserFacingError } from "../../core/errors.ts";
import { escapeMarkdown } from "../../core/format.ts";
import { type AccessStore, MAX_REASON_LENGTH } from "../../core/ports/access-store.ts";
import { ADMIN_ON_DISCORD } from "./access.ts";

/**
 * `/admin capabilities grant|revoke|list`: who holds which named permission.
 * Grants live in the members file, change only through the access store (so
 * they are audited), and are by immutable user ID. A capability does nothing
 * for a guest, and never replaces the tier a command requires.
 */

export type CapabilityCommandDeps = {
	access: Pick<AccessStore, "view" | "apply">;
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
	const reasonOption = {
		name: "reason",
		description: `Why, for the audit log (max ${MAX_REASON_LENGTH} characters)`,
		type: "string",
	} as const;

	const subcommands: SubcommandDefinition[] = [
		{
			name: "grant",
			description: "Give someone a capability",
			access: ADMIN_ON_DISCORD,
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
				const tier: Tier = view.tiers.get(`discord:${target.id}`) ?? "guest";
				if (tier === "guest") {
					throw new UserFacingError(
						`${describe(target)} is a guest, so a capability would do nothing. Make them a member or friend first.`,
					);
				}
				const held = view.records.get(`discord:${target.id}`)?.capabilities ?? [];
				if (held.includes(name)) {
					return { text: `${describe(target)} already has ${name}. Nothing changed.` };
				}
				await access.apply(
					{
						kind: "set-capabilities",
						ref: `discord:${target.id}`,
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
			name: "revoke",
			description: "Take a capability away from someone",
			access: ADMIN_ON_DISCORD,
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
				const held = access.view.records.get(`discord:${target.id}`)?.capabilities ?? [];
				if (!held.includes(name)) {
					return { text: `${describe(target)} doesn't have ${name}. Nothing changed.` };
				}
				await access.apply(
					{
						kind: "set-capabilities",
						ref: `discord:${target.id}`,
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
			name: "list",
			description: "See which capabilities exist, or what one person has",
			access: ADMIN_ON_DISCORD,
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
								highestTier(r.ids.map((ref) => view.tiers.get(ref) ?? "guest")) !== "guest",
						).length;
						return `**${c.name}**: ${c.description} (${holders} ${holders === 1 ? "person" : "people"})`;
					});
					return { embeds: [{ title: "Capabilities", description: lines.join("\n") }] };
				}

				logger.info(
					{ event: "admin.capabilities_lookup", target: `discord:${target.id}` },
					"looked up someone's capabilities",
				);
				const view = access.view;
				const tier: Tier = view.tiers.get(`discord:${target.id}`) ?? "guest";
				const held = view.records.get(`discord:${target.id}`)?.capabilities ?? [];
				return {
					embeds: [
						{
							title: escapeMarkdown(target.displayName),
							fields: [
								{ name: "Access level", value: TIER_LABELS[tier], inline: true },
								{
									name: "Capabilities",
									value:
										held.length === 0
											? "None"
											: held
													.map((name) =>
														capabilities.has(name)
															? label(name)
															: `${name} (not registered, ignored)`,
													)
													.join("\n") + (tier === "guest" ? "\n(inactive while a guest)" : ""),
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
		description: "Named permissions for individual people",
		access: ADMIN_ON_DISCORD,
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
