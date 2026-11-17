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
	ChoiceOption,
	Control,
	ControlRow,
	Form,
} from "../../core/ui.ts";
import { UI_LIMITS } from "../../core/ui.ts";
import {
	type FoodWishlistStore,
	normalizeItemName,
	type OutOfStockItem,
	type WishlistItem,
} from "../../services/food-wishlist.ts";
import { findSimilar, findSoftMatch } from "./similar.ts";

export const FOOD_CAPABILITY: CapabilityDefinition = {
	name: "food-wishlist",
	description: "Manage the hackerspace's food wishlist",
};

const ACCESS = { minTier: "member" as const, capability: FOOD_CAPABILITY.name };

/** Items on one page of a select (Discord shows at most 25). */
export const PAGE_SIZE = UI_LIMITS.options;

/**
 * Discord select values are at most 100 characters. Item names are capped to
 * that so every entry can appear in a remove/restock/+1 menu (the value is the
 * normalized id).
 */
const MAX_ITEM_NAME = 100;

const ACTIONS = {
	home: "food.home",
	addForm: "food.add-form",
	add: "food.add",
	/** Add the typed name even when something similar is already on the list. */
	addNew: "food.add-new",
	join: "food.join",
	joinPick: "food.join-pick",
	removePick: "food.remove-pick",
	remove: "food.remove",
	removeAdminPick: "food.remove-admin-pick",
	removeAdmin: "food.remove-admin",
	outOfStockPick: "food.out-of-stock-pick",
	outOfStockForm: "food.out-of-stock-form",
	outOfStock: "food.out-of-stock",
	clearStockPick: "food.clear-stock-pick",
	clearStock: "food.clear-stock",
} as const;

export type FoodDeps = {
	wishlist: FoodWishlistStore;
	poster?: Pick<ChannelPosts, "post">;
	/** Optional channel ID for out-of-stock alerts to admins. Read fresh each alert. */
	alertChannelId?: () => string | undefined;
	logger: Logger;
	now?: () => Date;
};

const button = (
	label: string,
	action: string,
	args: Record<string, string | number> = {},
	style: "primary" | "secondary" | "success" | "danger" = "secondary",
	disabled = false,
): Control => ({
	kind: "button",
	label,
	style,
	call: { action, args },
	...(disabled ? { disabled: true } : {}),
});

function formatWishlistItems(items: readonly WishlistItem[]): string {
	if (items.length === 0) return "No items on the wishlist yet.";

	const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name, "en"));
	const lines = sorted.map((item) => {
		const requesters = item.requesters.map((r) => escapeMarkdown(r.name)).join(", ");
		return `• **${escapeMarkdown(item.name)}** (requested by ${requesters})`;
	});

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

function formatOutOfStockItems(
	items: readonly { name: string; reportedBy: { name: string } }[],
): string {
	if (items.length === 0) return "Nothing reported out of stock.";

	const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name, "en"));
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

function sortByName<T extends { name: string }>(items: readonly T[]): T[] {
	return [...items].sort((a, b) => a.name.localeCompare(b.name, "en"));
}

/** Options Discord can put in a select: value ≤ {@link MAX_ITEM_NAME}. */
function selectableWishlist(items: readonly WishlistItem[]): WishlistItem[] {
	return sortByName(items).filter((item) => item.id.length <= MAX_ITEM_NAME);
}

function selectableOutOfStock(items: readonly OutOfStockItem[]): OutOfStockItem[] {
	return sortByName(items).filter((item) => normalizeItemName(item.name).length <= MAX_ITEM_NAME);
}

function wishlistOption(item: WishlistItem, description?: string): ChoiceOption {
	return {
		label: item.name.slice(0, 100),
		value: item.id,
		...(description ? { description: description.slice(0, 100) } : {}),
	};
}

function outOfStockOption(item: OutOfStockItem): ChoiceOption {
	return {
		label: item.name.slice(0, 100),
		value: normalizeItemName(item.name),
		description: `Reported by ${item.reportedBy.name}`.slice(0, 100),
	};
}

function pageSlice<T>(
	items: readonly T[],
	page: number,
): { shown: T[]; current: number; pages: number } {
	const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
	const current = Math.min(Math.max(0, page), pages - 1);
	return {
		shown: items.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE),
		current,
		pages,
	};
}

function pagingRow(
	action: string,
	current: number,
	pages: number,
	extra: Record<string, string> = {},
): ControlRow {
	return [
		button("‹ Previous", action, { ...extra, page: current - 1 }, "secondary", current === 0),
		button("Next ›", action, { ...extra, page: current + 1 }, "secondary", current >= pages - 1),
	];
}

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
			maxLength: MAX_ITEM_NAME,
			placeholder: "e.g. Club-Mate, stroopwafels",
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
			description: "What has run out? Type a name if it isn't on the wishlist.",
			style: "short",
			maxLength: MAX_ITEM_NAME,
			required: true,
		},
	],
};

const itemArg: CommandOption = {
	name: "item",
	description: "Item name or id",
	type: "string",
	required: true,
};

const pageArg: CommandOption = {
	name: "page",
	description: "Which page",
	type: "integer",
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

	function createPanel(notice: string[], principal: Principal): Reply {
		const wishlist = deps.wishlist.wishlist();
		const outOfStock = deps.wishlist.outOfStock();
		const admin = isAdmin(principal);
		const ref = actorRef(principal);
		const joinable = selectableWishlist(
			wishlist.filter((item) => !item.requesters.some((r) => r.ref === ref)),
		);

		const embeds: Embed[] = [
			{
				title: "🛒 Food Wishlist",
				description:
					notice.length > 0
						? notice.join("\n")
						: "Add snacks and food you'd like the hackerspace to stock. Admins will buy items from the list. Pick an existing item to +1 it, or add a new name.",
				accent: "brand",
			},
			{
				title: "Wishlist",
				description: formatWishlistItems(wishlist),
				accent: "neutral",
			},
		];

		if (outOfStock.length > 0 || admin) {
			embeds.push({
				title: "Out of Stock",
				description: formatOutOfStockItems(outOfStock),
				accent: outOfStock.length > 0 ? "warning" : "neutral",
			});
		}

		const controls: ControlRow[] = [];
		if (joinable.length > 0) {
			const { shown, pages } = pageSlice(joinable, 0);
			controls.push([
				{
					kind: "select",
					placeholder: "+1 an existing item…",
					call: { action: ACTIONS.join },
					arg: "item",
					options: shown.map((item) =>
						wishlistOption(
							item,
							`${item.requesters.length} request${item.requesters.length === 1 ? "" : "s"}`,
						),
					),
				},
			]);
			if (pages > 1) {
				controls.push([button("More items to +1…", ACTIONS.joinPick, { page: 1 })]);
			}
		}

		controls.push([
			button("Add new item", ACTIONS.addForm, {}, "success"),
			button("Remove my request", ACTIONS.removePick),
			button("Report out of stock", ACTIONS.outOfStockPick),
		]);

		if (admin) {
			controls.push([
				button("Remove any item", ACTIONS.removeAdminPick, {}, "danger"),
				button("Clear from out of stock", ACTIONS.clearStockPick),
			]);
		}

		controls.push([button("Refresh", ACTIONS.home)]);

		return {
			embeds,
			private: true,
			controls,
		};
	}

	async function onPanel(
		principal: Principal,
		work: () => Promise<string[]> | string[],
	): Promise<Reply> {
		try {
			const notice = await work();
			return createPanel(notice, principal);
		} catch (error) {
			if (error instanceof UserFacingError) {
				return createPanel([`⚠️ ${error.message}`], principal);
			}
			throw error;
		}
	}

	/** Join an existing item by id (select value). */
	function joinItem(principal: Principal, itemId: string, logger: Logger): string {
		usable();
		const item = deps.wishlist.find(itemId);
		if (!item) {
			throw new UserFacingError("That item is no longer on the wishlist.");
		}
		const by = { ref: actorRef(principal), name: principal.displayName };
		const already = item.requesters.some((r) => r.ref === by.ref);
		if (already) {
			return `You've already requested **${escapeMarkdown(item.name)}**.`;
		}
		deps.wishlist.request(item.name, by);
		logger.info(
			{
				event: "food.requester_added",
				item: item.name,
				...actorLogFields(principal),
			},
			"joined a wishlist item request",
		);
		return `✅ Added you to the request for **${escapeMarkdown(item.name)}**.`;
	}

	function addItem(
		principal: Principal,
		itemName: string,
		logger: Logger,
		forceNew: boolean,
	): ActionResult {
		usable();
		const trimmed = itemName.trim();
		if (!trimmed) {
			return { reply: createPanel(["⚠️ Please provide an item name."], principal) };
		}
		if (trimmed.length > MAX_ITEM_NAME) {
			return {
				reply: createPanel([`⚠️ Item names can be at most ${MAX_ITEM_NAME} characters.`], principal),
			};
		}

		const by = { ref: actorRef(principal), name: principal.displayName };
		const wishlist = deps.wishlist.wishlist();
		const exact = deps.wishlist.find(trimmed);
		const soft = exact ? undefined : findSoftMatch(trimmed, wishlist);
		const target = exact ?? soft;

		if (target && !forceNew) {
			const already = target.requesters.some((r) => r.ref === by.ref);
			if (already) {
				return {
					reply: createPanel(
						[`You've already requested **${escapeMarkdown(target.name)}**.`],
						principal,
					),
				};
			}
			deps.wishlist.request(target.name, by);
			logger.info(
				{
					event: "food.requester_added",
					item: target.name,
					...actorLogFields(principal),
				},
				"joined a wishlist item request",
			);
			return {
				reply: createPanel(
					[`✅ Added you to the request for **${escapeMarkdown(target.name)}**.`],
					principal,
				),
			};
		}

		if (!forceNew) {
			const similar = findSimilar(trimmed, wishlist);
			if (similar.length > 0) {
				return { reply: similarPanel(principal, trimmed, similar) };
			}
		}

		const item = deps.wishlist.request(trimmed, by);
		logger.info(
			{
				event: "food.item_added",
				item: item.name,
				...actorLogFields(principal),
			},
			"added an item to the food wishlist",
		);
		return {
			reply: createPanel([`✅ Added **${escapeMarkdown(item.name)}** to the wishlist.`], principal),
		};
	}

	function similarPanel(
		principal: Principal,
		typed: string,
		similar: readonly WishlistItem[],
	): Reply {
		const ref = actorRef(principal);
		const joinable = selectableWishlist(
			similar.filter((item) => !item.requesters.some((r) => r.ref === ref)),
		);
		const mine = selectableWishlist(
			similar.filter((item) => item.requesters.some((r) => r.ref === ref)),
		);

		const controls: ControlRow[] = [];
		if (joinable.length > 0) {
			controls.push([
				{
					kind: "select",
					placeholder: "+1 a similar item…",
					call: { action: ACTIONS.join },
					arg: "item",
					options: joinable
						.slice(0, PAGE_SIZE)
						.map((item) =>
							wishlistOption(
								item,
								`${item.requesters.length} request${item.requesters.length === 1 ? "" : "s"}`,
							),
						),
				},
			]);
		}
		if (mine.length > 0) {
			controls.push([
				{
					kind: "select",
					placeholder: "-1 a similar item you've requested…",
					call: { action: ACTIONS.remove },
					arg: "item",
					options: mine.slice(0, PAGE_SIZE).map((item) => wishlistOption(item, "Your request")),
				},
			]);
		}
		controls.push([
			button("Add as new", ACTIONS.addNew, { item: typed }, "success"),
			button("Cancel", ACTIONS.home),
		]);

		const names = similar
			.slice(0, 5)
			.map((item) => `**${escapeMarkdown(item.name)}**`)
			.join(", ");
		const more = similar.length > 5 ? ` and ${similar.length - 5} more` : "";

		return {
			embeds: [
				{
					title: "🛒 Similar item on the list",
					description: [
						`**${escapeMarkdown(typed)}** looks like something already on the wishlist: ${names}${more}.`,
						"",
						"+1 an existing item, -1 one you've already requested, or add what you typed as a new entry.",
					].join("\n"),
					accent: "brand",
				},
			],
			private: true,
			controls,
		};
	}

	function joinPickPanel(principal: Principal, page = 0, notice?: string): Reply {
		const ref = actorRef(principal);
		const joinable = selectableWishlist(
			deps.wishlist.wishlist().filter((item) => !item.requesters.some((r) => r.ref === ref)),
		);
		if (joinable.length === 0) {
			return createPanel(
				[
					notice ??
						"There's nothing left to +1 — you've requested every item, or the list is empty.",
				],
				principal,
			);
		}
		const { shown, current, pages } = pageSlice(joinable, page);
		const controls: ControlRow[] = [
			[
				{
					kind: "select",
					placeholder: "+1 an existing item…",
					call: { action: ACTIONS.join },
					arg: "item",
					options: shown.map((item) =>
						wishlistOption(
							item,
							`${item.requesters.length} request${item.requesters.length === 1 ? "" : "s"}`,
						),
					),
				},
			],
		];
		if (pages > 1) controls.push(pagingRow(ACTIONS.joinPick, current, pages));
		controls.push([button("Back", ACTIONS.home)]);

		return {
			embeds: [
				{
					title: "🛒 +1 an existing item",
					description: [
						...(notice ? [notice, ""] : []),
						"Pick an item to add your name to its requesters.",
						...(pages > 1 ? [`Page ${current + 1} of ${pages}.`] : []),
					].join("\n"),
					accent: "brand",
				},
			],
			private: true,
			controls,
		};
	}

	function removePickPanel(principal: Principal, page = 0, notice?: string): Reply {
		const ref = actorRef(principal);
		const mine = selectableWishlist(
			deps.wishlist.wishlist().filter((item) => item.requesters.some((r) => r.ref === ref)),
		);
		if (mine.length === 0) {
			return createPanel([notice ?? "You haven't requested anything on the wishlist."], principal);
		}
		const { shown, current, pages } = pageSlice(mine, page);
		const controls: ControlRow[] = [
			[
				{
					kind: "select",
					placeholder: "Choose your request to remove…",
					call: { action: ACTIONS.remove },
					arg: "item",
					options: shown.map((item) =>
						wishlistOption(
							item,
							item.requesters.length === 1
								? "Removes the item (you're the last)"
								: `${item.requesters.length} requesters`,
						),
					),
				},
			],
		];
		if (pages > 1) controls.push(pagingRow(ACTIONS.removePick, current, pages));
		controls.push([button("Back", ACTIONS.home)]);

		return {
			embeds: [
				{
					title: "🛒 Remove my request",
					description: [
						...(notice ? [notice, ""] : []),
						"Pick an item to remove your request from. If you're the last requester, the item leaves the list.",
						...(pages > 1 ? [`Page ${current + 1} of ${pages}.`] : []),
					].join("\n"),
					accent: "brand",
				},
			],
			private: true,
			controls,
		};
	}

	function removeAdminPickPanel(principal: Principal, page = 0, notice?: string): Reply {
		if (!isAdmin(principal)) {
			throw new UserFacingError("Only admins can remove items.");
		}
		const all = selectableWishlist(deps.wishlist.wishlist());
		if (all.length === 0) {
			return createPanel([notice ?? "The wishlist is empty."], principal);
		}
		const { shown, current, pages } = pageSlice(all, page);
		const controls: ControlRow[] = [
			[
				{
					kind: "select",
					placeholder: "Choose an item to remove…",
					call: { action: ACTIONS.removeAdmin },
					arg: "item",
					options: shown.map((item) =>
						wishlistOption(
							item,
							`${item.requesters.length} request${item.requesters.length === 1 ? "" : "s"}`,
						),
					),
				},
			],
		];
		if (pages > 1) controls.push(pagingRow(ACTIONS.removeAdminPick, current, pages));
		controls.push([button("Back", ACTIONS.home)]);

		return {
			embeds: [
				{
					title: "🛒 Remove any item",
					description: [
						...(notice ? [notice, ""] : []),
						"Pick an item to remove from the wishlist for everyone.",
						...(pages > 1 ? [`Page ${current + 1} of ${pages}.`] : []),
					].join("\n"),
					accent: "negative",
				},
			],
			private: true,
			controls,
		};
	}

	function outOfStockPickPanel(_principal: Principal, page = 0, notice?: string): Reply {
		const all = selectableWishlist(deps.wishlist.wishlist());
		const { shown, current, pages } = pageSlice(all, page);
		const controls: ControlRow[] = [];
		if (shown.length > 0) {
			controls.push([
				{
					kind: "select",
					placeholder: "Choose a wishlist item…",
					call: { action: ACTIONS.outOfStock },
					arg: "item",
					options: shown.map((item) => wishlistOption(item)),
				},
			]);
		}
		if (pages > 1) controls.push(pagingRow(ACTIONS.outOfStockPick, current, pages));
		controls.push([
			button("Something else…", ACTIONS.outOfStockForm, {}, "primary"),
			button("Back", ACTIONS.home),
		]);

		return {
			embeds: [
				{
					title: "🛒 Report out of stock",
					description: [
						...(notice ? [notice, ""] : []),
						all.length > 0
							? "Pick a wishlist item that has run out, or type a different name."
							: "Nothing is on the wishlist yet. Type the name of what has run out.",
						...(pages > 1 ? [`Page ${current + 1} of ${pages}.`] : []),
					].join("\n"),
					accent: "brand",
				},
			],
			private: true,
			controls,
		};
	}

	function clearStockPickPanel(principal: Principal, page = 0, notice?: string): Reply {
		if (!isAdmin(principal)) {
			throw new UserFacingError("Only admins can clear items from out of stock.");
		}
		const all = selectableOutOfStock(deps.wishlist.outOfStock());
		if (all.length === 0) {
			return createPanel([notice ?? "Nothing is on the out-of-stock list."], principal);
		}
		const { shown, current, pages } = pageSlice(all, page);
		const controls: ControlRow[] = [
			[
				{
					kind: "select",
					placeholder: "Choose an item that was restocked…",
					call: { action: ACTIONS.clearStock },
					arg: "item",
					options: shown.map(outOfStockOption),
				},
			],
		];
		if (pages > 1) controls.push(pagingRow(ACTIONS.clearStockPick, current, pages));
		controls.push([button("Back", ACTIONS.home)]);

		return {
			embeds: [
				{
					title: "🛒 Clear from out of stock",
					description: [
						...(notice ? [notice, ""] : []),
						"Pick an item that has been restocked.",
						...(pages > 1 ? [`Page ${current + 1} of ${pages}.`] : []),
					].join("\n"),
					accent: "brand",
				},
			],
			private: true,
			controls,
		};
	}

	const food: PlainCommand = {
		name: "food",
		description: "Manage the hackerspace's food wishlist",
		access: ACCESS,
		private: true,
		handler: async ({ principal }) => createPanel([], principal),
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
			reply: createPanel([], ctx.principal),
		})),

		action(ACTIONS.addForm, [], () => ({ form: addForm })),

		action(ACTIONS.add, [itemArg], (ctx) =>
			addItem(ctx.principal, String(ctx.args.item || ""), ctx.logger, false),
		),

		action(ACTIONS.addNew, [itemArg], (ctx) =>
			addItem(ctx.principal, String(ctx.args.item || ""), ctx.logger, true),
		),

		action(ACTIONS.join, [itemArg], async (ctx) => {
			const itemId = String(ctx.args.item || "").trim();
			if (!itemId) {
				return { reply: await onPanel(ctx.principal, () => ["⚠️ Please choose an item."]) };
			}
			return {
				reply: await onPanel(ctx.principal, () => [joinItem(ctx.principal, itemId, ctx.logger)]),
			};
		}),

		action(ACTIONS.joinPick, [pageArg], (ctx) => ({
			reply: joinPickPanel(ctx.principal, Number(ctx.args.page ?? 0)),
		})),

		action(ACTIONS.removePick, [pageArg], (ctx) => ({
			reply: removePickPanel(ctx.principal, Number(ctx.args.page ?? 0)),
		})),

		action(ACTIONS.remove, [itemArg], async (ctx) => {
			const itemName = String(ctx.args.item || "").trim();
			if (!itemName) {
				return {
					reply: await onPanel(ctx.principal, () => ["⚠️ Please choose an item."]),
				};
			}

			usable();
			const existing = deps.wishlist.find(itemName);
			const display = existing?.name ?? itemName;
			const result = deps.wishlist.removeRequest(itemName, actorRef(ctx.principal));

			if (!result.removed) {
				throw new UserFacingError(`You haven't requested **${escapeMarkdown(display)}**.`);
			}

			ctx.logger.info(
				{
					event: result.itemRemains ? "food.requester_removed" : "food.item_removed",
					item: display,
					...actorLogFields(ctx.principal),
				},
				result.itemRemains
					? "removed themselves from a wishlist item"
					: "removed the last request for a wishlist item",
			);

			const message = result.itemRemains
				? `✅ Removed your request for **${escapeMarkdown(display)}**.`
				: `✅ Removed **${escapeMarkdown(display)}** from the wishlist (you were the last requester).`;

			return { reply: await onPanel(ctx.principal, () => [message]) };
		}),

		action(ACTIONS.removeAdminPick, [pageArg], (ctx) => ({
			reply: removeAdminPickPanel(ctx.principal, Number(ctx.args.page ?? 0)),
		})),

		action(ACTIONS.removeAdmin, [itemArg], async (ctx) => {
			if (!isAdmin(ctx.principal)) {
				throw new UserFacingError("Only admins can remove items.");
			}

			const itemName = String(ctx.args.item || "").trim();
			if (!itemName) {
				return {
					reply: await onPanel(ctx.principal, () => ["⚠️ Please choose an item."]),
				};
			}

			usable();
			const existing = deps.wishlist.find(itemName);
			if (!existing) {
				throw new UserFacingError(`**${escapeMarkdown(itemName)}** is not on the wishlist.`);
			}

			deps.wishlist.removeItem(itemName);
			ctx.logger.info(
				{
					event: "food.item_removed_admin",
					item: existing.name,
					...actorLogFields(ctx.principal),
				},
				"removed an item from the food wishlist (admin)",
			);

			return {
				reply: await onPanel(ctx.principal, () => [
					`✅ Removed **${escapeMarkdown(existing.name)}** from the wishlist.`,
				]),
			};
		}),

		action(ACTIONS.outOfStockPick, [pageArg], (ctx) => ({
			reply: outOfStockPickPanel(ctx.principal, Number(ctx.args.page ?? 0)),
		})),

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
			// Select values are normalized ids; prefer the wishlist display name when known.
			const fromWishlist = deps.wishlist.find(itemName);
			const reportName = fromWishlist?.name ?? itemName;
			if (!fromWishlist && reportName.length > MAX_ITEM_NAME) {
				return {
					reply: await onPanel(ctx.principal, () => [
						`⚠️ Item names can be at most ${MAX_ITEM_NAME} characters.`,
					]),
				};
			}
			const item = deps.wishlist.reportOutOfStock(reportName, by, now());

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

				const alertChannelId = deps.alertChannelId?.();
				if (deps.poster && alertChannelId) {
					await deps.poster.post(alertChannelId, {
						kind: "message",
						text: `**${escapeMarkdown(item.name)}** has been reported out of stock by ${escapeMarkdown(by.name)}.`,
						mentions: false,
					});
				}
			}

			const message = wasNew
				? `✅ Reported **${escapeMarkdown(item.name)}** as out of stock.${
						alertChannelId ? " Admins have been notified." : ""
					}`
				: `**${escapeMarkdown(item.name)}** has already been reported out of stock.`;

			return { reply: await onPanel(ctx.principal, () => [message]) };
		}),

		action(ACTIONS.clearStockPick, [pageArg], (ctx) => ({
			reply: clearStockPickPanel(ctx.principal, Number(ctx.args.page ?? 0)),
		})),

		action(ACTIONS.clearStock, [itemArg], async (ctx) => {
			if (!isAdmin(ctx.principal)) {
				throw new UserFacingError("Only admins can clear items from out of stock.");
			}

			const itemName = String(ctx.args.item || "").trim();
			if (!itemName) {
				return {
					reply: await onPanel(ctx.principal, () => ["⚠️ Please choose an item."]),
				};
			}

			usable();
			const existing = deps.wishlist
				.outOfStock()
				.find((item) => normalizeItemName(item.name) === normalizeItemName(itemName));
			const cleared = deps.wishlist.clearOutOfStock(itemName);

			if (!cleared || !existing) {
				throw new UserFacingError(
					`**${escapeMarkdown(itemName)}** is not on the out-of-stock list.`,
				);
			}

			ctx.logger.info(
				{
					event: "food.out_of_stock_cleared",
					item: existing.name,
					...actorLogFields(ctx.principal),
				},
				"cleared an item from out of stock (admin)",
			);

			return {
				reply: await onPanel(ctx.principal, () => [
					`✅ Cleared **${escapeMarkdown(existing.name)}** from the out-of-stock list.`,
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
