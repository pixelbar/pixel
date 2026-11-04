import type { Wiki, WikiPage, WikiSearch } from "../services/wiki.ts";

/**
 * A wiki in memory, for feature tests. `search` matches whole words like
 * MediaWiki's default search, and a trailing `*` makes a word a prefix. Set
 * `failing` to make every call throw, as an unreachable wiki would.
 */
export class FakeWiki implements Wiki {
	readonly homeUrl = "https://wiki.example/";
	failing = false;
	topFailing = false;
	readonly searches: string[] = [];

	constructor(
		readonly pages: readonly WikiPage[] = [],
		readonly top: readonly WikiPage[] = [],
	) {}

	async search(query: string, limit: number): Promise<WikiSearch> {
		this.searches.push(query);
		if (this.failing) throw new Error("wiki down");
		const terms = query.toLowerCase().split(" ");
		const matches = this.pages.filter((page) => {
			const words = page.title.toLowerCase().split(/[^\p{L}\p{N}]+/u);
			return terms.every((term) =>
				term.endsWith("*")
					? words.some((word) => word.startsWith(term.slice(0, -1)))
					: words.includes(term),
			);
		});
		return { total: matches.length, pages: matches.slice(0, limit) };
	}

	async suggest(prefix: string, limit: number): Promise<string[]> {
		if (this.failing) throw new Error("wiki down");
		return this.pages
			.map((page) => page.title)
			.filter((title) => title.toLowerCase().startsWith(prefix.toLowerCase()))
			.slice(0, limit);
	}

	async topPages(): Promise<WikiPage[]> {
		if (this.failing || this.topFailing) throw new Error("wiki down");
		return [...this.top];
	}

	searchUrl(query: string): string {
		return `https://wiki.example/w/index.php?search=${encodeURIComponent(query)}`;
	}
}

/** A page on the fake wiki. */
export function wikiPage(title: string): WikiPage {
	return { title, url: `https://wiki.example/${encodeURIComponent(title.replace(/ /g, "_"))}` };
}
