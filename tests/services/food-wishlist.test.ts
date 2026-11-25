import { afterEach, describe, expect, it } from "vitest";
import { silentLogger } from "../../src/core/logger.ts";
import { FoodWishlistStore, normalizeItemName } from "../../src/services/food-wishlist.ts";

describe("normalizeItemName", () => {
	it("normalizes to lowercase", () => {
		expect(normalizeItemName("Club-Mate")).toBe("club-mate");
		expect(normalizeItemName("STROOPWAFELS")).toBe("stroopwafels");
	});

	it("trims whitespace", () => {
		expect(normalizeItemName("  club-mate  ")).toBe("club-mate");
	});

	it("collapses multiple spaces", () => {
		expect(normalizeItemName("club   mate")).toBe("club mate");
		expect(normalizeItemName("diet  coke")).toBe("diet coke");
	});

	it("handles mixed transformations", () => {
		expect(normalizeItemName("  Club   Mate  ")).toBe("club mate");
	});
});

describe("FoodWishlistStore", () => {
	const NOW = new Date("2026-11-16T12:00:00Z");
	const alice = { ref: "discord:100000000000000001", name: "Alice" };
	const bob = { ref: "discord:100000000000000002", name: "Bob" };
	const charlie = { ref: "discord:100000000000000003", name: "Charlie" };

	function setup() {
		return new FoodWishlistStore({ logger: silentLogger });
	}

	afterEach(() => {
		// Tests use in-memory stores; nothing to clean up
	});

	describe("request", () => {
		it("adds a new item", () => {
			const store = setup();
			const item = store.request("Club-Mate", alice);

			expect(item.name).toBe("Club-Mate");
			expect(item.requesters).toEqual([alice]);
			expect(store.wishlist()).toHaveLength(1);
		});

		it("merges requests for the same item (case insensitive)", () => {
			const store = setup();
			store.request("Club-Mate", alice);
			const item = store.request("club-mate", bob);

			expect(item.requesters).toHaveLength(2);
			expect(item.requesters).toEqual([alice, bob]);
			expect(store.wishlist()).toHaveLength(1);
		});

		it("merges requests with whitespace differences", () => {
			const store = setup();
			store.request("Diet Coke", alice);
			const item = store.request("  diet   coke  ", bob);

			expect(item.requesters).toHaveLength(2);
			expect(store.wishlist()).toHaveLength(1);
		});

		it("doesn't duplicate a requester", () => {
			const store = setup();
			store.request("Club-Mate", alice);
			const item = store.request("club-mate", alice);

			expect(item.requesters).toHaveLength(1);
			expect(item.requesters).toEqual([alice]);
		});

		it("preserves the original name from the first request", () => {
			const store = setup();
			store.request("Club-Mate", alice);
			const item = store.request("CLUB-MATE", bob);

			expect(item.name).toBe("Club-Mate");
		});

		it("throws for empty item name", () => {
			const store = setup();
			expect(() => store.request("", alice)).toThrow("item name cannot be empty");
			expect(() => store.request("   ", alice)).toThrow("item name cannot be empty");
		});
	});

	describe("find", () => {
		it("finds an item by exact match", () => {
			const store = setup();
			store.request("Club-Mate", alice);
			const found = store.find("Club-Mate");

			expect(found).toBeDefined();
			expect(found?.name).toBe("Club-Mate");
		});

		it("finds an item case-insensitively", () => {
			const store = setup();
			store.request("Club-Mate", alice);
			const found = store.find("club-mate");

			expect(found).toBeDefined();
			expect(found?.name).toBe("Club-Mate");
		});

		it("returns undefined for unknown item", () => {
			const store = setup();
			const found = store.find("Unknown Item");

			expect(found).toBeUndefined();
		});
	});

	describe("removeRequest", () => {
		it("removes the last requester and deletes the item", () => {
			const store = setup();
			store.request("Club-Mate", alice);
			const result = store.removeRequest("Club-Mate", alice.ref);

			expect(result).toEqual({ removed: true, itemRemains: false });
			expect(store.wishlist()).toHaveLength(0);
		});

		it("removes one requester and keeps the item", () => {
			const store = setup();
			store.request("Club-Mate", alice);
			store.request("Club-Mate", bob);
			const result = store.removeRequest("Club-Mate", alice.ref);

			expect(result).toEqual({ removed: true, itemRemains: true });
			const item = store.find("Club-Mate");
			expect(item?.requesters).toEqual([bob]);
			expect(store.wishlist()).toHaveLength(1);
		});

		it("returns false when removing someone who didn't request", () => {
			const store = setup();
			store.request("Club-Mate", alice);
			const result = store.removeRequest("Club-Mate", bob.ref);

			expect(result).toEqual({ removed: false, itemRemains: true });
			expect(store.wishlist()).toHaveLength(1);
		});

		it("returns false for unknown item", () => {
			const store = setup();
			const result = store.removeRequest("Unknown", alice.ref);

			expect(result).toEqual({ removed: false, itemRemains: false });
		});

		it("works case-insensitively", () => {
			const store = setup();
			store.request("Club-Mate", alice);
			const result = store.removeRequest("club-mate", alice.ref);

			expect(result).toEqual({ removed: true, itemRemains: false });
		});
	});

	describe("removeItem", () => {
		it("removes an item with all its requesters", () => {
			const store = setup();
			store.request("Club-Mate", alice);
			store.request("Club-Mate", bob);
			const removed = store.removeItem("Club-Mate");

			expect(removed).toBe(true);
			expect(store.wishlist()).toHaveLength(0);
		});

		it("returns false for unknown item", () => {
			const store = setup();
			const removed = store.removeItem("Unknown");

			expect(removed).toBe(false);
		});

		it("works case-insensitively", () => {
			const store = setup();
			store.request("Club-Mate", alice);
			const removed = store.removeItem("club-mate");

			expect(removed).toBe(true);
			expect(store.wishlist()).toHaveLength(0);
		});
	});

	describe("reportOutOfStock", () => {
		it("adds a new out-of-stock item", () => {
			const store = setup();
			const item = store.reportOutOfStock("Club-Mate", alice, NOW);

			expect(item.name).toBe("Club-Mate");
			expect(item.reportedBy).toEqual(alice);
			expect(item.reportedAt).toEqual(NOW);
			expect(store.outOfStock()).toHaveLength(1);
		});

		it("doesn't duplicate an already-reported item", () => {
			const store = setup();
			store.reportOutOfStock("Club-Mate", alice, NOW);
			const item = store.reportOutOfStock("club-mate", bob, new Date("2026-11-16T13:00:00Z"));

			expect(item.reportedBy).toEqual(alice);
			expect(item.reportedAt).toEqual(NOW);
			expect(store.outOfStock()).toHaveLength(1);
		});

		it("throws for empty item name", () => {
			const store = setup();
			expect(() => store.reportOutOfStock("", alice, NOW)).toThrow("item name cannot be empty");
		});
	});

	describe("clearOutOfStock", () => {
		it("removes an item from out-of-stock", () => {
			const store = setup();
			store.reportOutOfStock("Club-Mate", alice, NOW);
			const cleared = store.clearOutOfStock("Club-Mate");

			expect(cleared).toBe(true);
			expect(store.outOfStock()).toHaveLength(0);
		});

		it("returns false for unknown item", () => {
			const store = setup();
			const cleared = store.clearOutOfStock("Unknown");

			expect(cleared).toBe(false);
		});

		it("works case-insensitively", () => {
			const store = setup();
			store.reportOutOfStock("Club-Mate", alice, NOW);
			const cleared = store.clearOutOfStock("club-mate");

			expect(cleared).toBe(true);
			expect(store.outOfStock()).toHaveLength(0);
		});
	});

	describe("complex scenarios", () => {
		it("handles multiple items with multiple requesters", () => {
			const store = setup();
			store.request("Club-Mate", alice);
			store.request("Club-Mate", bob);
			store.request("Stroopwafels", alice);
			store.request("Diet Coke", charlie);

			expect(store.wishlist()).toHaveLength(3);

			const clubMate = store.find("Club-Mate");
			expect(clubMate?.requesters).toHaveLength(2);

			store.removeRequest("Club-Mate", alice.ref);
			expect(store.find("Club-Mate")?.requesters).toHaveLength(1);

			store.removeRequest("Stroopwafels", alice.ref);
			expect(store.wishlist()).toHaveLength(2);
		});

		it("keeps wishlist and out-of-stock separate", () => {
			const store = setup();
			store.request("Club-Mate", alice);
			store.reportOutOfStock("Diet Coke", bob, NOW);

			expect(store.wishlist()).toHaveLength(1);
			expect(store.outOfStock()).toHaveLength(1);

			store.clearOutOfStock("Diet Coke");
			expect(store.wishlist()).toHaveLength(1);
			expect(store.outOfStock()).toHaveLength(0);
		});
	});

	describe("emptyWishlist", () => {
		it("empties all items from the wishlist", () => {
			const store = setup();
			store.request("Club-Mate", alice);
			store.request("Stroopwafels", bob);
			store.request("Diet Coke", charlie);

			expect(store.wishlist()).toHaveLength(3);

			const emptied = store.emptyWishlist();

			expect(emptied).toBe(true);
			expect(store.wishlist()).toHaveLength(0);
		});

		it("returns false when wishlist is already empty", () => {
			const store = setup();

			const emptied = store.emptyWishlist();

			expect(emptied).toBe(false);
			expect(store.wishlist()).toHaveLength(0);
		});

		it("does not affect out-of-stock list", () => {
			const store = setup();
			store.request("Club-Mate", alice);
			store.reportOutOfStock("Diet Coke", bob, NOW);

			expect(store.wishlist()).toHaveLength(1);
			expect(store.outOfStock()).toHaveLength(1);

			store.emptyWishlist();

			expect(store.wishlist()).toHaveLength(0);
			expect(store.outOfStock()).toHaveLength(1);
		});
	});

	describe("emptyOutOfStock", () => {
		it("empties all items from the out-of-stock list", () => {
			const store = setup();
			store.reportOutOfStock("Club-Mate", alice, NOW);
			store.reportOutOfStock("Diet Coke", bob, NOW);
			store.reportOutOfStock("Stroopwafels", charlie, NOW);

			expect(store.outOfStock()).toHaveLength(3);

			const emptied = store.emptyOutOfStock();

			expect(emptied).toBe(true);
			expect(store.outOfStock()).toHaveLength(0);
		});

		it("returns false when out-of-stock list is already empty", () => {
			const store = setup();

			const emptied = store.emptyOutOfStock();

			expect(emptied).toBe(false);
			expect(store.outOfStock()).toHaveLength(0);
		});

		it("does not affect wishlist", () => {
			const store = setup();
			store.request("Club-Mate", alice);
			store.reportOutOfStock("Diet Coke", bob, NOW);

			expect(store.wishlist()).toHaveLength(1);
			expect(store.outOfStock()).toHaveLength(1);

			store.emptyOutOfStock();

			expect(store.wishlist()).toHaveLength(1);
			expect(store.outOfStock()).toHaveLength(0);
		});
	});

	describe("addComment", () => {
		it("adds a comment to an item", () => {
			const store = setup();
			store.request("Club-Mate", alice);

			const comment = store.addComment("Club-Mate", "Only from supplier X", bob, NOW);

			expect(comment.text).toBe("Only from supplier X");
			expect(comment.author).toEqual(bob);
			expect(comment.addedAt).toEqual(NOW);

			const item = store.find("Club-Mate");
			expect(item?.comments).toHaveLength(1);
			expect(item?.comments?.[0]).toEqual(comment);
		});

		it("adds multiple comments to an item", () => {
			const store = setup();
			store.request("Club-Mate", alice);

			store.addComment("Club-Mate", "First comment", alice, NOW);
			store.addComment("Club-Mate", "Second comment", bob, new Date(NOW.getTime() + 1000));

			const item = store.find("Club-Mate");
			expect(item?.comments).toHaveLength(2);
			expect(item?.comments?.[0].text).toBe("First comment");
			expect(item?.comments?.[1].text).toBe("Second comment");
		});

		it("trims comment text", () => {
			const store = setup();
			store.request("Club-Mate", alice);

			const comment = store.addComment("Club-Mate", "  trimmed  ", bob, NOW);

			expect(comment.text).toBe("trimmed");
		});

		it("throws when comment text is empty", () => {
			const store = setup();
			store.request("Club-Mate", alice);

			expect(() => store.addComment("Club-Mate", "", bob, NOW)).toThrow("cannot be empty");
			expect(() => store.addComment("Club-Mate", "   ", bob, NOW)).toThrow("cannot be empty");
		});

		it("throws when comment text exceeds 250 characters", () => {
			const store = setup();
			store.request("Club-Mate", alice);

			const longText = "a".repeat(251);

			expect(() => store.addComment("Club-Mate", longText, bob, NOW)).toThrow(
				"cannot exceed 250 characters",
			);
		});

		it("throws when item is not on the wishlist", () => {
			const store = setup();

			expect(() => store.addComment("Unknown", "comment", bob, NOW)).toThrow("not on the wishlist");
		});

		it("works case-insensitively", () => {
			const store = setup();
			store.request("Club-Mate", alice);

			store.addComment("club-mate", "comment", bob, NOW);

			const item = store.find("Club-Mate");
			expect(item?.comments).toHaveLength(1);
		});
	});

	describe("editComment", () => {
		it("edits a comment", () => {
			const store = setup();
			store.request("Club-Mate", alice);
			store.addComment("Club-Mate", "Original text", bob, NOW);

			const edited = store.editComment("Club-Mate", 0, "Updated text");

			expect(edited).toBe(true);
			const item = store.find("Club-Mate");
			expect(item?.comments?.[0].text).toBe("Updated text");
			expect(item?.comments?.[0].author).toEqual(bob);
			expect(item?.comments?.[0].addedAt).toEqual(NOW);
		});

		it("edits the correct comment when multiple exist", () => {
			const store = setup();
			store.request("Club-Mate", alice);
			store.addComment("Club-Mate", "First", alice, NOW);
			store.addComment("Club-Mate", "Second", bob, NOW);
			store.addComment("Club-Mate", "Third", charlie, NOW);

			store.editComment("Club-Mate", 1, "Updated second");

			const item = store.find("Club-Mate");
			expect(item?.comments?.[0].text).toBe("First");
			expect(item?.comments?.[1].text).toBe("Updated second");
			expect(item?.comments?.[2].text).toBe("Third");
		});

		it("trims comment text", () => {
			const store = setup();
			store.request("Club-Mate", alice);
			store.addComment("Club-Mate", "Original", bob, NOW);

			store.editComment("Club-Mate", 0, "  trimmed  ");

			const item = store.find("Club-Mate");
			expect(item?.comments?.[0].text).toBe("trimmed");
		});

		it("throws when comment text is empty", () => {
			const store = setup();
			store.request("Club-Mate", alice);
			store.addComment("Club-Mate", "Original", bob, NOW);

			expect(() => store.editComment("Club-Mate", 0, "")).toThrow("cannot be empty");
			expect(() => store.editComment("Club-Mate", 0, "   ")).toThrow("cannot be empty");
		});

		it("throws when comment text exceeds 250 characters", () => {
			const store = setup();
			store.request("Club-Mate", alice);
			store.addComment("Club-Mate", "Original", bob, NOW);

			const longText = "a".repeat(251);

			expect(() => store.editComment("Club-Mate", 0, longText)).toThrow(
				"cannot exceed 250 characters",
			);
		});

		it("returns false when item is not on the wishlist", () => {
			const store = setup();

			const edited = store.editComment("Unknown", 0, "text");

			expect(edited).toBe(false);
		});

		it("returns false when comment index is out of bounds", () => {
			const store = setup();
			store.request("Club-Mate", alice);
			store.addComment("Club-Mate", "Comment", bob, NOW);

			expect(store.editComment("Club-Mate", 1, "text")).toBe(false);
			expect(store.editComment("Club-Mate", -1, "text")).toBe(false);
		});

		it("returns false when item has no comments", () => {
			const store = setup();
			store.request("Club-Mate", alice);

			const edited = store.editComment("Club-Mate", 0, "text");

			expect(edited).toBe(false);
		});
	});

	describe("removeComment", () => {
		it("removes a comment", () => {
			const store = setup();
			store.request("Club-Mate", alice);
			store.addComment("Club-Mate", "Comment to remove", bob, NOW);

			const removed = store.removeComment("Club-Mate", 0);

			expect(removed).toBe(true);
			const item = store.find("Club-Mate");
			expect(item?.comments).toBeUndefined();
		});

		it("removes the correct comment when multiple exist", () => {
			const store = setup();
			store.request("Club-Mate", alice);
			store.addComment("Club-Mate", "First", alice, NOW);
			store.addComment("Club-Mate", "Second", bob, NOW);
			store.addComment("Club-Mate", "Third", charlie, NOW);

			store.removeComment("Club-Mate", 1);

			const item = store.find("Club-Mate");
			expect(item?.comments).toHaveLength(2);
			expect(item?.comments?.[0].text).toBe("First");
			expect(item?.comments?.[1].text).toBe("Third");
		});

		it("removes comments field when last comment is removed", () => {
			const store = setup();
			store.request("Club-Mate", alice);
			store.addComment("Club-Mate", "Only comment", bob, NOW);

			store.removeComment("Club-Mate", 0);

			const item = store.find("Club-Mate");
			expect(item?.comments).toBeUndefined();
		});

		it("returns false when item is not on the wishlist", () => {
			const store = setup();

			const removed = store.removeComment("Unknown", 0);

			expect(removed).toBe(false);
		});

		it("returns false when comment index is out of bounds", () => {
			const store = setup();
			store.request("Club-Mate", alice);
			store.addComment("Club-Mate", "Comment", bob, NOW);

			expect(store.removeComment("Club-Mate", 1)).toBe(false);
			expect(store.removeComment("Club-Mate", -1)).toBe(false);
		});

		it("returns false when item has no comments", () => {
			const store = setup();
			store.request("Club-Mate", alice);

			const removed = store.removeComment("Club-Mate", 0);

			expect(removed).toBe(false);
		});
	});
});
