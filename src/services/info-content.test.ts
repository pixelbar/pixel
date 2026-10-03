import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	InfoContentError,
	infoVariables,
	loadInfoTopics,
	MAX_BODY_LENGTH,
	MAX_TOPICS,
} from "./info-content.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pixel-info-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** Writes files into the content folder and returns it. */
function content(files: Record<string, string>): string {
	for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
	return dir;
}

const topic = (title = "A title", summary = "A summary", body = "Some text.", extra = "") =>
	`---\ntitle: ${title}\nsummary: ${summary}\n${extra}---\n${body}\n`;

/** The problems loading `files` reports, one per line. */
function problemsWith(files: Record<string, string>): string {
	try {
		loadInfoTopics(content(files));
	} catch (error) {
		expect(error).toBeInstanceOf(InfoContentError);
		return (error as Error).message;
	}
	throw new Error("expected loading to fail");
}

describe("loadInfoTopics", () => {
	it("loads a topic: the file name is its ID, and the text is trimmed", () => {
		const topics = loadInfoTopics(
			content({
				"membership.md": topic("Becoming a member", "How to join", "\n\nEmail the board.\n\n"),
			}),
		);
		expect(topics).toEqual([
			{
				id: "membership",
				title: "Becoming a member",
				summary: "How to join",
				body: "Email the board.",
			},
		]);
	});

	it("orders by 'order' and then by ID, with 100 as the default order", () => {
		const topics = loadInfoTopics(
			content({
				"a.md": topic(),
				"b.md": topic("B", "B", "x", "order: 5\n"),
				"c.md": topic("C", "C", "x", "order: 5\n"),
				"d.md": topic("D", "D", "x", "order: 0\n"),
			}),
		);
		expect(topics.map((t) => t.id)).toEqual(["d", "b", "c", "a"]);
	});

	it("doesn't expose the order in the topics it returns", () => {
		const [loaded] = loadInfoTopics(content({ "a.md": topic("A", "A", "x", "order: 3\n") }));
		expect(loaded).not.toHaveProperty("order");
	});

	it("handles Windows line endings", () => {
		const windows = topic("Title", "Summary", "Line one.\nLine two.").replace(/\n/g, "\r\n");
		expect(loadInfoTopics(content({ "a.md": windows }))[0]).toMatchObject({
			title: "Title",
			body: "Line one.\nLine two.",
		});
	});

	it("keeps horizontal rules and later --- lines in the text", () => {
		const body = "Before.\n\n---\n\nAfter.";
		expect(loadInfoTopics(content({ "a.md": topic("A", "B", body) }))[0]?.body).toBe(body);
	});

	it("ignores files that aren't markdown", () => {
		const topics = loadInfoTopics(
			content({ "a.md": topic(), "notes.txt": "not a topic", ".gitkeep": "" }),
		);
		expect(topics.map((t) => t.id)).toEqual(["a"]);
	});

	it("accepts IDs with digits and single dashes", () => {
		const topics = loadInfoTopics(content({ "how-to-join-2.md": topic() }));
		expect(topics[0]?.id).toBe("how-to-join-2");
	});

	describe("refuses content that's wrong, naming the file and the problem", () => {
		it("a missing folder", () => {
			expect(() => loadInfoTopics(join(dir, "nope"))).toThrow(/cannot read .*nope \(ENOENT\)/);
		});

		it("a folder with no topics", () => {
			expect(problemsWith({ "notes.txt": "hello" })).toMatch(/has no \.md files/);
		});

		it.each([
			"Membership.md",
			"my topic.md",
			"under_score.md",
			"-a.md",
			"a-.md",
			"a--b.md",
			"a.b.md",
			`${"x".repeat(33)}.md`,
		])("the file name %s", (name) => {
			expect(problemsWith({ [name]: topic() })).toContain(
				`${name}: the file name must be lowercase`,
			);
		});

		it("no --- block at the top", () => {
			expect(problemsWith({ "a.md": "Just text." })).toContain("a.md: must start with a --- block");
			expect(problemsWith({ "b.md": "\n---\ntitle: x\n---\ntext" })).toContain(
				"b.md: must start with",
			);
			expect(problemsWith({ "c.md": "---\ntitle: never closed\ntext" })).toContain(
				"c.md: must start with",
			);
		});

		it("a --- block that isn't YAML", () => {
			expect(problemsWith({ "a.md": "---\ntitle: [unclosed\n---\ntext" })).toContain(
				"a.md: the --- block at the top isn't valid YAML",
			);
		});

		it("an empty --- block", () => {
			expect(problemsWith({ "a.md": "---\n---\ntext" })).toMatch(/a\.md: .*(title|block)/);
		});

		it("a missing title or summary", () => {
			const message = problemsWith({ "a.md": "---\nsummary: only a summary\n---\ntext" });
			expect(message).toContain("a.md: title:");
			expect(message).not.toContain("a.md: summary:");
			expect(problemsWith({ "b.md": "---\ntitle: only a title\n---\ntext" })).toContain(
				"b.md: summary:",
			);
		});

		it("a title or summary that's too long, or blank", () => {
			expect(problemsWith({ "a.md": topic("x".repeat(81)) })).toContain("a.md: title:");
			expect(problemsWith({ "b.md": topic("T", "x".repeat(121)) })).toContain("b.md: summary:");
			expect(problemsWith({ "c.md": '---\ntitle: "  "\nsummary: ok\n---\ntext' })).toContain(
				"c.md: title:",
			);
		});

		it("keys it doesn't know, which catches typos", () => {
			expect(problemsWith({ "a.md": topic("T", "S", "text", "sumary: typo\n") })).toMatch(
				/a\.md: .*sumary/,
			);
		});

		it.each(["-1", "1000", "1.5", "soon"])("an order of %s", (order) => {
			expect(problemsWith({ "a.md": topic("T", "S", "text", `order: ${order}\n`) })).toContain(
				"a.md: order:",
			);
		});

		it("no text after the --- block", () => {
			expect(problemsWith({ "a.md": "---\ntitle: T\nsummary: S\n---\n\n  \n" })).toContain(
				"a.md: has no text after the --- block",
			);
			expect(problemsWith({ "b.md": "---\ntitle: T\nsummary: S\n---" })).toContain(
				"b.md: has no text",
			);
		});

		it("text that won't fit in a Discord message", () => {
			expect(problemsWith({ "a.md": topic("T", "S", "x".repeat(MAX_BODY_LENGTH + 1)) })).toContain(
				`a.md: the text is ${MAX_BODY_LENGTH + 1} characters; the limit is ${MAX_BODY_LENGTH}`,
			);
		});

		it("text exactly at the limit is fine", () => {
			const [loaded] = loadInfoTopics(
				content({ "a.md": topic("T", "S", "x".repeat(MAX_BODY_LENGTH)) }),
			);
			expect(loaded?.body).toHaveLength(MAX_BODY_LENGTH);
		});

		it("more topics than Discord allows", () => {
			const files = Object.fromEntries(
				Array.from({ length: MAX_TOPICS + 1 }, (_, i) => [`topic-${i}.md`, topic()]),
			);
			expect(problemsWith(files)).toContain(`too many; Discord allows at most ${MAX_TOPICS}`);
		});

		it("exactly the most Discord allows is fine", () => {
			const files = Object.fromEntries(
				Array.from({ length: MAX_TOPICS }, (_, i) => [`topic-${i}.md`, topic()]),
			);
			expect(loadInfoTopics(content(files))).toHaveLength(MAX_TOPICS);
		});

		it("every problem in every file at once", () => {
			const message = problemsWith({
				"good.md": topic(),
				"BAD.md": topic(),
				"no-block.md": "Just text.",
				"no-body.md": "---\ntitle: T\nsummary: S\n---\n",
			});
			expect(message).toContain("BAD.md:");
			expect(message).toContain("no-block.md:");
			expect(message).toContain("no-body.md:");
			expect(message).not.toContain("good.md:");
			expect(message.split("\n").filter((line) => line.startsWith("  - "))).toHaveLength(3);
		});
	});

	it("doesn't read inside sub-folders", () => {
		mkdirSync(join(dir, "nested"));
		writeFileSync(join(dir, "nested", "hidden.md"), "not a topic");
		expect(loadInfoTopics(content({ "a.md": topic() })).map((t) => t.id)).toEqual(["a"]);
	});
});

describe("placeholders", () => {
	const variables = { "announcements-channel": "<#123>", who: "the board" };
	const load = (body: string) =>
		loadInfoTopics(content({ "a.md": topic("T", "S", body) }), variables)[0]?.body;

	it("fills in {{name}}, however many times it appears and with or without spaces", () => {
		expect(load("Ask {{who}}, or {{ who }}. See {{announcements-channel}}.")).toBe(
			"Ask the board, or the board. See <#123>.",
		);
	});

	it("inserts the value exactly as given", () => {
		const tricky = { x: "$& $1 $$ <#1>" };
		expect(loadInfoTopics(content({ "a.md": topic("T", "S", "[{{x}}]") }), tricky)[0]?.body).toBe(
			"[$& $1 $$ <#1>]",
		);
	});

	it("leaves text alone when there are no placeholders", () => {
		expect(load("Nothing to fill in.")).toBe("Nothing to fill in.");
	});

	it("refuses a placeholder that isn't known", () => {
		const message = problemsWith({ "a.md": topic("T", "S", "See {{announcement-channel}}.") });
		expect(message).toContain("a.md: {{announcement-channel}} isn't a known placeholder");
	});

	it("lists the known placeholders when it refuses one", () => {
		let message = "";
		try {
			loadInfoTopics(content({ "b.md": topic("T", "S", "See {{nope}}.") }), variables);
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain("(known: {{announcements-channel}}, {{who}})");
	});

	it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])(
		"doesn't treat the inherited property %s as a placeholder",
		(name) => {
			expect(problemsWith({ "a.md": topic("T", "S", `See {{${name}}}.`) })).toContain(
				"isn't a known placeholder",
			);
		},
	);

	it.each([
		["an opening {{ with no end", "See {{announcements-channel."],
		["a closing }} with no start", "See announcements-channel}}."],
		["nested braces", "See {{{{who}}}}."],
	])("refuses %s", (_label, body) => {
		expect(problemsWith({ "a.md": topic("T", "S", body) })).toContain("has a stray {{ or }}");
	});

	it("checks the length of the text people will see, after filling in", () => {
		const body = `${"x".repeat(MAX_BODY_LENGTH - 10)}{{who}}`; // fits only until it's filled in
		expect(() =>
			loadInfoTopics(content({ "a.md": topic("T", "S", body) }), { who: "y".repeat(20) }),
		).toThrow(/the limit is/);
	});

	it("only fills in the text, not the title or summary", () => {
		const [loaded] = loadInfoTopics(
			content({ "a.md": topic("About {{who}}", "By {{who}}", "Text") }),
			variables,
		);
		expect(loaded).toMatchObject({ title: "About {{who}}", summary: "By {{who}}" });
	});
});

describe("infoVariables", () => {
	it("points the announcements channel at the configured channel, as a channel link", () => {
		expect(infoVariables({ announcementsChannelId: "1555937478266064977" })).toEqual({
			"announcements-channel": "<#1555937478266064977>",
		});
	});

	it.each([undefined, ""])("falls back to plain words when the channel is %j", (id) => {
		expect(infoVariables({ announcementsChannelId: id })).toEqual({
			"announcements-channel": "the announcements channel",
		});
		expect(infoVariables({})["announcements-channel"]).toBe("the announcements channel");
	});
});

describe("the real content/info folder", () => {
	const realDir = resolve(import.meta.dirname, "../../content/info");
	const real = (announcementsChannelId?: string) =>
		loadInfoTopics(realDir, infoVariables({ announcementsChannelId }));

	it("loads without problems, so a broken edit can't be merged", () => {
		expect(() => real()).not.toThrow();
		expect(() => real("1555937478266064977")).not.toThrow();
	});

	it("covers the launch topics, in a sensible order", () => {
		expect(real().map((t) => t.id)).toEqual([
			"address",
			"visiting",
			"membership",
			"rules",
			"contact",
		]);
	});

	it("keeps every topic short, and points the long ones at the website", () => {
		for (const topicFound of real()) {
			expect(topicFound.body.length).toBeLessThanOrEqual(MAX_BODY_LENGTH);
		}
		const byId = Object.fromEntries(real().map((t) => [t.id, t.body]));
		expect(byId.rules).toContain("https://pixelbar.nl/houserules/");
		expect(byId.membership).toContain("https://pixelbar.nl/becomingamember/");
	});

	it("tells people when it's open, pointing at the announcements channel and its weekly poll", () => {
		const visiting = (id?: string) => real(id).find((t) => t.id === "visiting")?.body;
		const expected = (channel: string) =>
			`Normally Wednesday evening until late, check ${channel} and vote in the weekly poll so someone knows you're interested!`;
		expect(visiting("1555937478266064977")).toContain(expected("<#1555937478266064977>"));
		expect(visiting()).toContain(expected("the announcements channel"));
	});

	it("never leaves a {{placeholder}} showing in a reply", () => {
		for (const topicFound of real()) {
			expect(topicFound.body).not.toMatch(/\{\{|\}\}/);
		}
	});
});
