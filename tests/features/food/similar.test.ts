import { describe, expect, it } from "vitest";
import {
	findSimilar,
	findSoftMatch,
	similarityScore,
	softenItemName,
} from "../../../src/features/food/similar.ts";
import type { WishlistItem } from "../../../src/services/food-wishlist.ts";

const item = (name: string, id = name.toLowerCase()): WishlistItem => ({
	id,
	name,
	requesters: [{ ref: "discord:1", name: "A" }],
});

describe("softenItemName", () => {
	it("strips punctuation to spaces and normalizes", () => {
		expect(softenItemName("Club-Mate")).toBe("club mate");
		expect(softenItemName("  Club   Mate!  ")).toBe("club mate");
	});
});

describe("similarityScore", () => {
	it("scores soft-equal names as 1", () => {
		expect(similarityScore("Club-Mate", "Club Mate")).toBe(1);
		expect(similarityScore("clubmate", "Club-Mate")).toBeGreaterThan(0.8);
	});

	it("scores close spellings highly", () => {
		expect(similarityScore("stroopwafel", "stroopwafels")).toBeGreaterThan(0.85);
	});

	it("scores unrelated names low", () => {
		expect(similarityScore("Club-Mate", "Diet Coke")).toBeLessThan(0.5);
	});
});

describe("findSoftMatch", () => {
	it("returns the one soft match", () => {
		const items = [item("Club-Mate", "club-mate"), item("Stroopwafels", "stroopwafels")];
		expect(findSoftMatch("Club Mate", items)?.name).toBe("Club-Mate");
	});

	it("returns undefined when nothing soft-matches", () => {
		expect(findSoftMatch("Mate", [item("Club-Mate", "club-mate")])).toBeUndefined();
	});
});

describe("findSimilar", () => {
	it("finds near-duplicates and skips exact normalized matches", () => {
		const items = [
			item("Club-Mate", "club-mate"),
			item("Club Mate Zero", "club mate zero"),
			item("Stroopwafels", "stroopwafels"),
		];
		const similar = findSimilar("club matee", items);
		expect(similar.map((i) => i.name)).toContain("Club-Mate");
		expect(similar.map((i) => i.name)).not.toContain("Stroopwafels");
	});

	it("excludes the exact id by default", () => {
		const items = [item("Club-Mate", "club-mate")];
		expect(findSimilar("club-mate", items)).toEqual([]);
	});

	it("can include the exact id when asked", () => {
		const items = [item("Club-Mate", "club-mate")];
		expect(findSimilar("club-mate", items, { excludeExact: false }).map((i) => i.name)).toEqual([
			"Club-Mate",
		]);
	});

	it("returns nothing for an empty typed name", () => {
		expect(findSimilar("   ", [item("Club-Mate", "club-mate")])).toEqual([]);
	});

	it("breaks ties by name", () => {
		const items = [item("Mate-B", "mate-b"), item("Mate-A", "mate-a")];
		const similar = findSimilar("Mate", items, { minScore: 0.4 });
		expect(similar.map((i) => i.name).slice(0, 2)).toEqual(["Mate-A", "Mate-B"]);
	});
});
