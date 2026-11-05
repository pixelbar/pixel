import { z } from "zod";

/**
 * Pixelbar's wiki (MediaWiki), read through its public API: full-text search,
 * title suggestions, and the pages its main page links to.
 *
 * Read-only and anonymous: Pixel never logs in or edits. Every answer is
 * untrusted input, so each request has a time limit, refuses redirects, caps
 * the response size and validates its shape. Pages keep only titles and URLs,
 * and a URL is used only when it is on the wiki's own origin, so a page can
 * never send people somewhere else through Pixel.
 */

export type WikiPage = {
	title: string;
	/** On the wiki's own origin, with `(` and `)` encoded so it is safe in a markdown link. */
	url: string;
};

export type WikiSearch = {
	/** How many pages match in total; `pages` holds at most the limit asked for. */
	total: number;
	pages: WikiPage[];
};

export type Wiki = {
	/** The wiki's front page. */
	readonly homeUrl: string;
	/** Full-text search of the wiki's articles, best matches first. */
	search(query: string, limit: number): Promise<WikiSearch>;
	/** Titles of articles that start with `prefix`, for autocomplete. */
	suggest(prefix: string, limit: number): Promise<string[]>;
	/** The pages the wiki's main page links to: what its editors put up front. Cached for a while. */
	topPages(): Promise<WikiPage[]>;
	/** The wiki's own search page for `query`, where every result is listed. */
	searchUrl(query: string): string;
};

export class WikiError extends Error {
	override name = "WikiError";
}

export type MediaWikiOptions = {
	/** The wiki's `api.php`, e.g. `https://wiki.pixelbar.nl/w/api.php`. */
	apiUrl: string;
	/** Sent with every request, as MediaWiki asks of bots. */
	userAgent: string;
	/** The page whose links are the top pages. Default `Main Page`. */
	mainPage?: string;
	fetch?: typeof globalThis.fetch;
	now?: () => number;
	timeoutMs?: number;
	/** Autocomplete has to answer within Discord's 3 seconds, so it gets less. */
	suggestTimeoutMs?: number;
	maxResponseBytes?: number;
	topPagesTtlMs?: number;
};

/** Main namespace only: articles, not talk, user or file pages. */
const ARTICLES = "0";
/** The most top pages Pixel keeps: plenty for buttons, and bounds what a busy main page costs. */
const MAX_TOP_PAGES = 25;
const MAX_TITLE_LENGTH = 255;
/** Discord refuses a link button whose URL is longer. */
const MAX_URL_LENGTH = 512;

const errorSchema = z.object({ error: z.object({ code: z.string() }) });

const pageSchema = z.object({
	title: z.string(),
	index: z.number().optional(),
	missing: z.boolean().optional(),
	invalid: z.boolean().optional(),
	fullurl: z.string().optional(),
});

const pagesSchema = z.object({
	query: z
		.object({
			searchinfo: z.object({ totalhits: z.number().int().min(0) }).optional(),
			pages: z.array(pageSchema).max(500).optional(),
			redirects: z
				.array(z.object({ from: z.string(), to: z.string() }))
				.max(500)
				.optional(),
		})
		.optional(),
});

const prefixSchema = z.object({
	query: z.object({ prefixsearch: z.array(z.object({ title: z.string() })).max(500) }).optional(),
});

export class MediaWiki implements Wiki {
	readonly homeUrl: string;
	readonly #api: URL;
	readonly #origin: string;
	readonly #userAgent: string;
	readonly #mainPage: string;
	readonly #fetch: typeof globalThis.fetch;
	readonly #now: () => number;
	readonly #timeoutMs: number;
	readonly #suggestTimeoutMs: number;
	readonly #maxResponseBytes: number;
	readonly #topPagesTtlMs: number;

	#top: { pages: WikiPage[]; at: number } | undefined;
	#topInFlight: Promise<WikiPage[]> | undefined;

	constructor(options: MediaWikiOptions) {
		this.#api = new URL(options.apiUrl);
		this.#origin = this.#api.origin;
		this.homeUrl = `${this.#origin}/`;
		this.#userAgent = options.userAgent;
		this.#mainPage = options.mainPage ?? "Main Page";
		this.#fetch = options.fetch ?? globalThis.fetch;
		this.#now = options.now ?? Date.now;
		this.#timeoutMs = options.timeoutMs ?? 5_000;
		this.#suggestTimeoutMs = options.suggestTimeoutMs ?? 2_000;
		this.#maxResponseBytes = options.maxResponseBytes ?? 256 * 1024;
		this.#topPagesTtlMs = options.topPagesTtlMs ?? 15 * 60_000;
	}

	async search(query: string, limit: number): Promise<WikiSearch> {
		const json = await this.#get(
			{
				action: "query",
				generator: "search",
				gsrsearch: query,
				gsrnamespace: ARTICLES,
				gsrlimit: String(limit),
				gsrinfo: "totalhits",
				gsrprop: "",
				prop: "info",
				inprop: "url",
			},
			this.#timeoutMs,
		);
		const parsed = pagesSchema.safeParse(json);
		if (!parsed.success) throw new WikiError("wiki search response has an unexpected shape");
		const found = [...(parsed.data.query?.pages ?? [])].sort(
			(a, b) => (a.index ?? Number.MAX_SAFE_INTEGER) - (b.index ?? Number.MAX_SAFE_INTEGER),
		);
		const pages = this.#usable(found).slice(0, limit);
		const total = Math.max(parsed.data.query?.searchinfo?.totalhits ?? 0, pages.length);
		return { total, pages };
	}

	async suggest(prefix: string, limit: number): Promise<string[]> {
		const json = await this.#get(
			{
				action: "query",
				list: "prefixsearch",
				pssearch: prefix,
				psnamespace: ARTICLES,
				pslimit: String(limit),
			},
			this.#suggestTimeoutMs,
		);
		const parsed = prefixSchema.safeParse(json);
		if (!parsed.success) throw new WikiError("wiki suggestions have an unexpected shape");
		return (parsed.data.query?.prefixsearch ?? [])
			.map((page) => cleanTitle(page.title))
			.filter((title) => title !== "")
			.slice(0, limit);
	}

	topPages(): Promise<WikiPage[]> {
		if (this.#top && this.#now() - this.#top.at < this.#topPagesTtlMs) {
			return Promise.resolve(this.#top.pages);
		}
		this.#topInFlight ??= this.#loadTopPages()
			.then((pages) => {
				this.#top = { pages, at: this.#now() };
				return pages;
			})
			.catch((error: unknown) => {
				// Better a list from a while ago than none while the wiki is down.
				if (this.#top) return this.#top.pages;
				throw error;
			})
			.finally(() => {
				this.#topInFlight = undefined;
			});
		return this.#topInFlight;
	}

	searchUrl(query: string): string {
		const url = new URL("index.php", this.#api);
		url.search = new URLSearchParams({
			title: "Special:Search",
			search: query,
			fulltext: "1",
		}).toString();
		return markdownSafe(url.href);
	}

	async #loadTopPages(): Promise<WikiPage[]> {
		const json = await this.#get(
			{
				action: "query",
				generator: "links",
				titles: this.#mainPage,
				gpllimit: "max",
				redirects: "1",
				prop: "info",
				inprop: "url",
			},
			this.#timeoutMs,
		);
		const parsed = pagesSchema.safeParse(json);
		if (!parsed.success) throw new WikiError("wiki main page links have an unexpected shape");
		const main = cleanTitle(this.#mainPage);
		// A link that redirects keeps the name the main page gives it ("Projects", not "Category:Projects").
		const linkedAs = new Map(
			(parsed.data.query?.redirects ?? []).map((r) => [cleanTitle(r.to), cleanTitle(r.from)]),
		);
		return this.#usable(parsed.data.query?.pages ?? [])
			.map((page) => ({ ...page, title: linkedAs.get(page.title) || page.title }))
			.filter((page) => page.title !== main)
			.sort((a, b) => a.title.localeCompare(b.title, "en"))
			.slice(0, MAX_TOP_PAGES);
	}

	/** Pages that exist, with a clean title and a URL on the wiki itself. Duplicates are dropped. */
	#usable(pages: readonly z.infer<typeof pageSchema>[]): WikiPage[] {
		const seen = new Set<string>();
		const out: WikiPage[] = [];
		for (const page of pages) {
			if (page.missing || page.invalid || page.fullurl === undefined) continue;
			const title = cleanTitle(page.title);
			const url = this.#ownUrl(page.fullurl);
			if (title === "" || url === undefined || seen.has(url)) continue;
			seen.add(url);
			out.push({ title, url });
		}
		return out;
	}

	#ownUrl(raw: string): string | undefined {
		let url: URL;
		try {
			url = new URL(raw);
		} catch {
			return undefined;
		}
		if (url.origin !== this.#origin || url.username !== "" || url.password !== "") return undefined;
		const href = markdownSafe(url.href);
		return href.length <= MAX_URL_LENGTH ? href : undefined;
	}

	async #get(params: Record<string, string>, timeoutMs: number): Promise<unknown> {
		const url = new URL(this.#api);
		url.search = new URLSearchParams({
			...params,
			format: "json",
			formatversion: "2",
			// Don't let a busy wiki keep Pixel waiting on replicas.
			maxlag: "5",
		}).toString();

		let response: Response;
		try {
			response = await this.#fetch(url, {
				signal: AbortSignal.timeout(timeoutMs),
				redirect: "error",
				headers: { accept: "application/json", "user-agent": this.#userAgent },
			});
		} catch (error) {
			throw new WikiError("wiki request failed", { cause: error });
		}
		if (!response.ok) throw new WikiError(`wiki responded with HTTP ${response.status}`);

		const declared = Number(response.headers.get("content-length"));
		if (declared > this.#maxResponseBytes) throw new WikiError("wiki response too large");
		const body = await response.text();
		if (body.length > this.#maxResponseBytes) throw new WikiError("wiki response too large");

		let json: unknown;
		try {
			json = JSON.parse(body);
		} catch {
			throw new WikiError("wiki returned invalid JSON");
		}
		const failed = errorSchema.safeParse(json);
		// Only the code: MediaWiki's message can repeat what was searched for.
		if (failed.success) throw new WikiError(`wiki API error: ${failed.data.error.code}`);
		return json;
	}
}

/** A title as plain text: no control or invisible characters, one line, not too long. */
function cleanTitle(title: string): string {
	return [
		...title
			.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ")
			.replace(/\s+/g, " ")
			.trim(),
	]
		.slice(0, MAX_TITLE_LENGTH)
		.join("");
}

/** Parentheses would end a markdown link early; MediaWiki reads the encoded ones the same. */
function markdownSafe(href: string): string {
	return href.replace(/\(/g, "%28").replace(/\)/g, "%29");
}
