import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import type { Logger } from "../core/logger.ts";

/**
 * The food wishlist: snacks and food members would like the hackerspace to stock.
 * Kept in `data/food-wishlist.yaml` and changed through `/food`. Each item has a
 * name and who requested it. Safe to delete if you want to start fresh.
 */

export type WishlistItem = {
	/** Normalized lowercase item name for matching. */
	readonly id: string;
	/** The item name as shown to users. */
	readonly name: string;
	/** People who requested this item, by their platform ref ("discord:<id>") and display name. */
	readonly requesters: readonly { ref: string; name: string }[];
};

export type OutOfStockItem = {
	/** The item name. */
	readonly name: string;
	/** Who reported it out of stock. */
	readonly reportedBy: { ref: string; name: string };
	/** When it was reported. */
	readonly reportedAt: Date;
};

const requesterSchema = z.strictObject({
	ref: z.string().min(1).max(64),
	name: z.string().max(100),
});

const wishlistItemSchema = z.strictObject({
	id: z.string().min(1).max(200),
	name: z.string().min(1).max(200),
	requesters: z.array(requesterSchema).min(1).max(100),
});

const outOfStockSchema = z.strictObject({
	name: z.string().min(1).max(200),
	reportedBy: requesterSchema,
	reportedAt: z.iso.datetime(),
});

const fileSchema = z.strictObject({
	wishlist: z.array(wishlistItemSchema).max(500).optional(),
	outOfStock: z.array(outOfStockSchema).max(500).optional(),
});

const HEADER =
	"# Food wishlist for the hackerspace. Managed with /food; safe to delete to start fresh.\n";

/** Normalize an item name for matching: lowercase, trim, collapse whitespace. */
export function normalizeItemName(name: string): string {
	return name.toLowerCase().trim().replace(/\s+/g, " ");
}

export class FoodWishlistStore {
	readonly #file: string | undefined;
	readonly #logger: Logger;
	#wishlist: WishlistItem[] = [];
	#outOfStock: OutOfStockItem[] = [];
	/** Why the file can't be used, if it can't. */
	readonly problem: string | undefined;

	constructor(options: { file?: string; logger: Logger }) {
		this.#file = options.file;
		this.#logger = options.logger.child({ component: "food" });
		this.problem = this.#load();
	}

	/** All wishlist items. */
	wishlist(): readonly WishlistItem[] {
		return this.#wishlist;
	}

	/** All out-of-stock items. */
	outOfStock(): readonly OutOfStockItem[] {
		return this.#outOfStock;
	}

	/** Find a wishlist item by normalized name. */
	find(itemName: string): WishlistItem | undefined {
		const normalized = normalizeItemName(itemName);
		return this.#wishlist.find((item) => item.id === normalized);
	}

	/**
	 * Add or merge a request. If the item exists, adds the requester if they haven't
	 * already requested it. Returns the item after the change.
	 */
	request(itemName: string, by: { ref: string; name: string }): WishlistItem {
		this.#writable();
		const normalized = normalizeItemName(itemName);
		if (!normalized) throw new Error("item name cannot be empty");

		const existing = this.find(itemName);
		if (existing) {
			// Already requested by this person?
			if (existing.requesters.some((r) => r.ref === by.ref)) {
				return existing;
			}
			// Add them to the requesters
			const updated: WishlistItem = {
				...existing,
				requesters: [...existing.requesters, by],
			};
			this.#save(
				this.#wishlist.map((item) => (item.id === normalized ? updated : item)),
				this.#outOfStock,
			);
			return updated;
		}

		// New item
		const newItem: WishlistItem = {
			id: normalized,
			name: itemName.trim(),
			requesters: [by],
		};
		this.#save([...this.#wishlist, newItem], this.#outOfStock);
		return newItem;
	}

	/**
	 * Remove a requester from an item. If they're the last requester, removes the item
	 * entirely. Returns whether the item still exists.
	 */
	removeRequest(itemName: string, by: string): { removed: boolean; itemRemains: boolean } {
		this.#writable();
		const existing = this.find(itemName);
		if (!existing) return { removed: false, itemRemains: false };

		const hadRequester = existing.requesters.some((r) => r.ref === by);
		if (!hadRequester) return { removed: false, itemRemains: true };

		const remaining = existing.requesters.filter((r) => r.ref !== by);
		if (remaining.length === 0) {
			// Last requester: remove the item
			this.#save(
				this.#wishlist.filter((item) => item.id !== existing.id),
				this.#outOfStock,
			);
			return { removed: true, itemRemains: false };
		}

		// Update the requesters
		const updated: WishlistItem = { ...existing, requesters: remaining };
		this.#save(
			this.#wishlist.map((item) => (item.id === existing.id ? updated : item)),
			this.#outOfStock,
		);
		return { removed: true, itemRemains: true };
	}

	/**
	 * Remove an item entirely (admin action).
	 */
	removeItem(itemName: string): boolean {
		this.#writable();
		const existing = this.find(itemName);
		if (!existing) return false;

		this.#save(
			this.#wishlist.filter((item) => item.id !== existing.id),
			this.#outOfStock,
		);
		return true;
	}

	/**
	 * Report an item as out of stock.
	 */
	reportOutOfStock(itemName: string, by: { ref: string; name: string }, now: Date): OutOfStockItem {
		this.#writable();
		const trimmed = itemName.trim();
		if (!trimmed) throw new Error("item name cannot be empty");

		// Check if already reported
		const existing = this.#outOfStock.find(
			(item) => normalizeItemName(item.name) === normalizeItemName(trimmed),
		);
		if (existing) return existing;

		const newItem: OutOfStockItem = {
			name: trimmed,
			reportedBy: by,
			reportedAt: now,
		};
		this.#save(this.#wishlist, [...this.#outOfStock, newItem]);
		return newItem;
	}

	/**
	 * Clear an item from the out-of-stock list (admin action).
	 */
	clearOutOfStock(itemName: string): boolean {
		this.#writable();
		const normalized = normalizeItemName(itemName);
		const existing = this.#outOfStock.find((item) => normalizeItemName(item.name) === normalized);
		if (!existing) return false;

		this.#save(
			this.#wishlist,
			this.#outOfStock.filter((item) => normalizeItemName(item.name) !== normalized),
		);
		return true;
	}

	#writable(): void {
		if (this.problem) {
			throw new Error(
				"The food wishlist file is invalid, so it can't be changed until an admin fixes it. See the logs.",
			);
		}
	}

	#load(): string | undefined {
		if (!this.#file) return undefined;
		let source: string;
		try {
			source = readFileSync(this.#file, "utf8");
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return undefined;
			return this.#broken(`cannot read ${this.#file} (${code ?? "unknown error"})`);
		}
		let data: unknown;
		try {
			data = parse(source);
		} catch {
			return this.#broken(`${this.#file} is not valid YAML`);
		}
		const result = fileSchema.safeParse(data ?? {});
		if (!result.success) {
			const where = result.error.issues
				.slice(0, 5)
				.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
				.join("; ");
			return this.#broken(`${this.#file} is invalid: ${where}`);
		}
		this.#wishlist = result.data.wishlist ?? [];
		this.#outOfStock = (result.data.outOfStock ?? []).map((item) => ({
			...item,
			reportedAt: new Date(item.reportedAt),
		}));
		return undefined;
	}

	#broken(problem: string): string {
		this.#logger.error(
			{ event: "food.wishlist_unreadable" },
			`${problem}; the wishlist can't be changed until it's fixed`,
		);
		return problem;
	}

	#save(wishlist: WishlistItem[], outOfStock: OutOfStockItem[]): void {
		if (this.#file) {
			try {
				mkdirSync(dirname(this.#file), { recursive: true });
				const temp = `${this.#file}.tmp`;
				const data = {
					...(wishlist.length > 0 ? { wishlist } : {}),
					...(outOfStock.length > 0
						? {
								outOfStock: outOfStock.map((item) => ({
									...item,
									reportedAt: item.reportedAt.toISOString(),
								})),
							}
						: {}),
				};
				writeFileSync(temp, HEADER + stringify(data));
				renameSync(temp, this.#file);
			} catch (error) {
				this.#logger.error(
					{ event: "food.wishlist_save_failed", err: error },
					"couldn't save the food wishlist",
				);
				throw new Error("Couldn't save the food wishlist, so nothing was changed.");
			}
		}
		this.#wishlist = wishlist;
		this.#outOfStock = outOfStock;
	}
}
