import { describe, expect, it } from "vitest";
import type { PlainCommand, SuggestFn } from "../../core/command.ts";
import { UserFacingError } from "../../core/errors.ts";
import { silentLogger } from "../../core/logger.ts";
import type { Reply } from "../../core/reply.ts";
import { type Control, UI_LIMITS } from "../../core/ui.ts";
import { FakeWiki, wikiPage } from "../../testing/fake-wiki.ts";
import { context, plain, principal } from "../../testing/fixtures.ts";
import { createWikiFeature, MAX_QUERY_LENGTH, MAX_RESULTS, MAX_TOP_BUTTONS } from "./index.ts";

const TOP = ["Board", "Cleaning", "Facilities", "Services"].map(wikiPage);
const PAGES = [
	"3D Printing",
	"3D-printing examples",
	"Sublimation Printer",
	"Cleaning",
	"Kitchen",
	"Laser [old] *cutter*",
].map(wikiPage);

function setup(pages = PAGES, top = TOP) {
	const wiki = new FakeWiki(pages, top);
	const command = plain(createWikiFeature({ wiki, logger: silentLogger }).commands?.[0]);
	const run = (query?: string) =>
		command.handler(context(query === undefined ? {} : { args: { query } }));
	return { wiki, command, run };
}

function suggestFor(command: PlainCommand): SuggestFn {
	const option = command.options?.[0];
	if (option?.type !== "string" || !option.suggest) throw new Error("expected suggestions");
	return option.suggest;
}

const suggest = (command: PlainCommand, typed: string) =>
	suggestFor(command)({ typed, args: {}, principal: principal("guest"), logger: silentLogger });

const links = (reply: Reply) =>
	(reply.controls ?? []).flat().map((control: Control) => {
		if (control.kind !== "link") throw new Error("only links expected");
		return { label: control.label, url: control.url };
	});

describe("/wiki", () => {
	it("is a guest command with an optional query and suggestions", () => {
		const { command } = setup();
		expect(command.name).toBe("wiki");
		expect(command.access).toEqual({ minTier: "guest" });
		expect(command.private).toBeFalsy();
		expect(command.options).toEqual([
			expect.objectContaining({ name: "query", type: "string", suggest: expect.any(Function) }),
		]);
		expect(command.options?.[0]?.required).toBeFalsy();
	});

	describe("without a query", () => {
		it("privately offers the top pages as link buttons, and the wiki itself", async () => {
			const reply = await setup().run();
			expect(reply.private).toBe(true);
			expect(reply.embeds?.[0]?.title).toContain("Pixelbar wiki");
			expect(reply.embeds?.[0]?.url).toBe("https://wiki.example/");
			expect(reply.embeds?.[0]?.description).toContain("/wiki query:");
			expect(links(reply)).toEqual([
				...TOP.map((page) => ({ label: page.title, url: page.url })),
				{ label: "Open the wiki", url: "https://wiki.example/" },
			]);
			// The top pages on one row, the wiki on its own.
			expect(reply.controls?.map((row) => row.length)).toEqual([4, 1]);
		});

		it("treats a blank query as none", async () => {
			expect((await setup().run("  \u200b ")).embeds?.[0]?.title).toContain("Pixelbar wiki");
		});

		it("puts five buttons in a row, and at most two rows of top pages", async () => {
			const top = Array.from({ length: 13 }, (_, i) => wikiPage(`Page ${i}`));
			const reply = await setup(PAGES, top).run();
			expect(reply.controls?.map((row) => row.length)).toEqual([5, 5, 1]);
			expect(links(reply)).toHaveLength(MAX_TOP_BUTTONS + 1);
		});

		it("shortens long titles on buttons", async () => {
			const reply = await setup(PAGES, [wikiPage("A".repeat(60))]).run();
			const label = links(reply)[0]?.label ?? "";
			expect([...label]).toHaveLength(38);
			expect(label.endsWith("…")).toBe(true);
		});

		it("still answers, with just the wiki, when the top pages can't be read", async () => {
			const { wiki, run } = setup();
			wiki.topFailing = true;
			const reply = await run();
			expect(reply.embeds?.[0]?.description).toContain("couldn't load its top pages");
			expect(links(reply)).toEqual([{ label: "Open the wiki", url: "https://wiki.example/" }]);
		});

		it("says to open the wiki when it has no top pages", async () => {
			const reply = await setup(PAGES, []).run();
			expect(links(reply)).toEqual([{ label: "Open the wiki", url: "https://wiki.example/" }]);
		});
	});

	describe("with a query", () => {
		it("lists the matching pages publicly, as links", async () => {
			const reply = await setup().run("printer");
			expect(reply.private).toBeFalsy();
			const embed = reply.embeds?.[0];
			expect(embed?.description).toContain("1 page on the wiki matches `printer`:");
			expect(embed?.description).toContain(
				"- [Sublimation Printer](https://wiki.example/Sublimation_Printer)",
			);
			expect(embed?.url).toBe("https://wiki.example/w/index.php?search=printer");
			expect(links(reply)).toEqual([{ label: "Open the wiki", url: "https://wiki.example/" }]);
		});

		it("escapes titles written by wiki editors", async () => {
			const reply = await setup().run("laser");
			expect(reply.embeds?.[0]?.description).toContain(
				"- [Laser \\[old\\] \\*cutter\\*](https://wiki.example/Laser_%5Bold%5D_*cutter*)",
			);
		});

		it("tries every word as a prefix when the words alone find nothing", async () => {
			const { wiki, run } = setup();
			const reply = await run("3d print");
			expect(wiki.searches).toEqual(["3d print", "3d* print*"]);
			expect(reply.embeds?.[0]?.description).toContain("2 pages on the wiki match `3d print`:");
		});

		it("doesn't second-guess a search that uses quotes or wildcards", async () => {
			const { wiki, run } = setup();
			await run("clea*n");
			await run('"nope"');
			expect(wiki.searches).toEqual(["clea*n", '"nope"']);
		});

		it("doesn't search twice when there's no word to make a prefix of", async () => {
			const { wiki, run } = setup();
			await run("-- !!");
			expect(wiki.searches).toEqual(["-- !!"]);
		});

		it("shows the first results and links to the rest on the wiki", async () => {
			const many = Array.from({ length: 14 }, (_, i) => wikiPage(`Meeting ${i}`));
			const reply = await setup(many).run("meeting");
			const description = reply.embeds?.[0]?.description ?? "";
			expect(description).toContain(
				`14 pages on the wiki match \`meeting\`. Here are the first ${MAX_RESULTS}:`,
			);
			expect(description.match(/^- \[/gm)).toHaveLength(MAX_RESULTS);
			expect(links(reply)).toEqual([
				{
					label: "See all 14 results",
					url: "https://wiki.example/w/index.php?search=meeting",
				},
				{ label: "Open the wiki", url: "https://wiki.example/" },
			]);
		});

		it("links to the search that found the results, wildcards included", async () => {
			const many = Array.from({ length: 14 }, (_, i) => wikiPage(`Meetings ${i}`));
			const reply = await setup(many).run("meet");
			const description = reply.embeds?.[0]?.description ?? "";
			// Shown as typed, but the wiki's own search page only finds them with the wildcard.
			expect(description).toContain("14 pages on the wiki match `meet`.");
			const all = "https://wiki.example/w/index.php?search=meet*";
			expect(reply.embeds?.[0]?.url).toBe(all);
			expect(links(reply)[0]).toEqual({ label: "See all 14 results", url: all });
		});

		it("says privately when nothing matches, with the top pages", async () => {
			const reply = await setup().run("unicorn");
			expect(reply.private).toBe(true);
			expect(reply.embeds?.[0]?.description).toContain("No page on the wiki matches `unicorn`");
			expect(reply.embeds?.[0]?.description).toContain("top pages below");
			expect(links(reply)).toHaveLength(TOP.length + 1);
		});

		it("doesn't mention top pages it couldn't load", async () => {
			const { wiki, run } = setup();
			wiki.topFailing = true;
			const reply = await run("unicorn");
			expect(reply.embeds?.[0]?.description).not.toContain("top pages");
			expect(links(reply)).toHaveLength(1);
		});

		it("says privately when the wiki can't be searched", async () => {
			const { wiki, run } = setup();
			wiki.failing = true;
			const reply = await run("printer");
			expect(reply.private).toBe(true);
			expect(reply.embeds?.[0]?.title).toContain("Couldn't search the wiki");
			expect(links(reply)).toEqual([{ label: "Open the wiki", url: "https://wiki.example/" }]);
		});

		it("shows what was searched for as code, so it can't format or mention", async () => {
			const reply = await setup().run("@everyone **`x`**");
			expect(reply.embeds?.[0]?.description).toContain("`@everyone **'x'**`");
		});

		it("refuses a query that's too long", async () => {
			const { wiki, run } = setup();
			await expect(run("x".repeat(MAX_QUERY_LENGTH + 1))).rejects.toThrow(UserFacingError);
			expect(wiki.searches).toEqual([]);
		});

		it("fits in one Discord message, however long the titles and links", async () => {
			const long = Array.from({ length: 30 }, (_, i) => ({
				title: `${"Very long page title ".repeat(12)}${i}`,
				url: `https://wiki.example/${"a".repeat(500)}${i}`,
			}));
			const fits = (reply: Reply) => {
				expect(reply.embeds?.[0]?.description?.length).toBeLessThanOrEqual(4096);
				expect(reply.controls?.length).toBeLessThanOrEqual(UI_LIMITS.rows);
				for (const row of reply.controls ?? []) {
					expect(row.length).toBeLessThanOrEqual(UI_LIMITS.buttonsPerRow);
				}
				for (const link of links(reply)) expect(link.label.length).toBeLessThanOrEqual(80);
			};
			const reply = await setup(long, long).run("very");
			fits(reply);
			const description = reply.embeds?.[0]?.description ?? "";
			const shown = description.match(/^- \[/gm)?.length ?? 0;
			// Only whole links, and the line above says how many.
			expect(shown).toBeGreaterThan(0);
			expect(shown).toBeLessThan(MAX_RESULTS);
			expect(description).toContain(`Here are the first ${shown}:`);
			expect(description.trimEnd().endsWith(")")).toBe(true);
			fits(await setup(long, long).run());
			fits(await setup(long, long).run("unicorn"));
		});
	});

	describe("suggestions", () => {
		it("suggests page titles that start with what's typed", async () => {
			const { command } = setup();
			expect(await suggest(command, " 3d")).toEqual([
				{ name: "3D Printing", value: "3D Printing" },
				{ name: "3D-printing examples", value: "3D-printing examples" },
			]);
		});

		it("suggests nothing before anything's typed, or when it's too long to search", async () => {
			const { command } = setup();
			expect(await suggest(command, " ")).toEqual([]);
			expect(await suggest(command, "x".repeat(MAX_QUERY_LENGTH + 1))).toEqual([]);
		});

		it("suggests nothing, quietly, when the wiki is down", async () => {
			const { wiki, command } = setup();
			wiki.failing = true;
			expect(await suggest(command, "3d")).toEqual([]);
		});
	});
});
