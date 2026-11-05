import type { Suggestion } from "../../core/command.ts";
import { UserFacingError } from "../../core/errors.ts";
import type { Feature } from "../../core/feature.ts";
import { escapeMarkdown, inlineCode } from "../../core/format.ts";
import type { Logger } from "../../core/logger.ts";
import type { Reply } from "../../core/reply.ts";
import type { Control, ControlRow } from "../../core/ui.ts";
import { UI_LIMITS } from "../../core/ui.ts";
import type { Wiki, WikiPage, WikiSearch } from "../../services/wiki.ts";

export type WikiDeps = {
	wiki: Wiki;
	logger: Logger;
};

/** Results listed in the reply. The wiki's own search page has the rest. */
export const MAX_RESULTS = 10;
/** Two rows of top-page buttons, leaving a row for the wiki itself. */
export const MAX_TOP_BUTTONS = 2 * UI_LIMITS.buttonsPerRow;
export const MAX_QUERY_LENGTH = 100;
const MAX_SUGGESTIONS = 10;
/** Shown titles are cut here, to keep the list readable. */
const MAX_SHOWN_TITLE = 100;
/** Room for the list in an embed (4096), leaving plenty for the line above it. */
const MAX_LIST_LENGTH = 3800;
/** Button labels fit Discord's design guidance (about 38 characters without an emoji). */
const MAX_LABEL = 38;

/**
 * `/wiki [query:]`: searches Pixelbar's wiki. With a query, the matching pages,
 * publicly, so they can be shared in the conversation. Without one, or when
 * nothing matches, a private reply with buttons for the wiki's top pages (the
 * ones its main page links to).
 *
 * The wiki is public, so this is open to everyone. Titles are written by wiki
 * editors, so they're escaped before they go in a reply, and links only ever
 * point at the wiki itself (`services/wiki.ts` checks). What people search for
 * is never logged.
 */
export function createWikiFeature({ wiki, logger }: WikiDeps): Feature {
	const log = logger.child({ feature: "wiki" });

	/** Top-page buttons, or none when the wiki can't be read: the reply still works without them. */
	const topRows = async (): Promise<ControlRow[]> => {
		try {
			return linkRows((await wiki.topPages()).slice(0, MAX_TOP_BUTTONS));
		} catch (error) {
			log.warn(
				{ event: "wiki.top_pages_failed", err: error },
				"couldn't load the wiki's top pages",
			);
			return [];
		}
	};

	return {
		name: "wiki",
		commands: [
			{
				name: "wiki",
				description: "Search Pixelbar's wiki, or see its top pages",
				access: { minTier: "guest" },
				options: [
					{
						name: "query",
						description: "What to look for. Leave empty to see the top pages",
						type: "string",
						suggest: async ({ typed }): Promise<Suggestion[]> => {
							const prefix = typed.trim();
							if (prefix === "" || prefix.length > MAX_QUERY_LENGTH) return [];
							try {
								const titles = await wiki.suggest(prefix, MAX_SUGGESTIONS);
								return titles.map((title) => ({ name: title, value: title }));
							} catch (error) {
								// Every keystroke asks, so an outage would be reported over and over.
								log.debug({ event: "wiki.suggest_failed", err: error }, "no wiki suggestions");
								return [];
							}
						},
					},
				],
				handler: async ({ args }): Promise<Reply> => {
					const query = typeof args.query === "string" ? cleanQuery(args.query) : "";
					if (query === "") return home(wiki, await topRows());
					if ([...query].length > MAX_QUERY_LENGTH) {
						throw new UserFacingError(
							`That's a long search. Try a few words, at most ${MAX_QUERY_LENGTH} characters.`,
						);
					}

					let found: Searched;
					try {
						found = await searchWithPrefixes(wiki, query);
					} catch (error) {
						log.warn({ event: "wiki.search_failed", err: error }, "couldn't search the wiki");
						return unreachable(wiki);
					}
					log.info({ event: "wiki.searched", hits: found.total }, "searched the wiki");
					if (found.pages.length === 0) return nothingFound(wiki, query, await topRows());
					return results(wiki, query, found);
				},
			},
		],
	};
}

/** What the wiki found, and the query that found it (which links to the full results must use). */
type Searched = WikiSearch & { searched: string };

/**
 * The wiki's search only matches whole words, so "clean" doesn't find "cleaning".
 * When a plain search finds nothing, try again with every word as a prefix.
 */
async function searchWithPrefixes(wiki: Wiki, query: string): Promise<Searched> {
	const found = await wiki.search(query, MAX_RESULTS);
	if (found.pages.length > 0 || /[*"]/.test(query)) return { ...found, searched: query };
	const prefixes = query
		.split(" ")
		.map((word) => (/^[\p{L}\p{N}]/u.test(word) ? `${word}*` : word))
		.join(" ");
	if (prefixes === query) return { ...found, searched: query };
	return { ...(await wiki.search(prefixes, MAX_RESULTS)), searched: prefixes };
}

function cleanQuery(text: string): string {
	return text
		.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function home(wiki: Wiki, top: ControlRow[]): Reply {
	return {
		embeds: [
			{
				title: "📚 Pixelbar wiki",
				url: wiki.homeUrl,
				description: [
					"Search it with `/wiki query:`, for example `/wiki query:3d printer`.",
					top.length > 0
						? "Or open one of its top pages below."
						: "I couldn't load its top pages just now, but the wiki is a click away.",
				].join("\n\n"),
				accent: "brand",
			},
		],
		controls: [...top, [openWiki(wiki)]],
		private: true,
	};
}

/** `query` is what the person typed, shown as written; `found.searched` is what the wiki was asked. */
function results(wiki: Wiki, query: string, found: Searched): Reply {
	// Whole links only: a link cut off by the embed's limit would be broken.
	const lines: string[] = [];
	let length = 0;
	for (const page of found.pages) {
		const line = `- [${escapeMarkdown(cut(page.title, MAX_SHOWN_TITLE))}](${page.url})`;
		if (length + line.length + 1 > MAX_LIST_LENGTH) break;
		lines.push(line);
		length += line.length + 1;
	}
	const more = found.total > lines.length;
	const heading = `${count(found.total, "page")} on the wiki ${found.total === 1 ? "matches" : "match"} ${inlineCode(query, MAX_QUERY_LENGTH)}${more ? `. Here are the first ${lines.length}` : ""}:`;
	const allResults = wiki.searchUrl(found.searched);
	const row: Control[] = [];
	if (more) row.push({ kind: "link", label: `See all ${found.total} results`, url: allResults });
	row.push(openWiki(wiki));
	return {
		embeds: [
			{
				title: "📚 Wiki search",
				url: allResults,
				description: `${heading}\n\n${lines.join("\n")}`,
				accent: "brand",
			},
		],
		controls: [row],
	};
}

function nothingFound(wiki: Wiki, query: string, top: ControlRow[]): Reply {
	return {
		embeds: [
			{
				title: "📚 Nothing on the wiki",
				description: `No page on the wiki matches ${inlineCode(query, MAX_QUERY_LENGTH)}. Try other words${top.length > 0 ? ", or one of the top pages below" : ""}.`,
				accent: "neutral",
			},
		],
		controls: [...top, [openWiki(wiki)]],
		// Only useful to the person searching, so it doesn't clutter the channel.
		private: true,
	};
}

function unreachable(wiki: Wiki): Reply {
	return {
		embeds: [
			{
				title: "⚠️ Couldn't search the wiki",
				description: "The wiki isn't answering right now. Try again in a bit, or open it yourself.",
				accent: "warning",
			},
		],
		controls: [[openWiki(wiki)]],
		private: true,
	};
}

function openWiki(wiki: Wiki): Control {
	return { kind: "link", label: "Open the wiki", url: wiki.homeUrl };
}

/** Link buttons, five to a row. A link opens the page; it never runs anything in Pixel. */
function linkRows(pages: readonly WikiPage[]): ControlRow[] {
	const rows: ControlRow[] = [];
	for (let i = 0; i < pages.length; i += UI_LIMITS.buttonsPerRow) {
		rows.push(
			pages
				.slice(i, i + UI_LIMITS.buttonsPerRow)
				.map((page) => ({ kind: "link", label: cut(page.title, MAX_LABEL), url: page.url })),
		);
	}
	return rows;
}

function cut(text: string, max: number): string {
	const chars = [...text];
	return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

function count(n: number, noun: string): string {
	return `${n} ${n === 1 ? noun : `${noun}s`}`;
}
