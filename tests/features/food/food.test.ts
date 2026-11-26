import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { actorRef, type Principal } from "../../../src/core/access.ts";
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
		alertChannelId: options.alertChannelId ? () => options.alertChannelId : undefined,
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

	const run = async (args: Args, who: Principal) =>
		food.handler(context(args, who)) as Promise<Reply>;

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
const select = (reply: Reply, placeholder: string) => {
	const found = controlsOf(reply).find(
		(c): c is Extract<Control, { kind: "select" }> =>
			c.kind === "select" && c.placeholder === placeholder,
	);
	if (!found) throw new Error(`no select ${placeholder}`);
	return found;
};

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
			"Add new item",
			"Remove my request",
			"Report out of stock",
			"Refresh",
		]);
	});

	it("shows a +1 select for items the member hasn't requested", async () => {
		const { run, wishlist } = setup();
		wishlist.request("Club-Mate", { ref: actorRef(bob), name: "Bob" });
		const reply = await run({}, alice);

		expect(labels(reply)[0]).toBe("[+1 an existing item…]");
		expect(select(reply, "+1 an existing item…").options.map((o) => o.value)).toEqual([
			"club-mate",
		]);
	});

	it("shows a single Admin tools entry for admins", async () => {
		const { run } = setup();
		const reply = await run({}, admin);

		expect(labels(reply)).toEqual([
			"Add new item",
			"Remove my request",
			"Report out of stock",
			"Admin tools…",
			"Refresh",
		]);
	});

	it("stages admin tools behind Wishlist and Out of stock panels", async () => {
		const { act } = setup();

		const tools = await act("food.admin-tools", {}, admin);
		if (!("reply" in tools)) throw new Error("Expected reply");
		expect(labels(tools.reply)).toEqual(["Wishlist…", "Out of stock…", "Back"]);

		const wishlist = await act("food.admin-wishlist", {}, admin);
		if (!("reply" in wishlist)) throw new Error("Expected reply");
		expect(labels(wishlist.reply)).toEqual([
			"Remove an item…",
			"Comments…",
			"Empty the wishlist…",
			"Back",
		]);

		const outOfStock = await act("food.admin-out-of-stock", {}, admin);
		if (!("reply" in outOfStock)) throw new Error("Expected reply");
		expect(labels(outOfStock.reply)).toEqual(["Clear an item…", "Empty the list…", "Back"]);
	});

	it("refuses admin tool panels for non-admins", async () => {
		const { act } = setup();

		await expect(async () => await act("food.admin-tools", {}, alice)).rejects.toThrow(
			"Only admins",
		);
		await expect(async () => await act("food.admin-wishlist", {}, alice)).rejects.toThrow(
			"Only admins",
		);
		await expect(async () => await act("food.admin-out-of-stock", {}, alice)).rejects.toThrow(
			"Only admins",
		);
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
			{ ref: actorRef(alice), name: "Alice" },
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

	it("joins a soft match without asking (punctuation only)", async () => {
		const { act, wishlist } = setup();
		wishlist.request("Club-Mate", { ref: actorRef(alice), name: "Alice" });
		const result = await act("food.add", { item: "Club Mate" }, bob);

		if (!("reply" in result)) throw new Error("Expected reply");
		expect(result.reply.embeds?.[0]?.description).toContain("Added you to the request");
		expect(wishlist.wishlist()).toHaveLength(1);
		expect(wishlist.find("Club-Mate")?.requesters).toHaveLength(2);
	});

	it("offers +1/-1 when the typed name is similar but not the same", async () => {
		const { act, wishlist } = setup();
		wishlist.request("Club-Mate", { ref: actorRef(alice), name: "Alice" });
		const result = await act("food.add", { item: "club matee" }, bob);

		if (!("reply" in result)) throw new Error("Expected reply");
		expect(main(result.reply)).toContain("looks like something already");
		expect(labels(result.reply)).toEqual(["[+1 a similar item…]", "Add as new", "Cancel"]);
		expect(wishlist.wishlist()).toHaveLength(1);
	});

	it("offers -1 on the similar panel when the caller already requested it", async () => {
		const { act, wishlist } = setup();
		wishlist.request("Club-Mate", { ref: actorRef(alice), name: "Alice" });
		const result = await act("food.add", { item: "club matee" }, alice);

		if (!("reply" in result)) throw new Error("Expected reply");
		expect(labels(result.reply)).toEqual([
			"[-1 a similar item you've requested…]",
			"Add as new",
			"Cancel",
		]);
	});

	it("adds as new when confirmed after a similar prompt", async () => {
		const { act, wishlist } = setup();
		wishlist.request("Club-Mate", { ref: actorRef(alice), name: "Alice" });
		const result = await act("food.add-new", { item: "club matee" }, bob);

		if (!("reply" in result)) throw new Error("Expected reply");
		expect(result.reply.embeds?.[0]?.description).toContain("Added **club matee**");
		expect(wishlist.wishlist()).toHaveLength(2);
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

describe("food.join", () => {
	it("+1s an existing item from a select without typing", async () => {
		const { act, wishlist } = setup();
		wishlist.request("Club-Mate", { ref: actorRef(alice), name: "Alice" });
		const result = await act("food.join", { item: "club-mate" }, bob);

		if (!("reply" in result)) throw new Error("Expected reply");
		expect(result.reply.embeds?.[0]?.description).toContain("Added you to the request");
		expect(wishlist.find("Club-Mate")?.requesters).toHaveLength(2);
	});
});

describe("food.remove", () => {
	it("opens a select of the caller's requests", async () => {
		const { act, wishlist } = setup();
		wishlist.request("Club-Mate", { ref: actorRef(alice), name: "Alice" });
		wishlist.request("Stroopwafels", { ref: actorRef(bob), name: "Bob" });
		const result = await act("food.remove-pick", {}, alice);

		if (!("reply" in result)) throw new Error("Expected reply");
		expect(result.reply.embeds?.[0]?.title).toContain("Remove my request");
		expect(
			select(result.reply, "Choose your request to remove…").options.map((o) => o.value),
		).toEqual(["club-mate"]);
	});

	it("removes the user's request", async () => {
		const { act, wishlist } = setup();
		wishlist.request("Club-Mate", { ref: actorRef(alice), name: "Alice" });
		const result = await act("food.remove", { item: "club-mate" }, alice);

		if (!("reply" in result)) throw new Error("Expected reply");
		expect(result.reply.embeds?.[0]?.description).toContain("you were the last requester");
		expect(wishlist.wishlist()).toHaveLength(0);
	});

	it("removes one requester but keeps the item", async () => {
		const { act, wishlist } = setup();
		wishlist.request("Club-Mate", { ref: actorRef(alice), name: "Alice" });
		wishlist.request("Club-Mate", { ref: actorRef(bob), name: "Bob" });
		const result = await act("food.remove", { item: "Club-Mate" }, alice);

		if (!("reply" in result)) throw new Error("Expected reply");
		expect(result.reply.embeds?.[0]?.description).toContain("Removed your request");
		expect(wishlist.wishlist()).toHaveLength(1);
		expect(wishlist.find("Club-Mate")?.requesters).toHaveLength(1);
	});

	it("fails when the user hasn't requested the item", async () => {
		const { act, wishlist } = setup();
		wishlist.request("Club-Mate", { ref: actorRef(bob), name: "Bob" });

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
	it("opens a select of every wishlist item", async () => {
		const { act, wishlist } = setup();
		wishlist.request("Club-Mate", { ref: actorRef(alice), name: "Alice" });
		const result = await act("food.remove-admin-pick", {}, admin);

		if (!("reply" in result)) throw new Error("Expected reply");
		expect(select(result.reply, "Choose an item to remove…").options.map((o) => o.label)).toEqual([
			"Club-Mate",
		]);
	});

	it("admin removes any item", async () => {
		const { act, wishlist } = setup();
		wishlist.request("Club-Mate", { ref: actorRef(alice), name: "Alice" });
		wishlist.request("Club-Mate", { ref: actorRef(bob), name: "Bob" });
		const result = await act("food.remove-admin", { item: "club-mate" }, admin);

		if (!("reply" in result)) throw new Error("Expected reply");
		expect(result.reply.embeds?.[0]?.description).toContain("Removed **Club-Mate**");
		expect(wishlist.wishlist()).toHaveLength(0);
	});

	it("fails when non-admin tries to use it", async () => {
		const { act, wishlist } = setup();
		wishlist.request("Club-Mate", { ref: actorRef(bob), name: "Bob" });

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
	it("opens a pick panel with wishlist items and a free-text option", async () => {
		const { act, wishlist } = setup();
		wishlist.request("Club-Mate", { ref: actorRef(alice), name: "Alice" });
		const result = await act("food.out-of-stock-pick", {}, alice);

		if (!("reply" in result)) throw new Error("Expected reply");
		expect(select(result.reply, "Choose a wishlist item…").options.map((o) => o.value)).toEqual([
			"club-mate",
		]);
		expect(labels(result.reply)).toContain("Something else…");
	});

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
	it("opens a select of out-of-stock items", async () => {
		const { act, wishlist } = setup();
		wishlist.reportOutOfStock(
			"Club-Mate",
			{ ref: "discord:100000000000000001", name: "Alice" },
			NOW,
		);
		const result = await act("food.clear-stock-pick", {}, admin);

		if (!("reply" in result)) throw new Error("Expected reply");
		expect(
			select(result.reply, "Choose an item that was restocked…").options.map((o) => o.value),
		).toEqual(["club-mate"]);
	});

	it("admin clears an item from out-of-stock", async () => {
		const { act, wishlist } = setup();
		wishlist.reportOutOfStock(
			"Club-Mate",
			{ ref: "discord:100000000000000001", name: "Alice" },
			NOW,
		);
		const result = await act("food.clear-stock", { item: "club-mate" }, admin);

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

	it("truncates a very long wishlist", async () => {
		const { run, wishlist } = setup();
		for (let i = 0; i < 80; i++) {
			wishlist.request(`Snack-${i}-${"x".repeat(60)}`, {
				ref: `discord:${100000000000000000 + i}`,
				name: `Person-${i}`,
			});
		}
		const reply = await run({}, alice);
		expect(wishlistSection(reply)).toContain("…and");
	});

	it("truncates a very long out-of-stock list", async () => {
		const { run, wishlist } = setup();
		for (let i = 0; i < 80; i++) {
			wishlist.reportOutOfStock(
				`Snack-${i}-${"y".repeat(60)}`,
				{ ref: `discord:${100000000000000000 + i}`, name: `Person-${i}` },
				NOW,
			);
		}
		const reply = await run({}, admin);
		expect(outOfStockSection(reply)).toContain("…and");
	});
});

describe("pick panels and edge cases", () => {
	it("refreshes from food.home", async () => {
		const { act } = setup();
		const result = await act("food.home", {}, alice);
		if (!("reply" in result)) throw new Error("Expected reply");
		expect(result.reply.embeds?.[0]?.title).toContain("Food Wishlist");
	});

	it("opens the add form", async () => {
		const { act } = setup();
		const result = await act("food.add-form", {}, alice);
		expect("form" in result).toBe(true);
	});

	it("opens the out-of-stock free-text form", async () => {
		const { act } = setup();
		const result = await act("food.out-of-stock-form", {}, alice);
		expect("form" in result).toBe(true);
	});

	it("refuses an empty add", async () => {
		const { act } = setup();
		const result = await act("food.add", { item: "   " }, alice);
		if (!("reply" in result)) throw new Error("Expected reply");
		expect(main(result.reply)).toContain("Please provide an item name");
	});

	it("opens the join pick panel", async () => {
		const { act, wishlist } = setup();
		wishlist.request("Club-Mate", { ref: actorRef(alice), name: "Alice" });
		const result = await act("food.join-pick", {}, bob);
		if (!("reply" in result)) throw new Error("Expected reply");
		expect(result.reply.embeds?.[0]?.title).toContain("+1 an existing item");
		expect(select(result.reply, "+1 an existing item…").options).toHaveLength(1);
	});

	it("join pick falls back when nothing is joinable", async () => {
		const { act } = setup();
		const result = await act("food.join-pick", {}, alice);
		if (!("reply" in result)) throw new Error("Expected reply");
		expect(main(result.reply)).toContain("nothing left to +1");
	});

	it("pages the join pick panel", async () => {
		const { act, wishlist } = setup();
		for (let i = 0; i < 26; i++) {
			wishlist.request(`Item-${String(i).padStart(2, "0")}`, {
				ref: actorRef(alice),
				name: "Alice",
			});
		}
		const page0 = await act("food.join-pick", { page: 0 }, bob);
		const page1 = await act("food.join-pick", { page: 1 }, bob);
		if (!("reply" in page0) || !("reply" in page1)) throw new Error("Expected reply");
		expect(main(page0.reply)).toContain("Page 1 of 2");
		expect(main(page1.reply)).toContain("Page 2 of 2");
		expect(select(page0.reply, "+1 an existing item…").options).toHaveLength(25);
		expect(select(page1.reply, "+1 an existing item…").options).toHaveLength(1);
	});

	it("shows More items on the home panel when joinable exceeds a page", async () => {
		const { run, wishlist } = setup();
		for (let i = 0; i < 26; i++) {
			wishlist.request(`Item-${String(i).padStart(2, "0")}`, {
				ref: actorRef(alice),
				name: "Alice",
			});
		}
		const reply = await run({}, bob);
		expect(labels(reply)).toContain("More items to +1…");
	});

	it("remove-pick says so when the caller has no requests", async () => {
		const { act } = setup();
		const result = await act("food.remove-pick", {}, alice);
		if (!("reply" in result)) throw new Error("Expected reply");
		expect(main(result.reply)).toContain("haven't requested anything");
	});

	it("remove-admin-pick refuses non-admins", async () => {
		const { act } = setup();
		await expect(act("food.remove-admin-pick", {}, alice)).rejects.toThrow("Only admins");
	});

	it("remove-admin-pick says so when the wishlist is empty", async () => {
		const { act } = setup();
		const result = await act("food.remove-admin-pick", {}, admin);
		if (!("reply" in result)) throw new Error("Expected reply");
		expect(main(result.reply)).toContain("wishlist is empty");
	});

	it("clear-stock-pick refuses non-admins", async () => {
		const { act } = setup();
		await expect(act("food.clear-stock-pick", {}, alice)).rejects.toThrow("Only admins");
	});

	it("clear-stock-pick says so when nothing is out of stock", async () => {
		const { act } = setup();
		const result = await act("food.clear-stock-pick", {}, admin);
		if (!("reply" in result)) throw new Error("Expected reply");
		expect(main(result.reply)).toContain("Nothing is on the out-of-stock list");
	});

	it("join refuses a missing item on the panel", async () => {
		const { act } = setup();
		const result = await act("food.join", { item: "gone" }, alice);
		if (!("reply" in result)) throw new Error("Expected reply");
		expect(main(result.reply)).toContain("no longer on the wishlist");
	});

	it("join says when already requested", async () => {
		const { act, wishlist } = setup();
		wishlist.request("Club-Mate", { ref: actorRef(alice), name: "Alice" });
		const result = await act("food.join", { item: "club-mate" }, alice);
		if (!("reply" in result)) throw new Error("Expected reply");
		expect(main(result.reply)).toContain("already requested");
	});

	it("join refuses an empty choice", async () => {
		const { act } = setup();
		const result = await act("food.join", { item: "" }, alice);
		if (!("reply" in result)) throw new Error("Expected reply");
		expect(main(result.reply)).toContain("Please choose an item");
	});

	it("remove refuses an empty choice", async () => {
		const { act } = setup();
		const result = await act("food.remove", { item: "" }, alice);
		if (!("reply" in result)) throw new Error("Expected reply");
		expect(main(result.reply)).toContain("Please choose an item");
	});

	it("remove-admin refuses an empty choice", async () => {
		const { act } = setup();
		const result = await act("food.remove-admin", { item: "" }, admin);
		if (!("reply" in result)) throw new Error("Expected reply");
		expect(main(result.reply)).toContain("Please choose an item");
	});

	it("clear-stock refuses an empty choice", async () => {
		const { act } = setup();
		const result = await act("food.clear-stock", { item: "" }, admin);
		if (!("reply" in result)) throw new Error("Expected reply");
		expect(main(result.reply)).toContain("Please choose an item");
	});

	it("out-of-stock refuses an empty name", async () => {
		const { act } = setup();
		const result = await act("food.out-of-stock", { item: "" }, alice);
		if (!("reply" in result)) throw new Error("Expected reply");
		expect(main(result.reply)).toContain("Please provide an item name");
	});

	it("reports out of stock from a wishlist select value", async () => {
		const { act, wishlist } = setup();
		wishlist.request("Club-Mate", { ref: actorRef(alice), name: "Alice" });
		const result = await act("food.out-of-stock", { item: "club-mate" }, bob);
		if (!("reply" in result)) throw new Error("Expected reply");
		expect(main(result.reply)).toContain("Reported **Club-Mate**");
		expect(wishlist.outOfStock()[0]?.name).toBe("Club-Mate");
	});

	it("out-of-stock pick with an empty wishlist still offers free text", async () => {
		const { act } = setup();
		const result = await act("food.out-of-stock-pick", {}, alice);
		if (!("reply" in result)) throw new Error("Expected reply");
		expect(main(result.reply)).toContain("Nothing is on the wishlist yet");
		expect(labels(result.reply)).toContain("Something else…");
	});

	it("pages remove-pick when the caller has many requests", async () => {
		const { act, wishlist } = setup();
		for (let i = 0; i < 26; i++) {
			wishlist.request(`Item-${String(i).padStart(2, "0")}`, {
				ref: actorRef(alice),
				name: "Alice",
			});
		}
		const result = await act("food.remove-pick", { page: 1 }, alice);
		if (!("reply" in result)) throw new Error("Expected reply");
		expect(main(result.reply)).toContain("Page 2 of 2");
	});

	it("pages admin remove and clear-stock picks", async () => {
		const { act, wishlist } = setup();
		for (let i = 0; i < 26; i++) {
			wishlist.request(`Item-${String(i).padStart(2, "0")}`, {
				ref: actorRef(alice),
				name: "Alice",
			});
			wishlist.reportOutOfStock(
				`Oos-${String(i).padStart(2, "0")}`,
				{ ref: actorRef(alice), name: "Alice" },
				NOW,
			);
		}
		const remove = await act("food.remove-admin-pick", { page: 1 }, admin);
		const clear = await act("food.clear-stock-pick", { page: 1 }, admin);
		if (!("reply" in remove) || !("reply" in clear)) throw new Error("Expected reply");
		expect(main(remove.reply)).toContain("Page 2 of 2");
		expect(main(clear.reply)).toContain("Page 2 of 2");
	});

	it("pages out-of-stock pick", async () => {
		const { act, wishlist } = setup();
		for (let i = 0; i < 26; i++) {
			wishlist.request(`Item-${String(i).padStart(2, "0")}`, {
				ref: actorRef(alice),
				name: "Alice",
			});
		}
		const result = await act("food.out-of-stock-pick", { page: 1 }, bob);
		if (!("reply" in result)) throw new Error("Expected reply");
		expect(main(result.reply)).toContain("Page 2 of 2");
	});

	it("refuses changes when the wishlist file is broken", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pixel-food-"));
		const file = join(dir, "food-wishlist.yaml");
		writeFileSync(file, "wishlist: not-a-list\n");
		const wishlist = new FoodWishlistStore({ file, logger: silentLogger });
		expect(wishlist.problem).toBeTruthy();
		const feature = createFoodFeature({
			wishlist,
			logger: silentLogger,
			now: () => NOW,
		});
		const handler = feature.actions?.find((a) => a.name === "food.add")?.handler;
		if (!handler) throw new Error("missing food.add");
		await expect(
			handler({
				args: { item: "Club-Mate" },
				users: {},
				channels: {},
				principal: alice,
				logger: silentLogger,
			}),
		).rejects.toThrow("unavailable right now");
	});

	describe("empty lists", () => {
		it("empties the wishlist after confirmation", async () => {
			const { act, wishlist } = setup();
			wishlist.request("Club-Mate", { ref: actorRef(alice), name: "Alice" });
			wishlist.request("Stroopwafels", { ref: actorRef(bob), name: "Bob" });

			const confirm = await act("food.empty-wishlist-confirm", {}, admin);
			if (!("reply" in confirm)) throw new Error("Expected reply");
			expect(main(confirm.reply)).toContain("remove all 2 items");
			expect(main(confirm.reply)).toContain("cannot be undone");

			const result = await act("food.empty-wishlist", {}, admin);
			if (!("reply" in result)) throw new Error("Expected reply");
			expect(main(result.reply)).toContain("Emptied the wishlist");
			expect(wishlist.wishlist()).toHaveLength(0);
		});

		it("empty wishlist refuses non-admins", async () => {
			const { act } = setup();
			await expect(async () => await act("food.empty-wishlist", {}, alice)).rejects.toThrow(
				"Only admins",
			);
		});

		it("empties the out-of-stock list after confirmation", async () => {
			const { act, wishlist } = setup();
			wishlist.reportOutOfStock("Club-Mate", { ref: actorRef(alice), name: "Alice" }, NOW);
			wishlist.reportOutOfStock("Coke", { ref: actorRef(bob), name: "Bob" }, NOW);

			const confirm = await act("food.empty-out-of-stock-confirm", {}, admin);
			if (!("reply" in confirm)) throw new Error("Expected reply");
			expect(main(confirm.reply)).toContain("remove all 2 items");

			const result = await act("food.empty-out-of-stock", {}, admin);
			if (!("reply" in result)) throw new Error("Expected reply");
			expect(main(result.reply)).toContain("Emptied the out-of-stock list");
			expect(wishlist.outOfStock()).toHaveLength(0);
		});

		it("empty out-of-stock refuses non-admins", async () => {
			const { act } = setup();
			await expect(async () => await act("food.empty-out-of-stock", {}, alice)).rejects.toThrow(
				"Only admins",
			);
		});
	});

	describe("comments", () => {
		it("adds a comment to an item", async () => {
			const { act, wishlist } = setup();
			wishlist.request("Club-Mate", { ref: actorRef(alice), name: "Alice" });

			const addForm = await act("food.comments-add-form", { item: "Club-Mate" }, admin);
			if (!("form" in addForm)) throw new Error("Expected form");

			const result = await act(
				"food.comments-add",
				{ item: "Club-Mate", text: "Only from supplier X" },
				admin,
			);
			if (!("reply" in result)) throw new Error("Expected reply");
			expect(main(result.reply)).toContain("Comment added");

			const item = wishlist.find("Club-Mate");
			expect(item?.comments).toHaveLength(1);
			expect(item?.comments?.[0]?.text).toBe("Only from supplier X");
		});

		it("comments refuse non-admins", async () => {
			const { act, wishlist } = setup();
			wishlist.request("Club-Mate", { ref: actorRef(alice), name: "Alice" });

			await expect(async () => await act("food.comments-pick", {}, alice)).rejects.toThrow(
				"Only admins",
			);
			await expect(
				async () => await act("food.comments-add", { item: "Club-Mate", text: "test" }, alice),
			).rejects.toThrow("Only admins");
		});

		it("edits a comment", async () => {
			const { act, wishlist } = setup();
			wishlist.request("Club-Mate", { ref: actorRef(alice), name: "Alice" });
			wishlist.addComment(
				"Club-Mate",
				"Original text",
				{ ref: actorRef(admin), name: "Admin" },
				NOW,
			);

			const editForm = await act(
				"food.comments-edit-form",
				{ item: "Club-Mate", index: "0" },
				admin,
			);
			if (!("form" in editForm)) throw new Error("Expected form");

			const result = await act(
				"food.comments-edit",
				{ item: "Club-Mate", index: "0", text: "Updated text" },
				admin,
			);
			if (!("reply" in result)) throw new Error("Expected reply");
			expect(main(result.reply)).toContain("Comment edited");

			const item = wishlist.find("Club-Mate");
			expect(item?.comments?.[0]?.text).toBe("Updated text");
		});

		it("removes a comment", async () => {
			const { act, wishlist } = setup();
			wishlist.request("Club-Mate", { ref: actorRef(alice), name: "Alice" });
			wishlist.addComment("Club-Mate", "To remove", { ref: actorRef(admin), name: "Admin" }, NOW);

			const result = await act("food.comments-remove", { item: "Club-Mate", index: "0" }, admin);
			if (!("reply" in result)) throw new Error("Expected reply");
			expect(main(result.reply)).toContain("Comment removed");

			const item = wishlist.find("Club-Mate");
			expect(item?.comments).toBeUndefined();
		});

		it("shows comment count in picker", async () => {
			const { act, wishlist } = setup();
			wishlist.request("Club-Mate", { ref: actorRef(alice), name: "Alice" });
			wishlist.addComment("Club-Mate", "Comment 1", { ref: actorRef(admin), name: "Admin" }, NOW);
			wishlist.addComment("Club-Mate", "Comment 2", { ref: actorRef(admin), name: "Admin" }, NOW);

			const result = await act("food.comments-pick", {}, admin);
			if (!("reply" in result)) throw new Error("Expected reply");
			const chooseSelect = select(result.reply, "Choose an item…");
			expect(chooseSelect.options[0]?.description).toBe("2 comments");
		});

		it("limits comment selects to 25 options", async () => {
			const { act, wishlist } = setup();
			wishlist.request("Club-Mate", { ref: actorRef(alice), name: "Alice" });
			for (let i = 0; i < 30; i++) {
				wishlist.addComment(
					"Club-Mate",
					`Comment ${i}`,
					{ ref: actorRef(admin), name: "Admin" },
					NOW,
				);
			}

			const result = await act("food.comments-view", { item: "Club-Mate" }, admin);
			if (!("reply" in result)) throw new Error("Expected reply");
			expect(main(result.reply)).toContain("Showing 25 of 30 comments");
		});

		it("shows a compact comment count on the home panel for admins", async () => {
			const { run, wishlist } = setup();
			wishlist.request("Club-Mate", { ref: actorRef(alice), name: "Alice" });
			wishlist.addComment(
				"Club-Mate",
				"Important note",
				{ ref: actorRef(admin), name: "Admin" },
				NOW,
			);

			const result = await run({}, admin);
			expect(wishlistSection(result)).toContain("💬 1 comment");
			expect(wishlistSection(result)).not.toContain("Important note");
		});

		it("hides comment counts from members", async () => {
			const { run, wishlist } = setup();
			wishlist.request("Club-Mate", { ref: actorRef(alice), name: "Alice" });
			wishlist.addComment(
				"Club-Mate",
				"Important note",
				{ ref: actorRef(admin), name: "Admin" },
				NOW,
			);

			const result = await run({}, alice);
			expect(wishlistSection(result)).not.toContain("💬");
			expect(wishlistSection(result)).not.toContain("Important note");
		});

		it("refuses comment edit with invalid item/index", async () => {
			const { act, wishlist } = setup();
			wishlist.request("Club-Mate", { ref: actorRef(alice), name: "Alice" });

			await expect(
				async () =>
					await act(
						"food.comments-edit",
						{ item: "Club-Mate", index: "invalid", text: "New" },
						admin,
					),
			).rejects.toThrow("Invalid selection");
		});

		it("refuses comment remove for nonexistent item/index", async () => {
			const { act, wishlist } = setup();
			wishlist.request("Club-Mate", { ref: actorRef(alice), name: "Alice" });

			await expect(
				async () => await act("food.comments-remove", { item: "Club-Mate", index: "0" }, admin),
			).rejects.toThrow("no longer exists");
		});

		it("refuses comment edit for nonexistent comment", async () => {
			const { act, wishlist } = setup();
			wishlist.request("Club-Mate", { ref: actorRef(alice), name: "Alice" });
			wishlist.addComment("Club-Mate", "Original", { ref: actorRef(admin), name: "Admin" }, NOW);

			await expect(
				async () =>
					await act("food.comments-edit", { item: "Club-Mate", index: "5", text: "New" }, admin),
			).rejects.toThrow("no longer exists");
		});

		it("refuses comment edit with empty text", async () => {
			const { act, wishlist } = setup();
			wishlist.request("Club-Mate", { ref: actorRef(alice), name: "Alice" });
			wishlist.addComment("Club-Mate", "Original", { ref: actorRef(admin), name: "Admin" }, NOW);

			await expect(
				async () =>
					await act("food.comments-edit", { item: "Club-Mate", index: "0", text: "" }, admin),
			).rejects.toThrow("Please provide comment text");
		});

		it("refuses comment edit for non-admins", async () => {
			const { act, wishlist } = setup();
			wishlist.request("Club-Mate", { ref: actorRef(alice), name: "Alice" });
			wishlist.addComment("Club-Mate", "Original", { ref: actorRef(admin), name: "Admin" }, NOW);

			await expect(
				async () =>
					await act("food.comments-edit", { item: "Club-Mate", index: "0", text: "New" }, alice),
			).rejects.toThrow("Only admins");
		});

		it("refuses comment remove for non-admins", async () => {
			const { act, wishlist } = setup();
			wishlist.request("Club-Mate", { ref: actorRef(alice), name: "Alice" });
			wishlist.addComment("Club-Mate", "Original", { ref: actorRef(admin), name: "Admin" }, NOW);

			await expect(
				async () => await act("food.comments-remove", { item: "Club-Mate", index: "0" }, alice),
			).rejects.toThrow("Only admins");
		});

		it("refuses comment remove with invalid index", async () => {
			const { act, wishlist } = setup();
			wishlist.request("Club-Mate", { ref: actorRef(alice), name: "Alice" });

			await expect(
				async () => await act("food.comments-remove", { item: "Club-Mate", index: "bad" }, admin),
			).rejects.toThrow("Invalid selection");
		});

		it("refuses edit form for nonexistent item", async () => {
			const { act } = setup();

			await expect(
				async () => await act("food.comments-edit-form", { item: "Unknown", index: "0" }, admin),
			).rejects.toThrow("no longer exists");
		});

		it("refuses edit form for nonexistent comment index", async () => {
			const { act, wishlist } = setup();
			wishlist.request("Club-Mate", { ref: actorRef(alice), name: "Alice" });
			wishlist.addComment("Club-Mate", "Comment", { ref: actorRef(admin), name: "Admin" }, NOW);

			await expect(
				async () => await act("food.comments-edit-form", { item: "Club-Mate", index: "5" }, admin),
			).rejects.toThrow("no longer exists");
		});

		it("shows picker panel when viewing with no item selected", async () => {
			const { act, wishlist } = setup();
			wishlist.request("Club-Mate", { ref: actorRef(alice), name: "Alice" });

			const result = await act("food.comments-view", { item: "" }, admin);
			if (!("reply" in result)) throw new Error("Expected reply");
			expect(main(result.reply)).toContain("Please choose an item");
			expect(main(result.reply)).toContain("Pick an item to view");
		});

		it("refuses add form for missing item", async () => {
			const { act } = setup();

			await expect(
				async () => await act("food.comments-add-form", { item: "" }, admin),
			).rejects.toThrow("Please choose an item");
		});

		it("empty wishlist shows already empty message when empty", async () => {
			const { act } = setup();

			const result = await act("food.empty-wishlist-confirm", {}, admin);
			if (!("reply" in result)) throw new Error("Expected reply");
			expect(main(result.reply)).toContain("already empty");
		});

		it("empty out-of-stock shows already empty message when empty", async () => {
			const { act } = setup();

			const result = await act("food.empty-out-of-stock-confirm", {}, admin);
			if (!("reply" in result)) throw new Error("Expected reply");
			expect(main(result.reply)).toContain("already empty");
		});

		it("refuses comment add with text over 250 chars", async () => {
			const { act, wishlist } = setup();
			wishlist.request("Club-Mate", { ref: actorRef(alice), name: "Alice" });
			const longText = "a".repeat(251);

			await expect(
				async () => await act("food.comments-add", { item: "Club-Mate", text: longText }, admin),
			).rejects.toThrow("cannot exceed 250 characters");
		});

		it("refuses comment add with empty text", async () => {
			const { act, wishlist } = setup();
			wishlist.request("Club-Mate", { ref: actorRef(alice), name: "Alice" });

			await expect(
				async () => await act("food.comments-add", { item: "Club-Mate", text: "" }, admin),
			).rejects.toThrow("Please provide comment text");
		});

		it("refuses comment add for nonexistent item", async () => {
			const { act } = setup();

			await expect(
				async () => await act("food.comments-add", { item: "Unknown", text: "Note" }, admin),
			).rejects.toThrow("not on the wishlist");
		});

		it("refuses edit form with invalid selection", async () => {
			const { act, wishlist } = setup();
			wishlist.request("Club-Mate", { ref: actorRef(alice), name: "Alice" });

			await expect(
				async () => await act("food.comments-edit-form", { item: "", index: "bad" }, admin),
			).rejects.toThrow("Invalid selection");
		});

		it("refuses edit form for out of bounds index", async () => {
			const { act, wishlist } = setup();
			wishlist.request("Club-Mate", { ref: actorRef(alice), name: "Alice" });
			wishlist.addComment("Club-Mate", "Comment", { ref: actorRef(admin), name: "Admin" }, NOW);

			await expect(
				async () => await act("food.comments-edit-form", { item: "Club-Mate", index: "-1" }, admin),
			).rejects.toThrow("no longer exists");
		});
	});
});
