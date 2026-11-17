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
});
