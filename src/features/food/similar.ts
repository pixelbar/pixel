import { normalizeItemName, type WishlistItem } from "../../services/food-wishlist.ts";

/**
 * Soften a name for similarity: turn common separators into spaces, then the
 * same normalize as exact matching. So "Club-Mate" and "Club Mate" compare
 * equal. Letters (including non-ASCII), digits and other symbols are kept, so
 * "Bärchen" ≠ "Bürchen" and "C++" ≠ "C#".
 */
export function softenItemName(name: string): string {
	return normalizeItemName(name.replace(/[-_./·]+/g, " "));
}

/** Levenshtein distance for short strings (snack names). */
function levenshtein(a: string, b: string): number {
	if (a === b) return 0;
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;
	const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	const curr = new Array<number>(b.length + 1);
	for (let i = 1; i <= a.length; i++) {
		curr[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
		}
		for (let j = 0; j <= b.length; j++) prev[j] = curr[j] ?? 0;
	}
	return prev[b.length] ?? 0;
}

/**
 * How alike two item names are, from 0 to 1. Soft-equal names score 1 even when
 * punctuation differs. Used to offer +1 on a close match instead of adding a near-duplicate.
 */
export function similarityScore(a: string, b: string): number {
	const sa = softenItemName(a);
	const sb = softenItemName(b);
	if (!sa || !sb) return 0;
	if (sa === sb) return 1;

	const shorter = sa.length <= sb.length ? sa : sb;
	const longer = sa.length <= sb.length ? sb : sa;
	if (shorter.length >= 4 && longer.includes(shorter)) {
		return shorter.length / longer.length;
	}

	const maxLen = Math.max(sa.length, sb.length);
	if (maxLen === 0 || maxLen > 64) return 0;
	return 1 - levenshtein(sa, sb) / maxLen;
}

export type SimilarOptions = {
	/** Inclusive floor; default 0.72. */
	minScore?: number;
	/** Cap on how many to return; default 10. */
	limit?: number;
	/**
	 * When true (default), skip an item whose normalized id equals the typed
	 * name — those are exact matches, handled separately.
	 */
	excludeExact?: boolean;
};

/**
 * Wishlist items that look like `typed`, best first. Soft-equal names (punctuation
 * only) score 1 and come first. Exact normalized matches are left out by default.
 */
export function findSimilar(
	typed: string,
	items: readonly WishlistItem[],
	options: SimilarOptions = {},
): WishlistItem[] {
	const minScore = options.minScore ?? 0.72;
	const limit = options.limit ?? 10;
	const excludeExact = options.excludeExact ?? true;
	const exact = normalizeItemName(typed);
	if (!exact) return [];

	return items
		.map((item) => ({ item, score: similarityScore(typed, item.name) }))
		.filter(({ item, score }) => score >= minScore && !(excludeExact && item.id === exact))
		.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name, "en"))
		.slice(0, limit)
		.map(({ item }) => item);
}

/**
 * The one wishlist item that matches after softening punctuation, if there is
 * exactly one. Used so "Club Mate" joins "Club-Mate" without a confirm step.
 */
export function findSoftMatch(
	typed: string,
	items: readonly WishlistItem[],
): WishlistItem | undefined {
	const soft = softenItemName(typed);
	if (!soft) return undefined;
	const matches = items.filter((item) => softenItemName(item.name) === soft);
	return matches.length === 1 ? matches[0] : undefined;
}
