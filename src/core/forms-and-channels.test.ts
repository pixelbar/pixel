import { describe, expect, it, vi } from "vitest";
import { actor, command, group, IDS, subcommand } from "../testing/fixtures.ts";
import type { PlatformActor, Tier } from "./access.ts";
import { CapabilityRegistry } from "./capabilities.ts";
import { ChannelPosts, ChannelPostsUnavailableError, POSTS_UNAVAILABLE } from "./channel-posts.ts";
import type { CommandDefinition, CommandOption, ResolvedChannel } from "./command.ts";
import { Dispatcher, MESSAGES, validateArgs } from "./dispatcher.ts";
import { UserFacingError } from "./errors.ts";
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

	it("can be omitted when skipMissingFormFields is set, so the form hasn't opened yet", () => {
		expect(() => validateArgs({ options: [where, text] }, {})).toThrow(/where/);
		expect(
			validateArgs(
				{ options: [where, text] },
				{ where: channel.id },
				{},
				{ where: channel },
				{ skipMissingFormFields: true },
			).args,
		).toEqual({ where: channel.id });
		expect(() =>
			validateArgs({ options: [where, text] }, {}, {}, {}, { skipMissingFormFields: true }),
		).toThrow(/where/);
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

	it("logs a denial the same way as dispatch", async () => {
		const denied: object[] = [];
		const logger = {
			...silentLogger,
			child: (bindings: Record<string, unknown>) => ({
				...silentLogger,
				warn: (obj: object) => {
					denied.push({ ...bindings, ...obj });
				},
			}),
		};
		const dispatcher = new Dispatcher({
			registry: (() => {
				const registry = new CommandRegistry({
					capabilities: new CapabilityRegistry([{ name: "cap", description: "c" }]),
				});
				registry.register({
					name: "feat",
					commands: [command({ name: "members", access: { minTier: "member" } })],
				});
				return registry;
			})(),
			identity: new IdentityService([
				{ name: "t", tierFor: async (a: PlatformActor) => TIERS[a.userId] ?? null },
			]),
			rateLimiter: new RateLimiter({ capacity: 100, refillPerSecond: 0, now: () => 0 }),
			logger,
			reporter: nullErrorReporter,
		});
		await dispatcher.precheck({ actor: actor(), command: "members" });
		expect(denied[0]).toMatchObject({
			event: "command.denied",
			reason: "tier",
			required: "member",
			command: "members",
		});
	});
});

describe("prepareForm", () => {
	it("opens the form with no extra title when the command has no beforeForm", async () => {
		const dispatcher = build([command({ name: "post", options: [where, text] })]);
		expect(
			await dispatcher.prepareForm({
				actor: actor(),
				command: "post",
				args: { where: channel.id },
				channels: { where: channel },
			}),
		).toEqual({ ready: true });
	});

	it("lets the form open once access and slash options pass, with an optional title", async () => {
		const dispatcher = build([
			command({
				name: "post",
				options: [where, text],
				beforeForm: async () => ({ title: "Wed 14 Oct 2026, 19:00" }),
			}),
		]);
		expect(
			await dispatcher.prepareForm({
				actor: actor(),
				command: "post",
				args: { where: channel.id },
				channels: { where: channel },
			}),
		).toEqual({ ready: true, title: "Wed 14 Oct 2026, 19:00" });
	});

	it("passes field values from beforeForm so an edit can open with the saved text", async () => {
		const dispatcher = build([
			command({
				name: "post",
				options: [text],
				beforeForm: async () => ({ values: { text: "Please tidy the kitchen." } }),
			}),
		]);
		expect(
			await dispatcher.prepareForm({
				actor: actor(),
				command: "post",
				args: {},
			}),
		).toEqual({ ready: true, values: { text: "Please tidy the kitchen." } });
	});

	it("passes which form fields to show, including an empty list that skips the form", async () => {
		const dispatcher = build([
			command({
				name: "edit",
				options: [text, { name: "schedule", description: "Which", type: "string" }],
				beforeForm: async ({ args }) =>
					args.schedule === undefined
						? { fields: [] }
						: { fields: ["text"], values: { text: "saved" } },
			}),
		]);
		expect(await dispatcher.prepareForm({ actor: actor(), command: "edit", args: {} })).toEqual({
			ready: true,
			fields: [],
		});
		expect(
			await dispatcher.prepareForm({
				actor: actor(),
				command: "edit",
				args: { schedule: "ab2c3d" },
			}),
		).toEqual({ ready: true, fields: ["text"], values: { text: "saved" } });
	});

	it("does not require form fields yet, so a long body isn't asked for against a bad option", async () => {
		const dispatcher = build([
			command({
				name: "post",
				options: [where, text],
				beforeForm: async ({ args }) => {
					if (args.when === "someday") throw new Error("should not run");
					return { title: "ok" };
				},
			}),
		]);
		// `text` is required on the form; it is missing here on purpose.
		const ready = await dispatcher.prepareForm({
			actor: actor(),
			command: "post",
			args: { where: channel.id },
			channels: { where: channel },
		});
		expect(ready.ready).toBe(true);
	});

	it("refuses a bad slash option without running the handler, so nothing is saved", async () => {
		const handler = vi.fn(async () => ({ text: "saved" }));
		const dispatcher = build([
			command({
				name: "post",
				options: [where, text],
				beforeForm: async () => {
					throw new UserFacingError("bad time");
				},
				handler,
			}),
		]);
		const result = await dispatcher.prepareForm({
			actor: actor(),
			command: "post",
			args: { where: channel.id, when: "someday" },
			channels: { where: channel },
		});
		expect(result).toEqual({
			ready: false,
			refuse: { reply: { text: "bad time", private: true }, private: true },
		});
		expect(handler).not.toHaveBeenCalled();
	});

	it("still refuses someone who may not run the command, without opening the form", async () => {
		const dispatcher = build([
			command({
				name: "members",
				access: { minTier: "member" },
				options: [text],
				beforeForm: async () => ({ title: "nope" }),
			}),
		]);
		const result = await dispatcher.prepareForm({
			actor: actor(),
			command: "members",
			args: {},
		});
		expect(result).toEqual({
			ready: false,
			refuse: { reply: { text: MESSAGES.deniedTier, private: true }, private: true },
		});
	});

	it("turns a failure in beforeForm into a reported internal error", async () => {
		const dispatcher = build([
			command({
				name: "post",
				options: [text],
				beforeForm: async () => {
					throw new Error("boom");
				},
			}),
		]);
		const result = await dispatcher.prepareForm({
			actor: actor(),
			command: "post",
			args: {},
		});
		expect(result).toEqual({
			ready: false,
			refuse: { reply: { text: MESSAGES.internalError, private: true }, private: true },
		});
	});

	it("refuses an unknown command without opening a form", async () => {
		const dispatcher = build([command({ name: "post", options: [text] })]);
		const result = await dispatcher.prepareForm({
			actor: actor(),
			command: "nope",
			args: {},
		});
		expect(result).toEqual({
			ready: false,
			refuse: { reply: { text: MESSAGES.unknownCommand, private: true }, private: true },
		});
	});

	it("still requires non-form options", async () => {
		const dispatcher = build([command({ name: "post", options: [where, text] })]);
		const result = await dispatcher.prepareForm({
			actor: actor(),
			command: "post",
			args: {},
		});
		expect(result).toEqual({
			ready: false,
			refuse: {
				reply: { text: 'Missing required option "where".', private: true },
				private: true,
			},
		});
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
