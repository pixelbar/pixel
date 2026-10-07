import { describe, expect, it, vi } from "vitest";
import { actor, command, group, IDS, subcommand } from "../testing/fixtures.ts";
import type { PlatformActor, Tier } from "./access.ts";
import { CapabilityRegistry } from "./capabilities.ts";
import { ChannelPosts, ChannelPostsUnavailableError, POSTS_UNAVAILABLE } from "./channel-posts.ts";
import type { CommandDefinition, CommandOption, ResolvedChannel } from "./command.ts";
import { Dispatcher, MESSAGES, validateArgs } from "./dispatcher.ts";
import { IdentityService } from "./identity.ts";
import { silentLogger } from "./logger.ts";
import { nullErrorReporter } from "./ports/error-reporter.ts";
import { RateLimiter } from "./rate-limit.ts";
import { CommandRegistry, RegistryError } from "./registry.ts";

const TIERS: Record<string, Tier> = { [IDS.admin]: "admin", [IDS.member]: "member" };
const text: CommandOption = {
	name: "text",
	description: "Message",
	type: "string",
	required: true,
	form: { style: "paragraph", maxLength: 10 },
};
const where: CommandOption = {
	name: "where",
	description: "Channel",
	type: "channel",
	required: true,
};
const channel: ResolvedChannel = {
	id: "100000000000000050",
	name: "general",
	caller: { canPost: true, canMentionEveryone: false, canCreatePolls: true },
};

function build(commands: CommandDefinition[]) {
	const registry = new CommandRegistry({
		capabilities: new CapabilityRegistry([{ name: "cap", description: "c" }]),
	});
	registry.register({ name: "feat", commands });
	return new Dispatcher({
		registry,
		identity: new IdentityService([
			{ name: "t", tierFor: async (a: PlatformActor) => TIERS[a.userId] ?? null },
		]),
		rateLimiter: new RateLimiter({ capacity: 100, refillPerSecond: 0, now: () => 0 }),
		logger: silentLogger,
		reporter: nullErrorReporter,
	});
}

describe("form fields", () => {
	it("are listed for a command, in order, and nothing else is", () => {
		const dispatcher = build([
			command({
				name: "post",
				options: [where, text, { name: "extra", description: "x", type: "string" }],
			}),
			group({ name: "grp", subcommands: [subcommand({ name: "go", options: [text] })] }),
		]);
		expect(dispatcher.formFields("post").map((o) => o.name)).toEqual(["text"]);
		expect(dispatcher.formFields("grp", "go").map((o) => o.name)).toEqual(["text"]);
		expect(dispatcher.formFields("nope")).toEqual([]);
	});

	it("are checked against their length", () => {
		expect(() => validateArgs({ options: [text] }, { text: "x".repeat(11) })).toThrow(
			/at most 10 characters/,
		);
		expect(validateArgs({ options: [text] }, { text: "short" }).args).toEqual({ text: "short" });
	});

	it("don't count towards the order of typed options", () => {
		const registry = new CommandRegistry();
		const optional: CommandOption = { name: "opt", description: "o", type: "string" };
		expect(() =>
			registry.register({
				name: "f",
				commands: [command({ name: "a", options: [optional, text] })],
			}),
		).not.toThrow();
	});

	it.each<[string, CommandOption, RegExp]>([
		[
			"choices",
			{
				name: "f",
				description: "d",
				type: "string",
				choices: ["a"],
				form: { style: "short", maxLength: 5 },
			},
			/can't have choices or suggestions/,
		],
		[
			"suggestions",
			{
				name: "f",
				description: "d",
				type: "string",
				suggest: async () => [],
				form: { style: "short", maxLength: 5 },
			},
			/can't have choices or suggestions/,
		],
		[
			"a long label",
			{
				name: "f",
				description: "x".repeat(46),
				type: "string",
				form: { style: "short", maxLength: 5 },
			},
			/at most 45 characters/,
		],
		[
			"no length",
			{ name: "f", description: "d", type: "string", form: { style: "short", maxLength: 0 } },
			/maxLength of 1–4000/,
		],
		[
			"too much length",
			{ name: "f", description: "d", type: "string", form: { style: "short", maxLength: 4001 } },
			/maxLength of 1–4000/,
		],
	])("refuse %s", (_label, option, message) => {
		const registry = new CommandRegistry();
		expect(() =>
			registry.register({ name: "f", commands: [command({ name: "a", options: [option] })] }),
		).toThrow(message);
	});

	it("are at most five per command", () => {
		const fields = Array.from({ length: 6 }, (_, i): CommandOption => ({ ...text, name: `f${i}` }));
		expect(() =>
			new CommandRegistry().register({
				name: "f",
				commands: [command({ name: "a", options: fields })],
			}),
		).toThrow(RegistryError);
	});
});

describe("precheck", () => {
	const dispatcher = build([
		command({ name: "open", access: { minTier: "guest" } }),
		command({ name: "members", access: { minTier: "member" } }),
		command({ name: "capped", access: { minTier: "member", capability: "cap" } }),
		command({ name: "dms", access: { minTier: "guest", contexts: ["dm"] } }),
	]);

	it("lets through someone who may run the command", async () => {
		expect(
			await dispatcher.precheck({ actor: actor({ userId: IDS.member }), command: "members" }),
		).toBeUndefined();
		expect(await dispatcher.precheck({ actor: actor(), command: "open" })).toBeUndefined();
	});

	it("gives the refusal for someone who may not, without running anything", async () => {
		expect((await dispatcher.precheck({ actor: actor(), command: "members" }))?.reply.text).toBe(
			MESSAGES.deniedTier,
		);
		expect(
			(await dispatcher.precheck({ actor: actor({ userId: IDS.member }), command: "capped" }))
				?.reply.text,
		).toBe(MESSAGES.deniedTier);
		expect((await dispatcher.precheck({ actor: actor(), command: "dms" }))?.reply.text).toBe(
			MESSAGES.deniedContext,
		);
		expect((await dispatcher.precheck({ actor: actor(), command: "nope" }))?.reply.text).toBe(
			MESSAGES.unknownCommand,
		);
	});
});

describe("channel options", () => {
	it("need a channel the adapter resolved, with the same ID, and pass it to the handler", async () => {
		expect(
			validateArgs({ options: [where] }, { where: channel.id }, {}, { where: channel }),
		).toEqual({
			args: { where: channel.id },
			users: {},
			channels: { where: channel },
		});
		expect(() => validateArgs({ options: [where] }, { where: channel.id })).toThrow(
			/Invalid value for option "where"/,
		);
		expect(() =>
			validateArgs({ options: [where] }, { where: "100000000000000099" }, {}, { where: channel }),
		).toThrow(/Invalid value/);
		const handler = vi.fn(async () => ({ text: "ok" }));
		const dispatcher = build([command({ name: "post", options: [where], handler })]);
		await dispatcher.dispatch({
			actor: actor(),
			command: "post",
			args: { where: channel.id },
			channels: { where: channel },
		});
		expect(handler).toHaveBeenCalledWith(expect.objectContaining({ channels: { where: channel } }));
	});
});

describe("ChannelPosts", () => {
	it("passes checks and posts to the poster the adapter plugged in", async () => {
		const posts = new ChannelPosts();
		expect(posts.ready).toBe(false);
		const poster = {
			check: vi.fn(async () => ({ ok: true as const, name: "g" })),
			post: vi.fn(async () => {}),
		};
		posts.use(poster);
		expect(posts.ready).toBe(true);
		const post = { kind: "message" as const, text: "hi", mentions: false };
		expect(await posts.check("1", post)).toEqual({ ok: true, name: "g" });
		await posts.post("1", post);
		expect(poster.post).toHaveBeenCalledWith("1", post);
	});

	it("says posting isn't available before then", () => {
		const posts = new ChannelPosts();
		const post = { kind: "message" as const, text: "hi", mentions: false };
		expect(() => posts.check("1", post)).toThrow(ChannelPostsUnavailableError);
		expect(() => posts.post("1", post)).toThrow(POSTS_UNAVAILABLE);
	});
});
