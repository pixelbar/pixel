import { describe, expect, it, vi } from "vitest";
import { MediaWiki, type MediaWikiOptions, WikiError } from "../../src/services/wiki.ts";

const API = "https://wiki.example/w/api.php";

type Fetch = typeof globalThis.fetch;

const json = (body: unknown, init?: ResponseInit) =>
	vi.fn<Fetch>(async () => new Response(JSON.stringify(body), init));

function wiki(fetch: Fetch, extras: Partial<MediaWikiOptions> = {}) {
	return new MediaWiki({ apiUrl: API, userAgent: "Pixel/test", fetch, ...extras });
}

function sent(fetch: ReturnType<typeof vi.fn<Fetch>>, call = 0) {
	const [url, init] = fetch.mock.calls[call] ?? [];
	const parsed = new URL(String(url));
	return { url: parsed, params: Object.fromEntries(parsed.searchParams), init };
}

const page = (title: string, index: number, extra: Record<string, unknown> = {}) => ({
	ns: 0,
	title,
	index,
	fullurl: `https://wiki.example/${title.replace(/ /g, "_")}`,
	...extra,
});

/** Runs `work` and returns what it threw, failing the test if it didn't. */
async function thrown(work: Promise<unknown>): Promise<WikiError> {
	try {
		await work;
	} catch (error) {
		expect(error).toBeInstanceOf(WikiError);
		return error as WikiError;
	}
	throw new Error("expected it to throw");
}

describe("MediaWiki.search", () => {
	it("asks for a full-text search of articles, with page URLs and the hit count", async () => {
		const fetch = json({ query: { searchinfo: { totalhits: 0 } } });
		await wiki(fetch).search("3d printer", 10);

		const { url, params, init } = sent(fetch);
		expect(`${url.origin}${url.pathname}`).toBe(API);
		expect(params).toMatchObject({
			action: "query",
			generator: "search",
			gsrsearch: "3d printer",
			gsrnamespace: "0",
			gsrlimit: "10",
			gsrinfo: "totalhits",
			prop: "info",
			inprop: "url",
			format: "json",
			formatversion: "2",
		});
		expect(init?.redirect).toBe("error");
		expect(init?.signal).toBeInstanceOf(AbortSignal);
		expect(new Headers(init?.headers).get("user-agent")).toBe("Pixel/test");
	});

	it("returns the pages in the order the wiki ranked them, with the total", async () => {
		const fetch = json({
			query: {
				searchinfo: { totalhits: 14 },
				pages: [page("Sublimation Printer", 2), page("3D Printing", 1), page("Darkroom", 3)],
			},
		});
		expect(await wiki(fetch).search("print*", 3)).toEqual({
			total: 14,
			pages: [
				{ title: "3D Printing", url: "https://wiki.example/3D_Printing" },
				{ title: "Sublimation Printer", url: "https://wiki.example/Sublimation_Printer" },
				{ title: "Darkroom", url: "https://wiki.example/Darkroom" },
			],
		});
	});

	it("finds nothing when the wiki has no pages to give", async () => {
		expect(await wiki(json({ query: { searchinfo: { totalhits: 0 } } })).search("zz", 10)).toEqual({
			total: 0,
			pages: [],
		});
		expect(await wiki(json({ batchcomplete: true })).search("zz", 10)).toEqual({
			total: 0,
			pages: [],
		});
	});

	it("drops pages that link anywhere but the wiki itself", async () => {
		const fetch = json({
			query: {
				searchinfo: { totalhits: 6 },
				pages: [
					page("Elsewhere", 1, { fullurl: "https://evil.example/Elsewhere" }),
					page("Downgraded", 2, { fullurl: "http://wiki.example/Downgraded" }),
					page("With login", 3, { fullurl: "https://someone:pw@wiki.example/With_login" }),
					page("Not a URL", 4, { fullurl: "not a url" }),
					page("No URL", 5, { fullurl: undefined }),
					page("Kitchen", 6),
				],
			},
		});
		const found = await wiki(fetch).search("x", 10);
		expect(found.pages.map((p) => p.title)).toEqual(["Kitchen"]);
		expect(found.total).toBe(6);
	});

	it("drops missing and invalid pages, repeats, blank titles and URLs too long for a button", async () => {
		const fetch = json({
			query: {
				pages: [
					page("Gone", 1, { missing: true }),
					page("Bad", 2, { invalid: true }),
					page("\u200b\n", 3),
					page("Long", 4, { fullurl: `https://wiki.example/${"a".repeat(600)}` }),
					page("Kitchen", 5),
					page("Kitchen again", 6, { fullurl: "https://wiki.example/Kitchen" }),
				],
			},
		});
		const found = await wiki(fetch).search("x", 10);
		expect(found).toEqual({
			total: 1,
			pages: [{ title: "Kitchen", url: "https://wiki.example/Kitchen" }],
		});
	});

	it("makes titles plain text and URLs safe inside a markdown link", async () => {
		const fetch = json({
			query: {
				pages: [
					page("Laser\u202e (old)\tcutter", 1, {
						fullurl: "https://wiki.example/Laser_(old)_cutter",
					}),
				],
			},
		});
		expect((await wiki(fetch).search("laser", 10)).pages).toEqual([
			{ title: "Laser (old) cutter", url: "https://wiki.example/Laser_%28old%29_cutter" },
		]);
	});

	it("keeps at most the limit", async () => {
		const fetch = json({ query: { pages: [page("A", 1), page("B", 2), page("C", 3)] } });
		const found = await wiki(fetch).search("x", 2);
		expect(found.pages.map((p) => p.title)).toEqual(["A", "B"]);
		expect(found.total).toBe(2);
	});

	it("fails on an HTTP error, a wiki error, bad JSON or the wrong shape", async () => {
		expect((await thrown(wiki(json({}, { status: 503 })).search("x", 1))).message).toBe(
			"wiki responded with HTTP 503",
		);
		const apiError = json({ error: { code: "maxlag", info: "Waiting for x: lag" } });
		expect((await thrown(wiki(apiError).search("secret search", 1))).message).toBe(
			"wiki API error: maxlag",
		);
		const garbage = vi.fn<Fetch>(async () => new Response("<html>"));
		expect((await thrown(wiki(garbage).search("x", 1))).message).toBe("wiki returned invalid JSON");
		const shape = json({ query: { pages: "nope" } });
		expect((await thrown(wiki(shape).search("x", 1))).message).toMatch(/unexpected shape/);
	});

	it("never puts what was searched for in an error", async () => {
		const apiError = json({ error: { code: "internal_api_error", info: "secret search" } });
		const error = await thrown(wiki(apiError).search("secret search", 1));
		expect(error.message).not.toContain("secret");
	});

	it("fails when the request fails or times out", async () => {
		const down = vi.fn<Fetch>(async () => {
			throw new TypeError("fetch failed");
		});
		const error = await thrown(wiki(down).search("x", 1));
		expect(error.message).toBe("wiki request failed");
		expect(error.cause).toBeInstanceOf(TypeError);
	});

	it("refuses an answer that's too big, whether it says so or not", async () => {
		const declared = vi.fn<Fetch>(
			async () => new Response("{}", { headers: { "content-length": "999999" } }),
		);
		expect((await thrown(wiki(declared).search("x", 1))).message).toBe("wiki response too large");
		const big = json({ query: { pages: [page("x".repeat(500), 1)] } });
		expect((await thrown(wiki(big, { maxResponseBytes: 100 }).search("x", 1))).message).toBe(
			"wiki response too large",
		);
	});
});

describe("MediaWiki.suggest", () => {
	it("asks for articles whose title starts with what's typed, within a shorter time", async () => {
		const fetch = json({ query: { prefixsearch: [{ title: "Cleaning" }, { title: " " }] } });
		expect(await wiki(fetch).suggest("Clea", 5)).toEqual(["Cleaning"]);
		expect(sent(fetch).params).toMatchObject({
			action: "query",
			list: "prefixsearch",
			pssearch: "Clea",
			psnamespace: "0",
			pslimit: "5",
		});
	});

	it("gives nothing when there's nothing, and fails on the wrong shape", async () => {
		expect(await wiki(json({ batchcomplete: true })).suggest("zz", 5)).toEqual([]);
		await thrown(wiki(json({ query: { prefixsearch: [{}] } })).suggest("x", 5));
	});

	it("keeps at most the limit", async () => {
		const fetch = json({ query: { prefixsearch: [{ title: "A" }, { title: "B" }] } });
		expect(await wiki(fetch).suggest("x", 1)).toEqual(["A"]);
	});
});

describe("MediaWiki.topPages", () => {
	const links = (...titles: string[]) =>
		json({ query: { pages: titles.map((title, i) => page(title, i + 1)) } });

	it("lists what the main page links to, by title, without the main page itself", async () => {
		const fetch = links("Services", "Board", "Main Page", "Cleaning");
		expect((await wiki(fetch).topPages()).map((p) => p.title)).toEqual([
			"Board",
			"Cleaning",
			"Services",
		]);
		expect(sent(fetch).params).toMatchObject({
			action: "query",
			generator: "links",
			titles: "Main Page",
			redirects: "1",
			prop: "info",
			inprop: "url",
		});
	});

	it("names a page by the link that redirects to it", async () => {
		const fetch = json({
			query: {
				redirects: [{ from: "Projects", to: "Category:Projects" }],
				pages: [page("Category:Projects", 1), page("Board", 2)],
			},
		});
		expect(await wiki(fetch).topPages()).toEqual([
			{ title: "Board", url: "https://wiki.example/Board" },
			{ title: "Projects", url: "https://wiki.example/Category:Projects" },
		]);
	});

	it("reads another page's links when told to", async () => {
		const fetch = links("Board");
		await wiki(fetch, { mainPage: "Start" }).topPages();
		expect(sent(fetch).params.titles).toBe("Start");
	});

	it("keeps at most 25", async () => {
		const titles = Array.from({ length: 30 }, (_, i) => `Page ${String(i).padStart(2, "0")}`);
		expect(await wiki(links(...titles)).topPages()).toHaveLength(25);
	});

	it("remembers the list for a while, then asks again", async () => {
		let now = 0;
		const fetch = links("Board");
		const w = wiki(fetch, { now: () => now, topPagesTtlMs: 1000 });
		await w.topPages();
		now = 999;
		await w.topPages();
		expect(fetch).toHaveBeenCalledTimes(1);
		now = 1000;
		await w.topPages();
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("shares one request between overlapping calls", async () => {
		const fetch = links("Board");
		const w = wiki(fetch);
		const [a, b] = await Promise.all([w.topPages(), w.topPages()]);
		expect(a).toEqual(b);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("keeps showing the last list while the wiki is down, and fails without one", async () => {
		let now = 0;
		let up = true;
		const fetch = vi.fn<Fetch>(async () => {
			if (!up) throw new TypeError("fetch failed");
			return new Response(JSON.stringify({ query: { pages: [page("Board", 1)] } }));
		});
		const w = wiki(fetch, { now: () => now, topPagesTtlMs: 10 });
		await w.topPages();
		up = false;
		now = 100;
		expect((await w.topPages()).map((p) => p.title)).toEqual(["Board"]);

		await thrown(wiki(fetch).topPages());
	});

	it("fails on the wrong shape", async () => {
		await thrown(wiki(json({ query: { pages: [{ index: 1 }] } })).topPages());
	});
});

describe("MediaWiki URLs", () => {
	it("has the wiki's front page at its origin", () => {
		expect(wiki(json({})).homeUrl).toBe("https://wiki.example/");
	});

	it("links to the wiki's own search page next to its API", () => {
		const url = new URL(wiki(json({})).searchUrl("laser (old) & co"));
		expect(`${url.origin}${url.pathname}`).toBe("https://wiki.example/w/index.php");
		expect(url.searchParams.get("title")).toBe("Special:Search");
		expect(url.searchParams.get("search")).toBe("laser (old) & co");
		expect(url.searchParams.get("fulltext")).toBe("1");
		expect(url.href).not.toMatch(/[()]/);
	});
});
