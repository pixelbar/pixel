import { describe, expect, it } from "vitest";
import { isGroup, isSubgroup } from "../../core/command.ts";
import { Dispatcher, MESSAGES } from "../../core/dispatcher.ts";
import { IdentityService } from "../../core/identity.ts";
import { silentLogger } from "../../core/logger.ts";
import { nullErrorReporter } from "../../core/ports/error-reporter.ts";
import { RateLimiter } from "../../core/rate-limit.ts";
import { CommandRegistry } from "../../core/registry.ts";
import { actor, context, IDS } from "../../testing/fixtures.ts";
import { createFishbotFeature } from "./index.ts";
import { PHRASES } from "./phrases.ts";

function setup(capacity = 100) {
	const registry = new CommandRegistry();
	registry.register(createFishbotFeature());
	return new Dispatcher({
		registry,
		identity: new IdentityService([]),
		rateLimiter: new RateLimiter({ capacity, refillPerSecond: 0, now: () => 0 }),
		logger: silentLogger,
		reporter: nullErrorReporter,
	});
}

const request = (phrase?: string) => ({
	actor: actor(),
	command: "fishbot",
	subcommand: "say",
	args: phrase === undefined ? {} : { phrase },
});

describe("Fishbot", () => {
	it.each(PHRASES)("answers the complete phrase %s for a guest", async (phrase, response) => {
		const result = await setup().dispatch(request(phrase));
		expect(result.private).toBe(false);
		expect(result.reply.text).toBe(response.replaceAll("$nick", "`Test User`"));
		expect(result.reply.text).not.toContain("$nick");
		expect(result.reply.text).not.toMatch(/\p{Cc}/u);
	});

	it("normalizes case and whitespace", async () => {
		const result = await setup().dispatch(request("  HeLLo   Fishbot \n"));
		expect(result.reply.text).toBe("Hi `Test User`");
	});

	it.each([
		undefined,
		"",
		"something unknown",
		"I mentioned fish in a sentence",
		"fish\x01",
		"fish $name",
	])("privately helps with unmatched input %s without echoing it", async (phrase) => {
		const result = await setup().dispatch(request(phrase));
		expect(result.private).toBe(true);
		expect(result.reply.text).toContain("/fishbot say phrase:fish");
		expect(result.reply.text).toContain("/fishbot trout user:");
	});

	it("keeps malicious display names inert, bounded, and out of template replacement", async () => {
		const result = await setup().dispatch({
			...request("hello fishbot"),
			actor: actor({ displayName: "`**@everyone**\n\x01$name $&" }),
		});
		expect(result.reply.text).toBe("Hi `'**@everyone** $name $&`");
		const long = await setup().dispatch({
			...request("fish"),
			actor: actor({ displayName: "x".repeat(3000) }),
		});
		expect(long.reply.text?.length).toBeLessThan(150);
	});

	it("limits and filters discoverable phrases", async () => {
		const dispatcher = setup();
		const suggest = (typed: string) =>
			dispatcher.suggest({
				actor: actor(),
				command: "fishbot",
				subcommand: "say",
				option: "phrase",
				typed,
				args: {},
			});
		const all = await suggest("");
		expect(all).toHaveLength(25);
		const filtered = await suggest("  BADGER  ");
		expect(filtered).toEqual([
			{
				name: PHRASES.find(([phrase]) => phrase.startsWith("badger"))?.[0],
				value: PHRASES.find(([phrase]) => phrase.startsWith("badger"))?.[0],
			},
		]);
		for (const entry of all) {
			expect(entry.name.length).toBeLessThanOrEqual(100);
			expect((await dispatcher.dispatch(request(String(entry.value)))).private).toBe(false);
		}
		expect(await suggest("nonexistent")).toEqual([]);
	});

	it.each(["feed", "pet", "cookie"])("supports the %s action", async (subcommand) => {
		const result = await setup().dispatch({
			actor: actor(),
			command: "fishbot",
			subcommand,
			args: {},
		});
		expect(result.private).toBe(false);
		expect(result.reply.text).toBeTruthy();
		expect(result.reply.text).not.toMatch(/\p{Cc}/u);
	});

	it("trouts the resolved user, including bots, without a mention", async () => {
		const result = await setup().dispatch({
			actor: actor(),
			command: "fishbot",
			subcommand: "trout",
			args: { user: IDS.member },
			users: { user: { id: IDS.member, displayName: "**Fishbot**", isBot: true } },
		});
		expect(result.private).toBe(false);
		expect(result.reply.text).toBe(
			"`Test User` slaps `**Fishbot**` around a bit with a large trout. trouted!",
		);
		expect(result.reply.text).not.toContain(IDS.member);
	});

	it("refuses missing or unresolved trout targets", async () => {
		for (const args of [{}, { user: IDS.member }]) {
			const result = await setup().dispatch({
				actor: actor(),
				command: "fishbot",
				subcommand: "trout",
				args,
			});
			expect(result.private).toBe(true);
			expect(result.reply.text).not.toContain("trouted!");
		}
	});

	it.each([
		["hampster", "`Test User`: There is no 'p' in hamster you retard."],
		["fish", "`Test User`: fish go m00!"],
		["how old are you, fishbot?", "*is older than time itself.*"],
		["vinegar with aftershock!", "Ah, a true connoisseur!"],
	])("preserves the original reply for %s", async (phrase, expected) => {
		expect((await setup().dispatch(request(phrase))).reply.text).toBe(expected);
	});

	it("defends the trout handler against a missing resolved target", async () => {
		const group = createFishbotFeature().commands?.[0];
		if (!group || !isGroup(group)) throw new Error("Missing Fishbot group");
		const trout = group.subcommands.find((sub) => sub.name === "trout");
		if (!trout || isSubgroup(trout)) throw new Error("Missing trout command");
		await expect(trout.handler(context())).rejects.toThrow("Choose someone to trout.");
	});

	it("uses the normal shared command rate limit", async () => {
		const dispatcher = setup(1);
		expect((await dispatcher.dispatch(request("fish"))).private).toBe(false);
		const result = await dispatcher.dispatch({
			actor: actor(),
			command: "fishbot",
			subcommand: "feed",
			args: {},
		});
		expect(result).toEqual({ private: true, reply: { text: MESSAGES.rateLimited, private: true } });
	});
});
