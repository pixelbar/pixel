import { TIER_LABELS, type Tier } from "../../core/access.ts";
import type { ResolvedUser, SubcommandDefinition } from "../../core/command.ts";
import { UserFacingError } from "../../core/errors.ts";
import { escapeMarkdown, inlineCode } from "../../core/format.ts";
import {
	type AccessStore,
	MAX_REASON_LENGTH,
	type MemberTier,
} from "../../core/ports/access-store.ts";

/**
 * `/admin set-level` and `/admin whois`: who is a member or friend. Both act
 * on the person's immutable ID. Names, handles and notes are shown for people
 * to read only, and everything written by someone else is escaped or shown as a
 * code span so it can't render as formatting, links or mentions.
 */

export type MemberCommandDeps = Pick<AccessStore, "view" | "apply">;

const LEVELS: readonly MemberTier[] = ["member", "friend", "guest"];

export function createMemberSubcommands(access: MemberCommandDeps): SubcommandDefinition[] {
	return [
		{
			name: "set-level",
			description: "Make someone a member or friend, or set them back to guest",
			access: { minTier: "admin" },
			private: true,
			options: [
				{ name: "user", description: "The person", type: "user", required: true },
				{
					name: "level",
					description: "Their new level (guest keeps their entry but gives no access)",
					type: "string",
					required: true,
					choices: LEVELS,
				},
				{
					name: "reason",
					description: `Why, for the audit log (max ${MAX_REASON_LENGTH} characters)`,
					type: "string",
				},
			],
			handler: async ({ args, users, principal }) => {
				const target = pickedUser(users, "user");
				const level = args.level as MemberTier; // validated against the choices
				const reason = typeof args.reason === "string" ? args.reason.trim() : "";
				if ([...reason].length > MAX_REASON_LENGTH) {
					throw new UserFacingError(`A reason can be at most ${MAX_REASON_LENGTH} characters.`);
				}

				const view = access.view;
				if (view.discord.get(target.id) === "admin") {
					throw new UserFacingError(
						`${describe(target)} is a Pixel admin. Admins are managed in admins.yaml only.`,
					);
				}
				const current = view.records.get(target.id)?.tier ?? "guest";
				if (current === level) {
					return {
						text: `${describe(target)} is already set to ${TIER_LABELS[level]}. Nothing changed.`,
					};
				}

				const { before, after } = await access.apply(
					{ kind: "set-tier", id: target.id, tier: level, ...(reason ? { reason } : {}) },
					principal,
				);
				const stillHasCapabilities = level === "guest" && after.capabilities.length > 0;
				return {
					embeds: [
						{
							title: "Access level changed",
							accent: "positive",
							fields: [
								{ name: "Person", value: describe(target) },
								{ name: "Before", value: TIER_LABELS[before?.tier ?? "guest"], inline: true },
								{ name: "Now", value: TIER_LABELS[after.tier], inline: true },
								...(stillHasCapabilities
									? [
											{
												name: "Capabilities",
												value: "Kept, but inactive while they're a guest.",
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
			name: "whois",
			description: "See someone's Pixel access level, where it comes from, and their capabilities",
			access: { minTier: "admin" },
			private: true,
			options: [
				{ name: "user", description: "The person", type: "user", required: true, allowBots: true },
			],
			handler: async ({ users, logger }) => {
				const target = pickedUser(users, "user");
				// Lookups show a note and capabilities, so they're recorded like changes are.
				logger.info({ event: "admin.whois", target: `discord:${target.id}` }, "looked up a person");

				const title = escapeMarkdown(target.displayName);
				const identity = [
					{ name: "Discord ID", value: target.id, inline: true },
					...(target.handle
						? [{ name: "Handle", value: inlineCode(target.handle), inline: true }]
						: []),
				];
				if (target.isBot) {
					return {
						embeds: [
							{
								title,
								fields: [
									...identity,
									{ name: "Access level", value: "A bot. Bots have no level." },
								],
							},
						],
					};
				}

				const view = access.view;
				const record = view.records.get(target.id);
				const tier: Tier = view.discord.get(target.id) ?? "guest";
				const capabilities = record?.capabilities ?? [];
				return {
					embeds: [
						{
							title,
							fields: [
								...identity,
								{ name: "Access level", value: TIER_LABELS[tier] },
								{ name: "Comes from", value: source(tier, record !== undefined) },
								{
									name: "Capabilities",
									value:
										capabilities.length === 0
											? "None"
											: `${capabilities.join(", ")}${tier === "guest" ? " (inactive while a guest)" : ""}`,
								},
								...(record?.note ? [{ name: "Note", value: inlineCode(record.note, 300) }] : []),
							],
						},
					],
				};
			},
		},
	];
}

function source(tier: Tier, listed: boolean): string {
	if (tier === "admin") return "config/admins.yaml";
	if (tier === "guest") return listed ? "config/members.yaml (set to guest)" : "Not listed";
	return "config/members.yaml";
}

/** "Name (id)", with the name escaped. The ID is what identifies them. */
function describe(user: ResolvedUser): string {
	return `${escapeMarkdown(user.displayName)} (${user.id})`;
}

function pickedUser(users: Readonly<Record<string, ResolvedUser>>, name: string): ResolvedUser {
	const user = users[name];
	// The dispatcher only calls a handler once a required user option is resolved.
	if (!user) throw new Error(`missing resolved user "${name}"`);
	return user;
}
