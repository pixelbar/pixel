import { actorRef } from "../../core/access.ts";
import type { CommandContext, SubcommandDefinition } from "../../core/command.ts";
import { UserFacingError } from "../../core/errors.ts";
import type { Feature } from "../../core/feature.ts";
import { escapeMarkdown } from "../../core/format.ts";
import { type Revbank, RevbankError, type RevbankLink } from "../../core/ports/revbank.ts";
import type { Reply } from "../../core/reply.ts";

export const REVBANK_LINK_ADMIN = {
	name: "revbank-link-admin",
	description: "Review, approve and revoke RevBank account links (no access to balances)",
};
const MESSAGES = {
	unavailable: "RevBank is unavailable or its backup is too old. Please try again later.",
	"not-linked":
		"You do not have a usable RevBank link. Use `/revbank status`; unlink an old account before requesting a new link.",
	denied: "The RevBank service refused this action.",
	conflict: "The link or request has changed, expired, or cannot be approved. Review it again.",
};
const money = (cents: number) =>
	new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" }).format(cents / 100);
const when = (value: string, timezone: string) =>
	new Intl.DateTimeFormat("en-GB", {
		dateStyle: "medium",
		timeStyle: "short",
		timeZone: timezone,
	}).format(new Date(value));

function describe(link: RevbankLink): string {
	if (link.state === "unlinked") return "No RevBank account is linked.";
	if (link.state === "linked") return `Linked to **${escapeMarkdown(link.nick ?? "")}**.`;
	return `Pending request for **${escapeMarkdown(link.nick ?? "")}**.\nRequest: ${link.requestId}\nA link manager must verify that this account is yours before approving it.`;
}

export function createRevbankFeature(deps: {
	api: Revbank | undefined;
	timezone: string;
}): Feature {
	const run =
		(action: (api: Revbank, ctx: CommandContext) => Promise<Reply>) =>
		async (ctx: CommandContext): Promise<Reply> => {
			if (!deps.api) return { text: "RevBank isn't set up here.", private: true };
			try {
				return { ...(await action(deps.api, ctx)), private: true };
			} catch (error) {
				if (!(error instanceof RevbankError)) throw error;
				return { text: MESSAGES[error.code], private: true };
			}
		};
	const own = (
		name: string,
		description: string,
		action: (api: Revbank, ctx: CommandContext) => Promise<Reply>,
	): SubcommandDefinition => ({
		name,
		description,
		access: { minTier: "guest" },
		private: true,
		handler: run(action),
	});
	const target = (ctx: CommandContext) => {
		const user = ctx.users.user;
		if (!user || user.isBot) throw new UserFacingError("Choose a person.");
		return `discord:${user.id}`;
	};
	const requestId = (ctx: CommandContext) => {
		const id = ctx.args.request;
		if (
			typeof id !== "string" ||
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
		)
			throw new UserFacingError("Use the request ID from the review.");
		return id;
	};
	const userOption = {
		name: "user",
		description: "The person whose link to manage",
		type: "user",
		required: true,
	} as const;
	const manager = (
		name: string,
		description: string,
		action: (api: Revbank, ctx: CommandContext) => Promise<Reply>,
		decision = false,
	): SubcommandDefinition => ({
		name,
		description,
		access: { minTier: "member", capability: REVBANK_LINK_ADMIN.name },
		private: true,
		options: [
			userOption,
			...(decision
				? [
						{
							name: "request",
							description: "The exact request ID you reviewed",
							type: "string" as const,
							required: true,
						},
					]
				: []),
		],
		handler: run(action),
	});
	return {
		name: "revbank",
		commands: [
			{
				name: "revbank",
				description: "Your private RevBank account",
				access: { minTier: "guest" },
				subcommands: [
					own("status", "Show your RevBank link or pending request", async (api, ctx) => ({
						text: describe(await api.status(actorRef(ctx.principal))),
					})),
					{
						...own("link", "Request a verified link to your RevBank account", async (api, ctx) => {
							const nick = ctx.args.nick;
							if (typeof nick !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(nick))
								throw new UserFacingError(
									"Enter a RevBank account name using letters, numbers, dots, hyphens or underscores.",
								);
							return { text: describe(await api.request(actorRef(ctx.principal), nick)) };
						}),
						options: [
							{
								name: "nick",
								description: "Your RevBank account name",
								type: "string",
								required: true,
							},
						],
					},
					own("unlink", "Remove your link and any pending request", async (api, ctx) => {
						await api.unlink(actorRef(ctx.principal));
						return { text: "Your RevBank link and pending request have been removed." };
					}),
					own("balance", "Show your balance from the latest usable backup", async (api, ctx) => {
						const result = await api.balance(actorRef(ctx.principal));
						return {
							text: `Your RevBank balance: **${money(result.balanceCents)}**\nBackup: ${when(result.updatedAt, deps.timezone)}. Purchases since then may not be included.`,
						};
					}),
					own("transactions", "Show your last ten confirmed bookings", async (api, ctx) => {
						const result = await api.history(actorRef(ctx.principal));
						return {
							text: `Backup: ${when(result.updatedAt, deps.timezone)}.`,
							embeds: [
								{
									title: "Your latest RevBank bookings",
									...(result.transactions.length === 0
										? { description: "No confirmed bookings found." }
										: {}),
									fields: result.transactions.map((tx) => ({
										name: `${when(tx.at, deps.timezone)} · ${money(tx.amountCents)}`,
										value: `${escapeMarkdown(tx.description)} · balance ${money(tx.balanceCents)}`,
									})),
								},
							],
						};
					}),
				],
			},
			{
				name: "revbank-manage",
				description: "Manage verified RevBank links, without viewing balances",
				access: { minTier: "member", capability: REVBANK_LINK_ADMIN.name },
				subcommands: [
					manager(
						"review",
						"Review a person's link request before verifying ownership",
						async (api, ctx) => ({
							text: describe(await api.review(actorRef(ctx.principal), target(ctx))),
						}),
					),
					manager(
						"approve",
						"Approve the exact request after verifying ownership in person",
						async (api, ctx) => {
							await api.decide(actorRef(ctx.principal), target(ctx), requestId(ctx), true);
							return { text: "RevBank link approved." };
						},
						true,
					),
					manager(
						"reject",
						"Reject the exact link request",
						async (api, ctx) => {
							await api.decide(actorRef(ctx.principal), target(ctx), requestId(ctx), false);
							return { text: "RevBank request rejected." };
						},
						true,
					),
					manager("revoke", "Remove a person's link and pending request", async (api, ctx) => {
						await api.revoke(actorRef(ctx.principal), target(ctx));
						return { text: "RevBank link and pending request revoked." };
					}),
				],
			},
		],
	};
}
