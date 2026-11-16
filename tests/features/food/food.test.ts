import { describe, expect, it, vi } from "vitest";
import type { Principal } from "../../../src/core/access.ts";
import type { Args } from "../../../src/core/command.ts";
import { silentLogger } from "../../../src/core/logger.ts";
import type { Reply } from "../../../src/core/reply.ts";
import type { Control } from "../../../src/core/ui.ts";
import { createFoodFeature, FOOD_CAPABILITY } from "../../../src/features/food/index.ts";
import { FoodWishlistStore } from "../../../src/services/food-wishlist.ts";
import { IDS, plain, principal } from "../../../src/testing/fixtures.ts";

const NOW = new Date("2026-11-16T12:00:00Z");
const alice = principal("member", { userId: IDS.member, displayName: "Alice" }, ["food-wishlist"]);
const bob = principal("member", { userId: IDS.friend, displayName: "Bob" }, ["food-wishlist"]);
const admin = principal("admin", { userId: IDS.admin, displayName: "Admin" }, ["food-wishlist"]);

function setup(options: { alertChannelId?: string } = {}) {
	const wishlist = new FoodWishlistStore({ logger: silentLogger });
	const poster = {
		post: vi.fn(async () => ({ url: "http://example.com/msg/1", messageId: "1" })),
	};
	const feature = createFoodFeature({
		wishlist,
		poster,
		alertChannelId: options.alertChannelId,
		logger: silentLogger,
		now: () => NOW,
	});
	const food = plain(feature.commands?.[0]);

	const context = (args: Args, who: Principal) => ({
		args,
		users: {},
		channels: {},
		principal: who,
		logger: silentLogger,
		availableCommands: [],
	});

	const run = async (args: Args, who: Principal) => food.handler(context(args, who)) as Promise<Reply>;

	const act = (action: string, args: Args, who: Principal) => {
		const actionHandler = feature.actions?.find((a) => a.name === action);
		if (!actionHandler) throw new Error(`no action ${action}`);
		return actionHandler.handler(context(args, who));
	};

	return { wishlist, poster, feature, run, act };
}

const main = (reply: Reply) => reply.embeds?.[0]?.description ?? "";
const wishlistSection = (reply: Reply) => reply.embeds?.[1]?.description ?? "";
const outOfStockSection = (reply: Reply) => reply.embeds?.[2]?.description ?? "";
const controlsOf = (reply: Reply): Control[] => (reply.controls ?? []).flat();
const labels = (reply: Reply) =>
	controlsOf(reply).map((c) => (c.kind === "select" ? `[${c.placeholder}]` : c.label));

describe("/food", () => {
	it("declares the capability", () => {
		expect(FOOD_CAPABILITY.name).toBe("food-wishlist");
	});

	it("requires member tier and the capability", () => {
		const { feature } = setup();
		const food = feature.commands?.[0];
		expect(food?.access).toEqual({ minTier: "member", capability: "food-wishlist" });
	});

	it("shows an empty wishlist", async () => {
		const { run } = setup();
		const reply = await run({}, alice);

		expect(main(reply)).toContain("Add snacks");
		expect(wishlistSection(reply)).toBe("No items on the wishlist yet.");
		expect(reply.private).toBe(true);
	});

	it("shows member controls", async () => {
		const { run } = setup();
		const reply = await run({}, alice);

		expect(labels(reply)).toEqual([
			"Add item",
			"Remove my request",
			"Report out of stock",
			"Refresh",
		]);
	});

	it("shows admin controls", async () => {
		const { run } = setup();
		const reply = await run({}, admin);

		expect(labels(reply)).toEqual([
			"Add item",
			"Remove my request",
			"Report out of stock",
			"Remove any item",
			"Clear from out of stock",
			"Refresh",
		]);
	});

	it("hides out-of-stock section for members when empty", async () => {
		const { run } = setup();
		const reply = await run({}, alice);

		expect(reply.embeds).toHaveLength(2); // Title + Wishlist only
	});

	it("shows out-of-stock section for admins even when empty", async () => {
		const { run } = setup();
		const reply = await run({}, admin);

		expect(reply.embeds).toHaveLength(3); // Title + Wishlist + Out of Stock
		expect(outOfStockSection(reply)).toBe("Nothing reported out of stock.");
	});
});

describe("food.add", () => {
	it("adds a new item to the wishlist", async () => {
		const { act, wishlist } = setup();
		const result = await act("food.add", { item: "Club-Mate" }, alice);

		if (!("reply" in result)) throw new Error("Expected reply");
		expect(result.reply.embeds?.[0]?.description).toContain("Added **Club-Mate**");
		expect(wishlist.wishlist()).toHaveLength(1);
		expect(wishlist.find("Club-Mate")?.requesters).toEqual([
			{ ref: "discord:100000000000000001", name: "Alice" },
		]);
	});

	it("merges requests for the same item", async () => {
		const { act, wishlist } = setup();
		await act("food.add", { item: "Club-Mate" }, alice);
		const result = await act("food.add", { item: "club-mate" }, bob);

		if (!("reply" in result)) throw new Error("Expected reply");
		expect(result.reply.embeds?.[0]?.description).toContain("Added you to the request");
		expect(wishlist.wishlist()).toHaveLength(1);
		const item = wishlist.find("Club-Mate");
		expect(item?.requesters).toHaveLength(2);
	});

	it("doesn't duplicate when the same person requests twice", async () => {
		const { act, wishlist } = setup();
		await act("food.add", { item: "Club-Mate" }, alice);
		const result = await act("food.add", { item: "Club-Mate" }, alice);

		if (!("reply" in result)) throw new Error("Expected reply");
		expect(result.reply.embeds?.[0]?.description).toContain("already requested");
		expect(wishlist.wishlist()).toHaveLength(1);
		expect(wishlist.find("Club-Mate")?.requesters).toHaveLength(1);
	});

	it("displays the item in the wishlist", async () => {
		const { act, wishlist } = setup();
		await act("food.add", { item: "Club-Mate" }, alice);
		const item = wishlist.find("Club-Mate");

		expect(item?.name).toBe("Club-Mate");
		expect(item?.requesters[0]?.name).toBe("Alice");
	});
});

describe("food.remove", () => {
	it("removes the user's request", async () => {
		const { act, wishlist } = setup();
		wishlist.request("Club-Mate", { ref: "discord:100000000000000001", name: "Alice" });
		const result = await act("food.remove", { item: "Club-Mate" }, alice);

		if (!("reply" in result)) throw new Error("Expected reply");
		expect(result.reply.embeds?.[0]?.description).toContain("you were the last requester");
		expect(wishlist.wishlist()).toHaveLength(0);
	});

	it("removes one requester but keeps the item", async () => {
		const { act, wishlist } = setup();
		wishlist.request("Club-Mate", { ref: "discord:100000000000000001", name: "Alice" });
		wishlist.request("Club-Mate", { ref: "discord:100000000000000002", name: "Bob" });
		const result = await act("food.remove", { item: "Club-Mate" }, alice);

		if (!("reply" in result)) throw new Error("Expected reply");
		expect(result.reply.embeds?.[0]?.description).toContain("Removed your request");
		expect(wishlist.wishlist()).toHaveLength(1);
		expect(wishlist.find("Club-Mate")?.requesters).toHaveLength(1);
	});

	it("fails when the user hasn't requested the item", async () => {
		const { act, wishlist } = setup();
		wishlist.request("Club-Mate", { ref: "discord:100000000000000002", name: "Bob" });

		await expect(act("food.remove", { item: "Club-Mate" }, alice)).rejects.toThrow(
			"haven't requested",
		);
	});

	it("fails for unknown item", async () => {
		const { act } = setup();
		await expect(act("food.remove", { item: "Unknown" }, alice)).rejects.toThrow(
			"haven't requested",
		);
	});
});

describe("food.remove-admin", () => {
	it("admin removes any item", async () => {
		const { act, wishlist } = setup();
		wishlist.request("Club-Mate", { ref: "discord:100000000000000001", name: "Alice" });
		wishlist.request("Club-Mate", { ref: "discord:100000000000000002", name: "Bob" });
		const result = await act("food.remove-admin", { item: "Club-Mate" }, admin);

		if (!("reply" in result)) throw new Error("Expected reply");
		expect(result.reply.embeds?.[0]?.description).toContain("Removed **Club-Mate**");
		expect(wishlist.wishlist()).toHaveLength(0);
	});

	it("fails when non-admin tries to use it", async () => {
		const { act, wishlist } = setup();
		wishlist.request("Club-Mate", { ref: "discord:100000000000000002", name: "Bob" });

		await expect(act("food.remove-admin", { item: "Club-Mate" }, alice)).rejects.toThrow(
			"Only admins",
		);
	});

	it("fails for unknown item", async () => {
		const { act } = setup();
		await expect(act("food.remove-admin", { item: "Unknown" }, admin)).rejects.toThrow(
			"is not on the wishlist",
		);
	});
});

describe("food.out-of-stock", () => {
	it("reports an item out of stock", async () => {
		const { act, wishlist } = setup();
		const result = await act("food.out-of-stock", { item: "Club-Mate" }, alice);

		if (!("reply" in result)) throw new Error("Expected reply");
		expect(result.reply.embeds?.[0]?.description).toContain("Reported **Club-Mate** as out");
		expect(wishlist.outOfStock()).toHaveLength(1);
		expect(wishlist.outOfStock()[0]?.name).toBe("Club-Mate");
	});

	it("doesn't duplicate already-reported items", async () => {
		const { act, wishlist } = setup();
		await act("food.out-of-stock", { item: "Club-Mate" }, alice);
		const result = await act("food.out-of-stock", { item: "club-mate" }, bob);

		if (!("reply" in result)) throw new Error("Expected reply");
		expect(result.reply.embeds?.[0]?.description).toContain("already been reported");
		expect(wishlist.outOfStock()).toHaveLength(1);
	});

	it("posts an alert to admins when configured", async () => {
		const { act, poster } = setup({ alertChannelId: "123456789" });
		await act("food.out-of-stock", { item: "Club-Mate" }, alice);

		expect(poster.post).toHaveBeenCalledWith("123456789", {
			kind: "message",
			text: "**Club-Mate** has been reported out of stock by Alice.",
			mentions: false,
		});
	});

	it("doesn't post an alert when not configured", async () => {
		const { act, poster } = setup();
		await act("food.out-of-stock", { item: "Club-Mate" }, alice);

		expect(poster.post).not.toHaveBeenCalled();
	});

	it("mentions in the reply whether admins were notified", async () => {
		const { act } = setup({ alertChannelId: "123456789" });
		const result = await act("food.out-of-stock", { item: "Club-Mate" }, alice);

		if (!("reply" in result)) throw new Error("Expected reply");
		expect(result.reply.embeds?.[0]?.description).toContain("Admins have been notified");
	});
});

describe("food.clear-stock", () => {
	it("admin clears an item from out-of-stock", async () => {
		const { act, wishlist } = setup();
		wishlist.reportOutOfStock(
			"Club-Mate",
			{ ref: "discord:100000000000000001", name: "Alice" },
			NOW,
		);
		const result = await act("food.clear-stock", { item: "Club-Mate" }, admin);

		if (!("reply" in result)) throw new Error("Expected reply");
		expect(result.reply.embeds?.[0]?.description).toContain("Cleared **Club-Mate**");
		expect(wishlist.outOfStock()).toHaveLength(0);
	});

	it("fails when non-admin tries to use it", async () => {
		const { act, wishlist } = setup();
		wishlist.reportOutOfStock(
			"Club-Mate",
			{ ref: "discord:100000000000000001", name: "Alice" },
			NOW,
		);

		await expect(act("food.clear-stock", { item: "Club-Mate" }, alice)).rejects.toThrow(
			"Only admins",
		);
	});

	it("fails for unknown item", async () => {
		const { act } = setup();
		await expect(act("food.clear-stock", { item: "Unknown" }, admin)).rejects.toThrow(
			"is not on the out-of-stock list",
		);
	});
});

describe("wishlist display", () => {
	it("shows multiple items with requesters", async () => {
		const { run, wishlist } = setup();
		wishlist.request("Club-Mate", { ref: "discord:100000000000000001", name: "Alice" });
		wishlist.request("Club-Mate", { ref: "discord:100000000000000002", name: "Bob" });
		wishlist.request("Stroopwafels", { ref: "discord:100000000000000001", name: "Alice" });

		const reply = await run({}, alice);
		const content = wishlistSection(reply);

		expect(content).toContain("Club-Mate");
		expect(content).toContain("Alice");
		expect(content).toContain("Bob");
		expect(content).toContain("Stroopwafels");
	});

	it("shows out-of-stock items", async () => {
		const { run, wishlist } = setup();
		wishlist.reportOutOfStock(
			"Diet Coke",
			{ ref: "discord:100000000000000001", name: "Alice" },
			NOW,
		);

		const reply = await run({}, admin);
		const content = outOfStockSection(reply);

		expect(content).toContain("Diet Coke");
		expect(content).toContain("Alice");
	});
});
