import { actorLogFields, actorRef, type Principal } from "../../core/access.ts";
import type { CapabilityDefinition } from "../../core/capabilities.ts";
import type { ChannelPosts } from "../../core/channel-posts.ts";
import type { CommandOption, PlainCommand } from "../../core/command.ts";
import { UserFacingError } from "../../core/errors.ts";
import type { Feature } from "../../core/feature.ts";
import { escapeMarkdown } from "../../core/format.ts";
import type { Logger } from "../../core/logger.ts";
import type { Embed, Reply } from "../../core/reply.ts";
import type {
	ActionContext,
	ActionDefinition,
	ActionResult,
	Control,
	ControlRow,
	Form,
} from "../../core/ui.ts";
import type { FoodWishlistStore, WishlistItem } from "../../services/food-wishlist.ts";

export const FOOD_CAPABILITY: CapabilityDefinition = {
	name: "food-wishlist",
	description: "Manage the hackerspace's food wishlist",
};

const ACCESS = { minTier: "member" as const, capability: FOOD_CAPABILITY.name };

const ACTIONS = {
	home: "food.home",
	addForm: "food.add-form",
	add: "food.add",
	removeForm: "food.remove-form",
	remove: "food.remove",
	removeAdminForm: "food.remove-admin-form",
	removeAdmin: "food.remove-admin",
	outOfStockForm: "food.out-of-stock-form",
	outOfStock: "food.out-of-stock",
	clearStockForm: "food.clear-stock-form",
	clearStock: "food.clear-stock",
} as const;

export type FoodDeps = {
	wishlist: FoodWishlistStore;
	poster?: Pick<ChannelPosts, "post">;
	/** Optional channel ID for out-of-stock alerts to admins. */
	alertChannelId?: string;
	logger: Logger;
	now?: () => Date;
};

const button = (
	label: string,
	action: string,
	args: Record<string, string> = {},
	style: "primary" | "secondary" | "success" | "danger" = "secondary",
): Control => ({
	kind: "button",
	label,
	style,
	call: { action, args },
});

function formatWishlistItems(items: readonly WishlistItem[]): string {
	if (items.length === 0) return "No items on the wishlist yet.";

	const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name));
	const lines = sorted.map((item) => {
		const requesters = item.requesters.map((r) => escapeMarkdown(r.name)).join(", ");
		return `• **${escapeMarkdown(item.name)}** (requested by ${requesters})`;
	});

	// Fit in Discord's limit
	const maxLength = 4000;
	const joined = lines.join("\n");
	if (joined.length <= maxLength) return joined;

	// Truncate and add count of remaining items
	let result = "";
	let included = 0;
	for (const line of lines) {
		if (result.length + line.length + 1 + 50 > maxLength) break;
		result += (result ? "\n" : "") + line;
		included++;
	}
	return `${result}\n\n…and ${lines.length - included} more.`;
}

function formatOutOfStockItems(
	items: readonly { name: string; reportedBy: { name: string } }[],
): string {
	if (items.length === 0) return "Nothing reported out of stock.";

	const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name));
	const lines = sorted.map(
		(item) =>
			`• **${escapeMarkdown(item.name)}** (reported by ${escapeMarkdown(item.reportedBy.name)})`,
	);

	const maxLength = 4000;
	const joined = lines.join("\n");
	if (joined.length <= maxLength) return joined;

	let result = "";
	let included = 0;
	for (const line of lines) {
		if (result.length + line.length + 1 + 50 > maxLength) break;
		result += (result ? "\n" : "") + line;
		included++;
	}
	return `${result}\n\n…and ${lines.length - included} more.`;
}

function createPanel(
	notice: string[],
	wishlist: readonly WishlistItem[],
	outOfStock: readonly { name: string; reportedBy: { name: string } }[],
	isAdmin: boolean,
): Reply {
	const embeds: Embed[] = [
		{
			title: "🛒 Food Wishlist",
			description:
				notice.length > 0
					? notice.join("\n")
					: "Add snacks and food you'd like the hackerspace to stock. Admins will buy items from the list.",
			accent: "brand",
		},
		{
			title: "Wishlist",
			description: formatWishlistItems(wishlist),
			accent: "neutral",
		},
	];

	if (outOfStock.length > 0 || isAdmin) {
		embeds.push({
			title: "Out of Stock",
			description: formatOutOfStockItems(outOfStock),
			accent: outOfStock.length > 0 ? "warning" : "neutral",
		});
	}

	const controls: ControlRow[] = [
		[
			button("Add item", ACTIONS.addForm, {}, "success"),
			button("Remove my request", ACTIONS.removeForm),
			button("Report out of stock", ACTIONS.outOfStockForm),
		],
	];

	if (isAdmin) {
		controls.push([
			button("Remove any item", ACTIONS.removeAdminForm, {}, "danger"),
			button("Clear from out of stock", ACTIONS.clearStockForm),
		]);
	}

	controls.push([button("Refresh", ACTIONS.home)]);

	return {
		embeds,
		private: true,
		controls,
	};
}

const itemArg: CommandOption = {
	name: "item",
	description: "Item name",
	type: "string",
	required: true,
};

const addForm: Form = {
	title: "Add to wishlist",
	submit: { action: ACTIONS.add },
	fields: [
		{
			kind: "text",
			name: "item",
			label: "Item name",
			description: "What would you like the hackerspace to stock?",
			style: "short",
			maxLength: 200,
			placeholder: "e.g. Club-Mate, stroopwafels",
			required: true,
		},
	],
};

const removeForm: Form = {
	title: "Remove your request",
	submit: { action: ACTIONS.remove },
	fields: [
		{
			kind: "text",
			name: "item",
			label: "Item name",
			description: "Which item do you want to remove your request for?",
			style: "short",
			maxLength: 200,
			required: true,
		},
	],
};

const removeAdminForm: Form = {
	title: "Remove item (admin)",
	submit: { action: ACTIONS.removeAdmin },
	fields: [
		{
			kind: "text",
			name: "item",
			label: "Item name",
			description: "Which item do you want to remove from the wishlist?",
			style: "short",
			maxLength: 200,
			required: true,
		},
	],
};

const outOfStockForm: Form = {
	title: "Report out of stock",
	submit: { action: ACTIONS.outOfStock },
	fields: [
		{
			kind: "text",
			name: "item",
			label: "Item name",
			description: "What has run out?",
			style: "short",
			maxLength: 200,
			required: true,
		},
	],
};

const clearStockForm: Form = {
	title: "Clear from out of stock",
	submit: { action: ACTIONS.clearStock },
	fields: [
		{
			kind: "text",
			name: "item",
			label: "Item name",
			description: "Which item has been restocked?",
			style: "short",
			maxLength: 200,
			required: true,
		},
	],
};

export function createFoodFeature(deps: FoodDeps): Feature {
	const now = deps.now ?? (() => new Date());
	const isAdmin = (principal: Principal) => principal.tier === "admin";

	const usable = () => {
		if (deps.wishlist.problem) {
			throw new UserFacingError(
				"The food wishlist is unavailable right now. Ask an admin to look at it.",
			);
		}
	};

	async function onPanel(
		principal: Principal,
		work: () => Promise<string[]> | string[],
	): Promise<Reply> {
		try {
			const notice = await work();
			return createPanel(
				notice,
				deps.wishlist.wishlist(),
				deps.wishlist.outOfStock(),
				isAdmin(principal),
			);
		} catch (error) {
			if (error instanceof UserFacingError) {
				return createPanel(
					[`⚠️ ${error.message}`],
					deps.wishlist.wishlist(),
					deps.wishlist.outOfStock(),
					isAdmin(principal),
				);
			}
			throw error;
		}
	}

	const food: PlainCommand = {
		name: "food",
		description: "Manage the hackerspace's food wishlist",
		access: ACCESS,
		private: true,
		handler: async ({ principal }) =>
			createPanel([], deps.wishlist.wishlist(), deps.wishlist.outOfStock(), isAdmin(principal)),
	};

	const action = (
		name: string,
		options: readonly CommandOption[],
		handler: (ctx: ActionContext) => Promise<ActionResult> | ActionResult,
	): ActionDefinition => ({
		name,
		access: ACCESS,
		options,
		handler: async (ctx) => handler(ctx),
	});

	const actions: ActionDefinition[] = [
		action(ACTIONS.home, [], (ctx) => ({
			reply: createPanel(
				[],
				deps.wishlist.wishlist(),
				deps.wishlist.outOfStock(),
				isAdmin(ctx.principal),
			),
		})),

		action(ACTIONS.addForm, [], () => ({ form: addForm })),

		action(ACTIONS.add, [itemArg], async (ctx) => {
			const itemName = String(ctx.args.item || "").trim();
			if (!itemName) {
				return {
					reply: await onPanel(ctx.principal, () => ["⚠️ Please provide an item name."]),
				};
			}

			usable();
			const by = { ref: actorRef(ctx.principal), name: ctx.principal.displayName };
			const existingItem = deps.wishlist.find(itemName);
			const alreadyRequested = existingItem?.requesters.some((r) => r.ref === by.ref) ?? false;

			if (alreadyRequested && existingItem) {
				return {
					reply: await onPanel(ctx.principal, () => [
						`You've already requested **${escapeMarkdown(existingItem.name)}**.`,
					]),
				};
			}

			const item = deps.wishlist.request(itemName, by);
			const wasNew = !existingItem;

			ctx.logger.info(
				{
					event: wasNew ? "food.item_added" : "food.requester_added",
					item: item.name,
					...actorLogFields(ctx.principal),
				},
				wasNew ? "added an item to the food wishlist" : "joined a wishlist item request",
			);

			const message = wasNew
				? `✅ Added **${escapeMarkdown(item.name)}** to the wishlist.`
				: `✅ Added you to the request for **${escapeMarkdown(item.name)}**.`;

			return { reply: await onPanel(ctx.principal, () => [message]) };
		}),

		action(ACTIONS.removeForm, [], () => ({ form: removeForm })),

		action(ACTIONS.remove, [itemArg], async (ctx) => {
			const itemName = String(ctx.args.item || "").trim();
			if (!itemName) {
				return {
					reply: await onPanel(ctx.principal, () => ["⚠️ Please provide an item name."]),
				};
			}

			usable();
			const result = deps.wishlist.removeRequest(itemName, actorRef(ctx.principal));

			if (!result.removed) {
				throw new UserFacingError(`You haven't requested **${escapeMarkdown(itemName)}**.`);
			}

			ctx.logger.info(
				{
					event: result.itemRemains ? "food.requester_removed" : "food.item_removed",
					item: itemName,
					...actorLogFields(ctx.principal),
				},
				result.itemRemains
					? "removed themselves from a wishlist item"
					: "removed the last request for a wishlist item",
			);

			const message = result.itemRemains
				? `✅ Removed your request for **${escapeMarkdown(itemName)}**.`
				: `✅ Removed **${escapeMarkdown(itemName)}** from the wishlist (you were the last requester).`;

			return { reply: await onPanel(ctx.principal, () => [message]) };
		}),

		action(ACTIONS.removeAdminForm, [], () => ({ form: removeAdminForm })),

		action(ACTIONS.removeAdmin, [itemArg], async (ctx) => {
			if (!isAdmin(ctx.principal)) {
				throw new UserFacingError("Only admins can remove items.");
			}

			const itemName = String(ctx.args.item || "").trim();
			if (!itemName) {
				return {
					reply: await onPanel(ctx.principal, () => ["⚠️ Please provide an item name."]),
				};
			}

			usable();
			const removed = deps.wishlist.removeItem(itemName);

			if (!removed) {
				throw new UserFacingError(`**${escapeMarkdown(itemName)}** is not on the wishlist.`);
			}

			ctx.logger.info(
				{
					event: "food.item_removed_admin",
					item: itemName,
					...actorLogFields(ctx.principal),
				},
				"removed an item from the food wishlist (admin)",
			);

			return {
				reply: await onPanel(ctx.principal, () => [
					`✅ Removed **${escapeMarkdown(itemName)}** from the wishlist.`,
				]),
			};
		}),

		action(ACTIONS.outOfStockForm, [], () => ({ form: outOfStockForm })),

		action(ACTIONS.outOfStock, [itemArg], async (ctx) => {
			const itemName = String(ctx.args.item || "").trim();
			if (!itemName) {
				return {
					reply: await onPanel(ctx.principal, () => ["⚠️ Please provide an item name."]),
				};
			}

			usable();
			const by = { ref: actorRef(ctx.principal), name: ctx.principal.displayName };
			const item = deps.wishlist.reportOutOfStock(itemName, by, now());

			const wasNew =
				item.reportedBy.ref === by.ref && item.reportedAt.getTime() === now().getTime();

			if (wasNew) {
				ctx.logger.info(
					{
						event: "food.out_of_stock_reported",
						item: item.name,
						...actorLogFields(ctx.principal),
					},
					"reported an item out of stock",
				);

				// Send alert to admins if configured
				if (deps.poster && deps.alertChannelId) {
					await deps.poster.post(deps.alertChannelId, {
						kind: "message",
						text: `**${escapeMarkdown(item.name)}** has been reported out of stock by ${escapeMarkdown(by.name)}.`,
						mentions: false,
					});
				}
			}

			const message = wasNew
				? `✅ Reported **${escapeMarkdown(item.name)}** as out of stock.${
						deps.alertChannelId ? " Admins have been notified." : ""
					}`
				: `**${escapeMarkdown(item.name)}** has already been reported out of stock.`;

			return { reply: await onPanel(ctx.principal, () => [message]) };
		}),

		action(ACTIONS.clearStockForm, [], () => ({ form: clearStockForm })),

		action(ACTIONS.clearStock, [itemArg], async (ctx) => {
			if (!isAdmin(ctx.principal)) {
				throw new UserFacingError("Only admins can clear items from out of stock.");
			}

			const itemName = String(ctx.args.item || "").trim();
			if (!itemName) {
				return {
					reply: await onPanel(ctx.principal, () => ["⚠️ Please provide an item name."]),
				};
			}

			usable();
			const cleared = deps.wishlist.clearOutOfStock(itemName);

			if (!cleared) {
				throw new UserFacingError(
					`**${escapeMarkdown(itemName)}** is not on the out-of-stock list.`,
				);
			}

			ctx.logger.info(
				{
					event: "food.out_of_stock_cleared",
					item: itemName,
					...actorLogFields(ctx.principal),
				},
				"cleared an item from out of stock (admin)",
			);

			return {
				reply: await onPanel(ctx.principal, () => [
					`✅ Cleared **${escapeMarkdown(itemName)}** from the out-of-stock list.`,
				]),
			};
		}),
	];

	return {
		name: "food",
		commands: [food],
		actions,
	};
}
