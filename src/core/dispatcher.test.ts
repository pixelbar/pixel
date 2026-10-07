import { describe, expect, it, vi } from "vitest";
import { actor, command, group, IDS, subcommand, subgroup } from "../testing/fixtures.ts";
import type { PlatformActor, Tier } from "./access.ts";
import { CapabilityRegistry } from "./capabilities.ts";
import type { CommandDefinition, ResolvedUser, SuggestFn } from "./command.ts";
import { Dispatcher, MESSAGES, validateArgs } from "./dispatcher.ts";
import { UserFacingError } from "./errors.ts";
import { IdentityService } from "./identity.ts";
import { type Logger, silentLogger } from "./logger.ts";
import type { ErrorReporter } from "./ports/error-reporter.ts";
import { RateLimiter } from "./rate-limit.ts";
import { CommandRegistry } from "./registry.ts";

const TIERS_BY_ID: Record<string, Tier> = {
	[IDS.admin]: "admin",
	[IDS.member]: "member",
	[IDS.friend]: "friend",
};

function recordingLogger() {
	const entries: { level: string; obj: Record<string, unknown> }[] = [];
	const make = (bindings: Record<string, unknown>): Logger => ({
		debug: (obj) => entries.push({ level: "debug", obj: { ...bindings, ...obj } }),
		info: (obj) => entries.push({ level: "info", obj: { ...bindings, ...obj } }),
		warn: (obj) => entries.push({ level: "warn", obj: { ...bindings, ...obj } }),
		error: (obj) => entries.push({ level: "error", obj: { ...bindings, ...obj } }),
		child: (more) => make({ ...bindings, ...more }),
	});
	return { logger: make({}), entries };
}

function setup(commands: CommandDefinition[], opts: { capacity?: number } = {}) {
	const registry = new CommandRegistry();
	registry.register({ name: "feat", commands });
	const { logger, entries } = recordingLogger();
	const reporter = {
		capture: vi.fn<ErrorReporter["capture"]>(),
		captureBackground: vi.fn<ErrorReporter["captureBackground"]>(),
		breadcrumb: vi.fn<ErrorReporter["breadcrumb"]>(),
	};
	const dispatcher = new Dispatcher({
		registry,
		identity: new IdentityService([
			{ name: "test", tierFor: async (a: PlatformActor) => TIERS_BY_ID[a.userId] ?? null },
		]),
		rateLimiter: new RateLimiter({
			capacity: opts.capacity ?? 100,
			refillPerSecond: 0,
			now: () => 0,
		}),
		logger,
		reporter,
	});
	return { dispatcher, entries, reporter };
}

const as = (userId: string, overrides: Partial<PlatformActor> = {}) =>
	actor({ userId, ...overrides });

describe("Dispatcher", () => {
	it("runs an allowed command and returns its reply", async () => {
		const { dispatcher } = setup([
			command({ name: "hi", handler: async () => ({ text: "hello" }) }),
		]);
		const result = await dispatcher.dispatch({ actor: as(IDS.guest), command: "hi", args: {} });
		expect(result).toEqual({ reply: { text: "hello" }, private: false });
	});

	it("replies privately to an unknown command", async () => {
		const { dispatcher } = setup([]);
		const result = await dispatcher.dispatch({ actor: as(IDS.guest), command: "nope", args: {} });
		expect(result).toEqual({
			reply: { text: MESSAGES.unknownCommand, private: true },
			private: true,
		});
	});

	describe("authorisation", () => {
		it.each([
			[IDS.guest, false],
			[IDS.friend, false],
			[IDS.member, true],
			[IDS.admin, true],
		])("member-only command for %s → allowed=%s", async (userId, allowed) => {
			const handler = vi.fn(async () => ({ text: "secret" }));
			const { dispatcher } = setup([
				command({ name: "m", access: { minTier: "member" }, handler }),
			]);
			const result = await dispatcher.dispatch({ actor: as(userId), command: "m", args: {} });
			expect(handler).toHaveBeenCalledTimes(allowed ? 1 : 0);
			expect(result.reply.text).toBe(allowed ? "secret" : MESSAGES.deniedTier);
		});

		it("never calls the handler when denied, and logs who was denied", async () => {
			const handler = vi.fn(async () => ({ text: "secret" }));
			const { dispatcher, entries } = setup([
				command({ name: "a", access: { minTier: "admin" }, handler }),
			]);
			const result = await dispatcher.dispatch({
				actor: as(IDS.member, { displayName: "Ada Lovelace", handle: "ada_l" }),
				command: "a",
				args: {},
			});

			expect(handler).not.toHaveBeenCalled();
			expect(result.private).toBe(true);
			const denial = entries.find((e) => e.obj.event === "command.denied");
			expect(denial?.obj).toMatchObject({
				user: `discord:${IDS.member}`,
				userName: "Ada Lovelace",
				userHandle: "ada_l",
				reason: "tier",
				tier: "member",
				required: "admin",
			});
			expect(entries.some((e) => e.obj.event === "command.executed")).toBe(false);
		});

		it("denies commands used in a disallowed context", async () => {
			const handler = vi.fn(async () => ({ text: "x" }));
			const { dispatcher } = setup([
				command({ name: "d", access: { minTier: "guest", contexts: ["dm"] }, handler }),
			]);
			const result = await dispatcher.dispatch({
				actor: as(IDS.admin, { chat: "group" }),
				command: "d",
				args: {},
			});
			expect(handler).not.toHaveBeenCalled();
			expect(result.reply.text).toBe(MESSAGES.deniedContext);
		});

		it("does not trust the display name", async () => {
			const handler = vi.fn(async () => ({ text: "x" }));
			const { dispatcher } = setup([command({ name: "a", access: { minTier: "admin" }, handler })]);
			await dispatcher.dispatch({
				actor: as(IDS.guest, { displayName: IDS.admin }),
				command: "a",
				args: {},
			});
			expect(handler).not.toHaveBeenCalled();
		});

		it("logs every executed command as an action with who did it", async () => {
			const { dispatcher, entries } = setup([command({ name: "a", access: { minTier: "admin" } })]);
			await dispatcher.dispatch({
				actor: as(IDS.admin, { displayName: "Grace", handle: "grace_h" }),
				command: "a",
				args: {},
			});
			const action = entries.find((e) => e.obj.event === "command.executed");
			expect(action?.level).toBe("info");
			expect(action?.obj).toMatchObject({
				command: "a",
				outcome: "ok",
				tier: "admin",
				user: `discord:${IDS.admin}`,
				userName: "Grace",
				userHandle: "grace_h",
			});
			expect(action?.obj.durationMs).toEqual(expect.any(Number));
		});

		it("passes only commands the caller may use to the handler", async () => {
			let seen: string[] = [];
			const { dispatcher } = setup([
				command({
					name: "help",
					handler: async (ctx) => {
						seen = ctx.availableCommands.map((c) => c.name);
						return {};
					},
				}),
				command({ name: "members-only", access: { minTier: "member" } }),
				command({ name: "admins-only", access: { minTier: "admin" } }),
			]);
			await dispatcher.dispatch({ actor: as(IDS.member), command: "help", args: {} });
			expect(seen).toEqual(["help", "members-only"]);
		});
	});

	it("rate limits per user", async () => {
		const handler = vi.fn(async () => ({ text: "ok" }));
		const { dispatcher } = setup([command({ name: "x", handler })], { capacity: 1 });
		await dispatcher.dispatch({ actor: as(IDS.guest), command: "x", args: {} });
		const limited = await dispatcher.dispatch({ actor: as(IDS.guest), command: "x", args: {} });
		const other = await dispatcher.dispatch({ actor: as(IDS.member), command: "x", args: {} });
		expect(limited.reply.text).toBe(MESSAGES.rateLimited);
		expect(other.reply.text).toBe("ok");
		expect(handler).toHaveBeenCalledTimes(2);
	});

	describe("visibility", () => {
		it("uses the command default", async () => {
			const { dispatcher } = setup([command({ name: "p", private: true })]);
			expect(
				(await dispatcher.dispatch({ actor: as(IDS.guest), command: "p", args: {} })).private,
			).toBe(true);
			expect(dispatcher.defaultPrivacy("p")).toBe(true);
		});

		it("defaults to public, including for unknown commands", () => {
			const { dispatcher } = setup([command({ name: "p" })]);
			expect(dispatcher.defaultPrivacy("p")).toBe(false);
			expect(dispatcher.defaultPrivacy("missing")).toBe(false);
		});

		it("lets the reply override the default", async () => {
			const { dispatcher } = setup([
				command({ name: "p", handler: async () => ({ text: "x", private: true }) }),
			]);
			expect(
				(await dispatcher.dispatch({ actor: as(IDS.guest), command: "p", args: {} })).private,
			).toBe(true);
		});
	});

	describe("placeholders", () => {
		const placeholder = { text: "Checking…" };

		it("sends the placeholder before the handler runs, with the command's visibility", async () => {
			const order: string[] = [];
			const { dispatcher } = setup([
				command({
					name: "slow",
					placeholder,
					handler: async () => {
						order.push("handler");
						return { text: "done" };
					},
				}),
			]);
			const onPending = vi.fn(async () => {
				order.push("pending");
			});
			const result = await dispatcher.dispatch(
				{ actor: as(IDS.guest), command: "slow", args: {} },
				{ onPending },
			);
			expect(onPending).toHaveBeenCalledWith({ reply: placeholder, private: false });
			expect(order).toEqual(["pending", "handler"]);
			expect(result.reply.text).toBe("done");
		});

		it("inherits private visibility from the command", async () => {
			const { dispatcher } = setup([command({ name: "p", placeholder, private: true })]);
			const onPending = vi.fn(async () => {});
			await dispatcher.dispatch({ actor: as(IDS.guest), command: "p", args: {} }, { onPending });
			expect(onPending).toHaveBeenCalledWith({ reply: placeholder, private: true });
		});

		it("is never sent to callers who are denied", async () => {
			const { dispatcher } = setup([
				command({ name: "a", placeholder, access: { minTier: "admin" } }),
			]);
			const onPending = vi.fn(async () => {});
			await dispatcher.dispatch({ actor: as(IDS.member), command: "a", args: {} }, { onPending });
			expect(onPending).not.toHaveBeenCalled();
		});

		it("is not sent when arguments are invalid", async () => {
			const { dispatcher } = setup([
				command({
					name: "args",
					placeholder,
					options: [{ name: "n", description: "n", type: "integer", required: true }],
				}),
			]);
			const onPending = vi.fn(async () => {});
			await dispatcher.dispatch({ actor: as(IDS.guest), command: "args", args: {} }, { onPending });
			expect(onPending).not.toHaveBeenCalled();
		});

		it("is skipped for commands without one", async () => {
			const { dispatcher } = setup([command({ name: "plain" })]);
			const onPending = vi.fn(async () => {});
			await dispatcher.dispatch(
				{ actor: as(IDS.guest), command: "plain", args: {} },
				{ onPending },
			);
			expect(onPending).not.toHaveBeenCalled();
		});

		it("turns a failure to show the placeholder into a reported internal error", async () => {
			const handler = vi.fn(async () => ({ text: "x" }));
			const { dispatcher, reporter } = setup([command({ name: "x", placeholder, handler })]);
			const result = await dispatcher.dispatch(
				{ actor: as(IDS.guest), command: "x", args: {} },
				{ onPending: async () => Promise.reject(new Error("discord down")) },
			);
			expect(handler).not.toHaveBeenCalled();
			expect(result.reply.text).toBe(MESSAGES.internalError);
			expect(reporter.capture).toHaveBeenCalled();
		});
	});

	describe("errors", () => {
		it("shows UserFacingError messages without reporting them", async () => {
			const { dispatcher, reporter, entries } = setup([
				command({
					name: "e",
					handler: async () => {
						throw new UserFacingError("Nope, try again.");
					},
				}),
			]);
			const result = await dispatcher.dispatch({ actor: as(IDS.guest), command: "e", args: {} });
			expect(result).toEqual({ reply: { text: "Nope, try again.", private: true }, private: true });
			expect(reporter.capture).not.toHaveBeenCalled();
			expect(entries.find((e) => e.obj.event === "command.executed")?.obj.outcome).toBe(
				"user_error",
			);
		});

		it("hides unexpected errors from the user and reports them", async () => {
			const boom = new Error("database password is hunter2");
			const { dispatcher, reporter, entries } = setup([
				command({
					name: "e",
					handler: async () => {
						throw boom;
					},
				}),
			]);
			const result = await dispatcher.dispatch({ actor: as(IDS.member), command: "e", args: {} });
			expect(entries.find((e) => e.obj.event === "command.executed")?.obj.outcome).toBe("error");
			expect(result.reply.text).toBe(MESSAGES.internalError);
			expect(result.private).toBe(true);
			expect(reporter.capture).toHaveBeenCalledWith(
				boom,
				expect.objectContaining({ command: "e", feature: "feat" }),
			);
		});
	});
});

describe("validateArgs", () => {
	const def = command({
		options: [
			{ name: "topic", description: "t", type: "string", required: true, choices: ["a", "b"] },
			{ name: "count", description: "c", type: "integer" },
			{ name: "loud", description: "l", type: "boolean" },
		],
	});

	it("accepts valid args and drops unknown ones", () => {
		expect(validateArgs(def, { topic: "a", count: 3, loud: true, extra: "x" })).toEqual({
			args: { topic: "a", count: 3, loud: true },
			users: {},
			channels: {},
		});
	});

	it.each([
		[{}, /Missing required option "topic"/],
		[{ topic: "c" }, /Invalid value for option "topic"/],
		[{ topic: 1 }, /Invalid value for option "topic"/],
		[{ topic: "a", count: 1.5 }, /Invalid value for option "count"/],
		[{ topic: "a", count: "1" }, /Invalid value for option "count"/],
		[{ topic: "a", loud: "yes" }, /Invalid value for option "loud"/],
	])("rejects %j", (args, message) => {
		expect(() => validateArgs(def, args)).toThrow(message);
	});
});

describe("subcommands", () => {
	function adminGroup(handler = vi.fn(async () => ({ text: "ran" }))) {
		return {
			handler,
			def: group({
				name: "admin",
				access: { minTier: "member" },
				subcommands: [
					subcommand({ name: "open", access: { minTier: "member" }, handler }),
					subcommand({ name: "closed", access: { minTier: "admin" }, private: true, handler }),
				],
			}),
		};
	}

	it("runs a subcommand and logs its full name", async () => {
		const { def, handler } = adminGroup();
		const { dispatcher, entries, reporter } = setup([def]);
		const result = await dispatcher.dispatch({
			actor: as(IDS.member),
			command: "admin",
			subcommand: "open",
			args: {},
		});
		expect(result.reply.text).toBe("ran");
		expect(handler).toHaveBeenCalledTimes(1);
		expect(entries.find((e) => e.obj.event === "command.executed")?.obj).toMatchObject({
			command: "admin open",
		});
		expect(reporter.capture).not.toHaveBeenCalled();
	});

	it("checks the subcommand's own access as well as the group's", async () => {
		const { def, handler } = adminGroup();
		const { dispatcher, entries } = setup([def]);
		const denied = await dispatcher.dispatch({
			actor: as(IDS.member),
			command: "admin",
			subcommand: "closed",
			args: {},
		});
		expect(denied.reply.text).toBe(MESSAGES.deniedTier);
		expect(handler).not.toHaveBeenCalled();
		expect(entries.find((e) => e.obj.event === "command.denied")?.obj).toMatchObject({
			command: "admin closed",
			required: "admin",
		});

		const outsider = await dispatcher.dispatch({
			actor: as(IDS.friend),
			command: "admin",
			subcommand: "open",
			args: {},
		});
		expect(outsider.reply.text).toBe(MESSAGES.deniedTier);
		expect(entries.filter((e) => e.obj.event === "command.denied").at(-1)?.obj).toMatchObject({
			required: "member",
		});
		expect(handler).not.toHaveBeenCalled();
	});

	it.each([
		["a missing subcommand", { command: "admin" }],
		["an unknown subcommand", { command: "admin", subcommand: "nope" }],
		["a subcommand on a plain command", { command: "plain", subcommand: "x" }],
	])("treats %s as an unknown command", async (_label, req) => {
		const { dispatcher } = setup([adminGroup().def, command({ name: "plain" })]);
		const result = await dispatcher.dispatch({ actor: as(IDS.admin), args: {}, ...req });
		expect(result.reply.text).toBe(MESSAGES.unknownCommand);
	});

	it("uses the subcommand's privacy", async () => {
		const { dispatcher } = setup([adminGroup().def, command({ name: "plain" })]);
		expect(dispatcher.defaultPrivacy("admin", "closed")).toBe(true);
		expect(dispatcher.defaultPrivacy("admin", "open")).toBe(false);
		expect(dispatcher.defaultPrivacy("admin")).toBe(false);
		expect(dispatcher.defaultPrivacy("plain", "x")).toBe(false);
		const result = await dispatcher.dispatch({
			actor: as(IDS.admin),
			command: "admin",
			subcommand: "closed",
			args: {},
		});
		expect(result.private).toBe(true);
	});

	it("lists only the subcommands the caller may use, by full name", async () => {
		let seen: string[] = [];
		const help = command({
			name: "help",
			handler: async (ctx) => {
				seen = ctx.availableCommands.map((c) => c.name);
				return {};
			},
		});
		const { dispatcher } = setup([help, adminGroup().def]);
		await dispatcher.dispatch({ actor: as(IDS.member), command: "help", args: {} });
		expect(seen).toEqual(["help", "admin open"]);
		await dispatcher.dispatch({ actor: as(IDS.admin), command: "help", args: {} });
		expect(seen).toEqual(["help", "admin open", "admin closed"]);
		await dispatcher.dispatch({ actor: as(IDS.guest), command: "help", args: {} });
		expect(seen).toEqual(["help"]);
	});

	it("passes resolved users to the handler", async () => {
		let users: Record<string, ResolvedUser> = {};
		const who = {
			id: IDS.friend,
			displayName: "Friend",
			handle: "friend_h",
			isBot: false,
		};
		const { dispatcher } = setup([
			group({
				name: "g",
				subcommands: [
					subcommand({
						name: "pick",
						options: [{ name: "who", description: "w", type: "user", required: true }],
						handler: async (ctx) => {
							users = { ...ctx.users };
							return {};
						},
					}),
				],
			}),
		]);
		await dispatcher.dispatch({
			actor: as(IDS.admin),
			command: "g",
			subcommand: "pick",
			args: { who: IDS.friend },
			users: { who },
		});
		expect(users).toEqual({ who });
	});
});

describe("user options", () => {
	const pick = (allowBots?: boolean) =>
		command({
			options: [
				{
					name: "who",
					description: "w",
					type: "user",
					required: true,
					...(allowBots === undefined ? {} : { allowBots }),
				},
			],
		});
	const human: ResolvedUser = { id: IDS.friend, displayName: "F", isBot: false };
	const bot: ResolvedUser = { id: IDS.guest, displayName: "B", isBot: true };

	it("accepts a resolved user and exposes the ID as the arg", () => {
		expect(validateArgs(pick(), { who: IDS.friend }, { who: human })).toEqual({
			args: { who: IDS.friend },
			users: { who: human },
			channels: {},
		});
	});

	it.each([
		["a non-string", { who: 5 }, { who: human }],
		["an unresolved user", { who: IDS.friend }, {}],
		["an ID that doesn't match the resolved user", { who: IDS.admin }, { who: human }],
	])("rejects %s", (_label, args, users) => {
		expect(() => validateArgs(pick(), args, users)).toThrow(/Invalid value for option "who"/);
	});

	it("refuses bots unless allowed", () => {
		expect(() => validateArgs(pick(), { who: IDS.guest }, { who: bot })).toThrow(/can't be a bot/);
		expect(() => validateArgs(pick(false), { who: IDS.guest }, { who: bot })).toThrow(
			/can't be a bot/,
		);
		expect(validateArgs(pick(true), { who: IDS.guest }, { who: bot }).users).toEqual({ who: bot });
	});
});

describe("subgroups", () => {
	function nested() {
		const handler = vi.fn(async () => ({ text: "ran" }));
		const def = group({
			name: "admin",
			access: { minTier: "member" },
			subcommands: [
				subcommand({ name: "plain", access: { minTier: "member" }, handler }),
				subgroup({
					name: "caps",
					access: { minTier: "member" },
					subcommands: [
						subcommand({ name: "grant", access: { minTier: "member" }, handler }),
						subcommand({ name: "revoke", access: { minTier: "admin" }, private: true, handler }),
					],
				}),
			],
		});
		return { def, handler };
	}

	it("runs a subcommand inside a subgroup and logs its full name", async () => {
		const { def, handler } = nested();
		const { dispatcher, entries } = setup([def]);
		const result = await dispatcher.dispatch({
			actor: as(IDS.member),
			command: "admin",
			subgroup: "caps",
			subcommand: "grant",
			args: {},
		});
		expect(result.reply.text).toBe("ran");
		expect(handler).toHaveBeenCalledTimes(1);
		expect(entries.find((e) => e.obj.event === "command.executed")?.obj).toMatchObject({
			command: "admin caps grant",
		});
	});

	it("checks the group, the subgroup and the subcommand", async () => {
		const { def, handler } = nested();
		const { dispatcher, entries } = setup([def]);
		const denied = await dispatcher.dispatch({
			actor: as(IDS.member),
			command: "admin",
			subgroup: "caps",
			subcommand: "revoke",
			args: {},
		});
		expect(denied.reply.text).toBe(MESSAGES.deniedTier);
		expect(entries.find((e) => e.obj.event === "command.denied")?.obj).toMatchObject({
			command: "admin caps revoke",
			required: "admin",
		});
		const outsider = await dispatcher.dispatch({
			actor: as(IDS.friend),
			command: "admin",
			subgroup: "caps",
			subcommand: "grant",
			args: {},
		});
		expect(outsider.reply.text).toBe(MESSAGES.deniedTier);
		expect(handler).not.toHaveBeenCalled();
	});

	it("denies on the subgroup's own access", async () => {
		const handler = vi.fn(async () => ({}));
		const { dispatcher } = setup([
			group({
				name: "g",
				subcommands: [
					subgroup({
						name: "s",
						access: { minTier: "admin" },
						subcommands: [subcommand({ name: "x", access: { minTier: "admin" }, handler })],
					}),
				],
			}),
		]);
		const result = await dispatcher.dispatch({
			actor: as(IDS.member),
			command: "g",
			subgroup: "s",
			subcommand: "x",
			args: {},
		});
		expect(result.reply.text).toBe(MESSAGES.deniedTier);
		expect(handler).not.toHaveBeenCalled();
	});

	it.each([
		["a subgroup without its subcommand", { command: "admin", subgroup: "caps" }],
		["an unknown subgroup", { command: "admin", subgroup: "nope", subcommand: "grant" }],
		[
			"an unknown subcommand in a subgroup",
			{ command: "admin", subgroup: "caps", subcommand: "nope" },
		],
		["a subgroup's name used as a subcommand", { command: "admin", subcommand: "caps" }],
		[
			"a subcommand's name used as a subgroup",
			{ command: "admin", subgroup: "plain", subcommand: "grant" },
		],
		["a subgroup on a plain command", { command: "p", subgroup: "caps", subcommand: "grant" }],
	])("treats %s as an unknown command", async (_label, req) => {
		const { dispatcher } = setup([nested().def, command({ name: "p" })]);
		const result = await dispatcher.dispatch({ actor: as(IDS.admin), args: {}, ...req });
		expect(result.reply.text).toBe(MESSAGES.unknownCommand);
	});

	it("uses the subcommand's privacy", async () => {
		const { dispatcher } = setup([nested().def]);
		expect(dispatcher.defaultPrivacy("admin", "revoke", "caps")).toBe(true);
		expect(dispatcher.defaultPrivacy("admin", "grant", "caps")).toBe(false);
		expect(dispatcher.defaultPrivacy("admin", "revoke")).toBe(false);
	});

	it("lists subgroup subcommands by full name, only to people who may use them", async () => {
		let seen: string[] = [];
		const help = command({
			name: "help",
			handler: async (ctx) => {
				seen = ctx.availableCommands.map((c) => c.name);
				return {};
			},
		});
		const { dispatcher } = setup([help, nested().def]);
		await dispatcher.dispatch({ actor: as(IDS.member), command: "help", args: {} });
		expect(seen).toEqual(["help", "admin plain", "admin caps grant"]);
		await dispatcher.dispatch({ actor: as(IDS.admin), command: "help", args: {} });
		expect(seen).toEqual(["help", "admin plain", "admin caps grant", "admin caps revoke"]);
		await dispatcher.dispatch({ actor: as(IDS.friend), command: "help", args: {} });
		expect(seen).toEqual(["help"]);
	});
});

describe("capabilities", () => {
	const GRANTED: Record<string, string[]> = {
		[IDS.admin]: ["door"],
		[IDS.member]: ["door"],
		[IDS.friend]: ["door"],
		[IDS.guest]: ["door"],
	};

	function capabilitySetup(commands: CommandDefinition[], grants = GRANTED) {
		const capabilities = new CapabilityRegistry([{ name: "door", description: "Open the door" }]);
		const registry = new CommandRegistry({ capabilities });
		registry.register({ name: "feat", commands });
		const { logger, entries } = recordingLogger();
		const dispatcher = new Dispatcher({
			registry,
			identity: new IdentityService(
				[{ name: "test", tierFor: async (a: PlatformActor) => TIERS_BY_ID[a.userId] ?? null }],
				[{ name: "test", capabilitiesFor: async (a: PlatformActor) => grants[a.userId] ?? [] }],
			),
			rateLimiter: new RateLimiter({ capacity: 100, refillPerSecond: 0, now: () => 0 }),
			logger,
			reporter: {
				capture: vi.fn(),
				captureBackground: vi.fn(),
				breadcrumb: vi.fn(),
			},
		});
		return { dispatcher, entries };
	}

	const open = (handler = vi.fn(async () => ({ text: "opened" }))) =>
		command({ name: "open", access: { minTier: "member", capability: "door" }, handler });

	it.each([
		["a member who has it", IDS.member, GRANTED, true],
		["a member without it", IDS.member, {}, false],
		["a friend below the tier, even with it", IDS.friend, GRANTED, false],
		["a guest, even with it", IDS.guest, GRANTED, false],
		["an admin without it: admin doesn't imply it", IDS.admin, {}, false],
		["an admin who granted themselves it", IDS.admin, GRANTED, true],
	])("%s → allowed=%s", async (_label, userId, grants, allowed) => {
		const handler = vi.fn(async () => ({ text: "opened" }));
		const { dispatcher } = capabilitySetup([open(handler)], grants);
		const result = await dispatcher.dispatch({ actor: as(userId), command: "open", args: {} });
		expect(handler).toHaveBeenCalledTimes(allowed ? 1 : 0);
		expect(result.reply.text).toBe(allowed ? "opened" : MESSAGES.deniedTier);
	});

	it("refuses generically, and logs the capability so the real reason is visible", async () => {
		const { dispatcher, entries } = capabilitySetup([open()], {});
		const result = await dispatcher.dispatch({
			actor: as(IDS.member, { displayName: "Ada", handle: "ada_l" }),
			command: "open",
			args: {},
		});
		expect(result.private).toBe(true);
		expect(result.reply.text).toBe("You don't have access to this command.");
		expect(entries.find((e) => e.obj.event === "command.denied")?.obj).toMatchObject({
			reason: "capability",
			capability: "door",
			required: "member",
			user: `discord:${IDS.member}`,
			userName: "Ada",
		});
		expect(entries.some((e) => e.obj.event === "command.executed")).toBe(false);
	});

	it("doesn't add a capability field to ordinary denials", async () => {
		const { dispatcher, entries } = capabilitySetup([
			command({ name: "a", access: { minTier: "admin" } }),
		]);
		await dispatcher.dispatch({ actor: as(IDS.member), command: "a", args: {} });
		expect(entries.find((e) => e.obj.event === "command.denied")?.obj).not.toHaveProperty(
			"capability",
		);
	});

	it("takes effect straight away when someone is demoted or loses the grant", async () => {
		const grants: Record<string, string[]> = { [IDS.member]: ["door"] };
		const { dispatcher } = capabilitySetup([open()], grants);
		const run = () => dispatcher.dispatch({ actor: as(IDS.member), command: "open", args: {} });
		expect((await run()).reply.text).toBe("opened");
		grants[IDS.member] = [];
		expect((await run()).reply.text).toBe(MESSAGES.deniedTier);
	});

	it("is enforced on subcommands, and the parent's gate still applies", async () => {
		const handler = vi.fn(async () => ({ text: "ran" }));
		const { dispatcher } = capabilitySetup([
			group({
				name: "doors",
				access: { minTier: "member" },
				subcommands: [
					subcommand({ name: "open", access: { minTier: "member", capability: "door" }, handler }),
					subcommand({ name: "list", access: { minTier: "member" }, handler }),
				],
			}),
		]);
		const call = (userId: string, sub: string) =>
			dispatcher.dispatch({ actor: as(userId), command: "doors", subcommand: sub, args: {} });
		expect((await call(IDS.member, "open")).reply.text).toBe("ran");
		expect((await call(IDS.friend, "open")).reply.text).toBe(MESSAGES.deniedTier);

		const { dispatcher: without } = capabilitySetup(
			[
				group({
					name: "doors",
					subcommands: [
						subcommand({
							name: "open",
							access: { minTier: "member", capability: "door" },
							handler,
						}),
					],
				}),
			],
			{},
		);
		const denied = await without.dispatch({
			actor: as(IDS.member),
			command: "doors",
			subcommand: "open",
			args: {},
		});
		expect(denied.reply.text).toBe(MESSAGES.deniedTier);
	});

	it("hides the command from /help for people who lack the capability", async () => {
		let seen: string[] = [];
		const help = command({
			name: "help",
			handler: async (ctx) => {
				seen = ctx.availableCommands.map((c) => c.name);
				return {};
			},
		});
		const grants: Record<string, string[]> = { [IDS.member]: ["door"] };
		const { dispatcher } = capabilitySetup([help, open()], grants);
		await dispatcher.dispatch({ actor: as(IDS.member), command: "help", args: {} });
		expect(seen).toEqual(["help", "open"]);
		await dispatcher.dispatch({ actor: as(IDS.admin), command: "help", args: {} });
		expect(seen).toEqual(["help"]);
		await dispatcher.dispatch({ actor: as(IDS.friend), command: "help", args: {} });
		expect(seen).toEqual(["help"]);
	});
});

describe("suggest", () => {
	const device = (suggest: SuggestFn, extra: object = {}) =>
		({ name: "device", description: "d", type: "string", suggest, ...extra }) as const;
	const pick = (suggest: SuggestFn, access: { minTier: Tier } = { minTier: "member" }) =>
		command({ name: "ha", access, options: [device(suggest)] });
	const ask = (
		dispatcher: Dispatcher,
		userId: string,
		more: Partial<Parameters<Dispatcher["suggest"]>[0]> = {},
	) =>
		dispatcher.suggest({
			actor: as(userId),
			command: "ha",
			option: "device",
			typed: "",
			args: {},
			...more,
		});

	function suggestSetup(
		commands: CommandDefinition[],
		deps: Partial<ConstructorParameters<typeof Dispatcher>[0]> = {},
	) {
		const registry = new CommandRegistry();
		registry.register({ name: "feat", commands });
		const { logger, entries } = recordingLogger();
		const reporter = {
			capture: vi.fn<ErrorReporter["capture"]>(),
			captureBackground: vi.fn<ErrorReporter["captureBackground"]>(),
			breadcrumb: vi.fn<ErrorReporter["breadcrumb"]>(),
		};
		const dispatcher = new Dispatcher({
			registry,
			identity: new IdentityService([
				{ name: "test", tierFor: async (a: PlatformActor) => TIERS_BY_ID[a.userId] ?? null },
			]),
			rateLimiter: new RateLimiter({ capacity: 100, refillPerSecond: 0, now: () => 0 }),
			logger,
			reporter,
			...deps,
		});
		return { dispatcher, entries, reporter };
	}

	it("gives a permitted caller the suggestions, with what was typed, the other options and who's asking", async () => {
		const fn = vi.fn<SuggestFn>(async () => [{ name: "Front door", value: "front-door" }]);
		const { dispatcher } = suggestSetup([pick(fn)]);
		const result = await ask(dispatcher, IDS.member, { typed: "fro", args: { other: "x" } });
		expect(result).toEqual([{ name: "Front door", value: "front-door" }]);
		expect(fn).toHaveBeenCalledWith(
			expect.objectContaining({
				typed: "fro",
				args: { other: "x" },
				principal: expect.objectContaining({ userId: IDS.member, tier: "member" }),
			}),
		);
	});

	it("lets suggestions depend on the other options", async () => {
		const actionsFor: Record<string, string[]> = { door: ["lock", "unlock"], lamp: ["on", "off"] };
		const { dispatcher } = suggestSetup([
			command({
				name: "ha",
				access: { minTier: "member" },
				options: [
					{ name: "device", description: "d", type: "string" },
					device(
						async ({ args }) =>
							(actionsFor[String(args.device)] ?? []).map((a) => ({ name: a, value: a })),
						{
							name: "action",
						},
					),
				],
			}),
		]);
		const result = await dispatcher.suggest({
			actor: as(IDS.member),
			command: "ha",
			option: "action",
			typed: "",
			args: { device: "door" },
		});
		expect(result.map((s) => s.value)).toEqual(["lock", "unlock"]);
	});

	describe("limits what it returns", () => {
		it("caps the list at 25", async () => {
			const many = Array.from({ length: 40 }, (_, i) => ({ name: `d${i}`, value: `d${i}` }));
			const { dispatcher } = suggestSetup([pick(async () => many)]);
			expect(await ask(dispatcher, IDS.member)).toHaveLength(25);
		});

		it("shortens names to 100 characters and tidies them", async () => {
			const { dispatcher } = suggestSetup([
				pick(async () => [
					{ name: "x".repeat(150), value: "a" },
					{ name: "Line\nbreak\u0000 and\ttab", value: "b" },
				]),
			]);
			const [long, tidy] = await ask(dispatcher, IDS.member);
			expect(long?.name).toBe("x".repeat(100));
			expect(tidy?.name).toBe("Line break and tab");
		});

		it("drops, rather than cuts, a value that is too long, empty or the wrong type", async () => {
			const { dispatcher } = suggestSetup([
				pick(async () => [
					{ name: "long", value: "x".repeat(101) },
					{ name: "empty", value: "" },
					{ name: "number", value: 5 },
					{ name: "   ", value: "blank-name" },
					{ name: "fine", value: "ok" },
				]),
			]);
			expect(await ask(dispatcher, IDS.member)).toEqual([{ name: "fine", value: "ok" }]);
		});

		it("only keeps safe integers for an integer option", async () => {
			const integer = command({
				name: "ha",
				access: { minTier: "member" },
				options: [
					{
						name: "device",
						description: "d",
						type: "integer",
						suggest: async () => [
							{ name: "one", value: 1 },
							{ name: "half", value: 1.5 },
							{ name: "huge", value: 2 ** 60 },
							{ name: "text", value: "2" },
						],
					},
				],
			});
			const { dispatcher } = suggestSetup([integer]);
			expect(await ask(dispatcher, IDS.member)).toEqual([{ name: "one", value: 1 }]);
		});
	});

	describe("is authorised like the command", () => {
		it.each([
			["a guest", IDS.guest],
			["a friend", IDS.friend],
		])("gives %s nothing, calls nothing, and logs the denial", async (_label, userId) => {
			const fn = vi.fn<SuggestFn>(async () => [{ name: "secret", value: "secret" }]);
			const { dispatcher, entries } = suggestSetup([pick(fn)]);
			expect(await ask(dispatcher, userId)).toEqual([]);
			expect(fn).not.toHaveBeenCalled();
			expect(entries.find((e) => e.obj.event === "command.suggest_denied")?.obj).toMatchObject({
				reason: "tier",
				required: "member",
				user: `discord:${userId}`,
			});
		});

		it("checks the group, the subgroup and the subcommand", async () => {
			const fn = vi.fn<SuggestFn>(async () => [{ name: "x", value: "x" }]);
			const tree = group({
				name: "ha",
				access: { minTier: "friend" },
				subcommands: [
					subgroup({
						name: "sg",
						access: { minTier: "member" },
						subcommands: [
							subcommand({ name: "run", access: { minTier: "admin" }, options: [device(fn)] }),
						],
					}),
				],
			});
			const { dispatcher } = suggestSetup([tree]);
			const nested = { subgroup: "sg", subcommand: "run" };
			expect(await ask(dispatcher, IDS.member, nested)).toEqual([]);
			expect(await ask(dispatcher, IDS.admin, nested)).toHaveLength(1);
		});

		it("applies a capability requirement, and never lets a guest through", async () => {
			const capabilities = new CapabilityRegistry([{ name: "door", description: "Open the door" }]);
			const registry = new CommandRegistry({ capabilities });
			const fn = vi.fn<SuggestFn>(async () => [{ name: "x", value: "x" }]);
			registry.register({
				name: "feat",
				commands: [pick(fn, { minTier: "member", capability: "door" } as never)],
			});
			const granted: Record<string, string[]> = { [IDS.member]: ["door"], [IDS.guest]: ["door"] };
			const dispatcher = new Dispatcher({
				registry,
				identity: new IdentityService(
					[{ name: "t", tierFor: async (a: PlatformActor) => TIERS_BY_ID[a.userId] ?? null }],
					[{ name: "c", capabilitiesFor: async (a: PlatformActor) => granted[a.userId] ?? [] }],
				),
				rateLimiter: new RateLimiter({ capacity: 100, refillPerSecond: 0 }),
				logger: recordingLogger().logger,
				reporter: { capture: vi.fn(), captureBackground: vi.fn(), breadcrumb: vi.fn() },
			});
			expect(await ask(dispatcher, IDS.member)).toHaveLength(1);
			expect(await ask(dispatcher, IDS.admin)).toEqual([]);
			expect(await ask(dispatcher, IDS.guest)).toEqual([]);
		});
	});

	it.each([
		["an unknown command", { command: "nope" }],
		["an option that doesn't exist", { option: "nope" }],
		["a subcommand on a plain command", { subcommand: "run" }],
	])("returns nothing for %s", async (_label, more) => {
		const fn = vi.fn<SuggestFn>(async () => [{ name: "x", value: "x" }]);
		const { dispatcher } = suggestSetup([pick(fn)]);
		expect(await ask(dispatcher, IDS.admin, more)).toEqual([]);
		expect(fn).not.toHaveBeenCalled();
	});

	it("returns nothing for an option without suggestions", async () => {
		const plain = command({
			name: "ha",
			access: { minTier: "member" },
			options: [{ name: "device", description: "d", type: "string" }],
		});
		const { dispatcher } = suggestSetup([plain]);
		expect(await ask(dispatcher, IDS.admin)).toEqual([]);
	});

	describe("rate limiting", () => {
		it("has its own limit, so it can't use up the budget for real commands", async () => {
			const fn = vi.fn<SuggestFn>(async () => [{ name: "x", value: "x" }]);
			const { dispatcher, entries } = suggestSetup([pick(fn), command({ name: "ping" })], {
				rateLimiter: new RateLimiter({ capacity: 1, refillPerSecond: 0, now: () => 0 }),
				suggestRateLimiter: new RateLimiter({ capacity: 2, refillPerSecond: 0, now: () => 0 }),
			});
			expect(await ask(dispatcher, IDS.admin)).toHaveLength(1);
			expect(await ask(dispatcher, IDS.admin)).toHaveLength(1);
			expect(await ask(dispatcher, IDS.admin)).toEqual([]);
			expect(fn).toHaveBeenCalledTimes(2);
			expect(entries.some((e) => e.obj.event === "command.suggest_rate_limited")).toBe(true);
			// The command's own budget is untouched by all that typing.
			const result = await dispatcher.dispatch({ actor: as(IDS.admin), command: "ping", args: {} });
			expect(result.reply.text).toBe("ok");
		});

		it("limits each person separately", async () => {
			const { dispatcher } = suggestSetup([pick(async () => [{ name: "x", value: "x" }])], {
				suggestRateLimiter: new RateLimiter({ capacity: 1, refillPerSecond: 0, now: () => 0 }),
			});
			expect(await ask(dispatcher, IDS.admin)).toHaveLength(1);
			expect(await ask(dispatcher, IDS.admin)).toEqual([]);
			expect(await ask(dispatcher, IDS.member)).toHaveLength(1);
		});

		it("has a sensible default limit", async () => {
			const { dispatcher } = suggestSetup([pick(async () => [{ name: "x", value: "x" }])]);
			for (let i = 0; i < 5; i++) expect(await ask(dispatcher, IDS.admin)).toHaveLength(1);
		});
	});

	describe("when the suggestions go wrong", () => {
		it("gives an empty list, logs and reports a failure", async () => {
			const boom = new Error("HA exploded");
			const { dispatcher, entries, reporter } = suggestSetup([
				pick(async () => {
					throw boom;
				}),
			]);
			expect(await ask(dispatcher, IDS.member)).toEqual([]);
			expect(entries.find((e) => e.obj.event === "command.suggest_failed")).toBeDefined();
			expect(reporter.capture).toHaveBeenCalledWith(
				boom,
				expect.objectContaining({ command: "ha", feature: "feat" }),
			);
		});

		it("gives an empty list, quietly, for an error meant for the user", async () => {
			const { dispatcher, entries, reporter } = suggestSetup([
				pick(async () => {
					throw new UserFacingError("not now");
				}),
			]);
			expect(await ask(dispatcher, IDS.member)).toEqual([]);
			expect(reporter.capture).not.toHaveBeenCalled();
			expect(entries.some((e) => e.obj.event === "command.suggest_failed")).toBe(false);
		});

		it("gives an empty list when it takes too long, and logs that", async () => {
			const never = new Promise<never>(() => {});
			const { dispatcher, entries, reporter } = suggestSetup([pick(() => never)], {
				suggestTimeoutMs: 20,
			});
			const started = Date.now();
			expect(await ask(dispatcher, IDS.member)).toEqual([]);
			expect(Date.now() - started).toBeLessThan(1000);
			expect(entries.find((e) => e.obj.event === "command.suggest_timeout")).toBeDefined();
			expect(reporter.capture).not.toHaveBeenCalled();
		});

		it("doesn't break the command itself", async () => {
			const handler = vi.fn(async () => ({ text: "ran" }));
			const { dispatcher } = suggestSetup([
				command({
					name: "ha",
					access: { minTier: "member" },
					options: [
						device(async () => {
							throw new Error("boom");
						}),
					],
					handler,
				}),
			]);
			expect(await ask(dispatcher, IDS.member)).toEqual([]);
			const result = await dispatcher.dispatch({
				actor: as(IDS.member),
				command: "ha",
				args: { device: "front-door" },
			});
			expect(result.reply.text).toBe("ran");
		});
	});

	it("never logs what was typed or the other options", async () => {
		const { dispatcher, entries } = suggestSetup([
			pick(async () => {
				throw new Error("boom");
			}),
		]);
		await ask(dispatcher, IDS.member, {
			typed: "hunter2-secret",
			args: { other: "private-value" },
		});
		await ask(dispatcher, IDS.guest, { typed: "hunter2-secret" });
		const text = JSON.stringify(entries);
		expect(text).not.toContain("hunter2-secret");
		expect(text).not.toContain("private-value");
	});

	it("is only suggestions: a value that wasn't suggested is still validated by the command", () => {
		const def = command({ options: [device(async () => [])] });
		expect(validateArgs(def, { device: "anything-typed-by-hand" }).args).toEqual({
			device: "anything-typed-by-hand",
		});
	});
});

describe("tracing what runs to the person who ran it", () => {
	type Context = Parameters<NonNullable<ErrorReporter["withContext"]>>[0];

	/** A reporter whose withContext records what it was given, and whether work was running inside it. */
	function scoped() {
		const seen: { command: string; feature: string; userId: string; tier: string }[] = [];
		let inside = false;
		const withContext: NonNullable<ErrorReporter["withContext"]> = async (
			context: Context,
			run,
		) => {
			seen.push({
				command: context.command,
				feature: context.feature,
				userId: context.principal.userId,
				tier: context.principal.tier,
			});
			inside = true;
			try {
				return await run();
			} finally {
				inside = false;
			}
		};
		return { seen, withContext, isInside: () => inside };
	}

	function build(
		commands: CommandDefinition[],
		withContext?: ErrorReporter["withContext"],
		capture: ErrorReporter["capture"] = vi.fn(),
	) {
		const registry = new CommandRegistry();
		registry.register({ name: "feat", commands });
		const reporter: ErrorReporter = {
			capture,
			captureBackground: vi.fn(),
			breadcrumb: vi.fn(),
			...(withContext ? { withContext } : {}),
		};
		return new Dispatcher({
			registry,
			identity: new IdentityService([
				{ name: "test", tierFor: async (a: PlatformActor) => TIERS_BY_ID[a.userId] ?? null },
			]),
			rateLimiter: new RateLimiter({ capacity: 100, refillPerSecond: 0, now: () => 0 }),
			logger: silentLogger,
			reporter,
		});
	}

	it("runs the handler inside the person's context, with the full command name", async () => {
		const { seen, withContext, isInside } = scoped();
		let insideHandler = false;
		const dispatcher = build(
			[
				group({
					name: "ha",
					subcommands: [
						subcommand({
							name: "set",
							access: { minTier: "member" },
							handler: async () => {
								insideHandler = isInside();
								return { text: "done" };
							},
						}),
					],
				}),
			],
			withContext,
		);
		const result = await dispatcher.dispatch({
			actor: as(IDS.member),
			command: "ha",
			subcommand: "set",
			args: {},
		});
		expect(result.reply.text).toBe("done");
		expect(insideHandler).toBe(true);
		expect(seen).toEqual([
			{ command: "ha set", feature: "feat", userId: IDS.member, tier: "member" },
		]);
	});

	it("doesn't open a context for a command that is refused, or isn't found", async () => {
		const { seen, withContext } = scoped();
		const dispatcher = build(
			[command({ name: "secret", access: { minTier: "admin" } })],
			withContext,
		);
		await dispatcher.dispatch({ actor: as(IDS.guest), command: "secret", args: {} });
		await dispatcher.dispatch({ actor: as(IDS.guest), command: "nope", args: {} });
		expect(seen).toEqual([]);
	});

	it("runs suggestions inside the person's context too", async () => {
		const { seen, withContext, isInside } = scoped();
		let insideSuggest = false;
		const dispatcher = build(
			[
				command({
					name: "ha",
					access: { minTier: "member" },
					options: [
						{
							name: "device",
							description: "d",
							type: "string",
							suggest: async () => {
								insideSuggest = isInside();
								return [{ name: "lamp", value: "lamp" }];
							},
						},
					],
				}),
			],
			withContext,
		);
		const out = await dispatcher.suggest({
			actor: as(IDS.member),
			command: "ha",
			option: "device",
			typed: "",
			args: {},
		});
		expect(out).toEqual([{ name: "lamp", value: "lamp" }]);
		expect(insideSuggest).toBe(true);
		expect(seen).toEqual([{ command: "ha", feature: "feat", userId: IDS.member, tier: "member" }]);
	});

	it("still reports a failing command with the person, outside that context", async () => {
		const { withContext } = scoped();
		const capture = vi.fn<ErrorReporter["capture"]>();
		const dispatcher = build(
			[
				command({
					name: "boom",
					handler: async () => {
						throw new Error("bug");
					},
				}),
			],
			withContext,
			capture,
		);
		const result = await dispatcher.dispatch({ actor: as(IDS.member), command: "boom", args: {} });
		expect(result.reply.text).toBe(MESSAGES.internalError);
		expect(capture).toHaveBeenCalledTimes(1);
		expect(capture.mock.calls[0]?.[1]).toMatchObject({
			command: "boom",
			principal: { userId: IDS.member },
		});
	});

	it("works as before with a reporter that can't scope", async () => {
		const dispatcher = build([command({ name: "hi", handler: async () => ({ text: "hello" }) })]);
		const result = await dispatcher.dispatch({ actor: as(IDS.guest), command: "hi", args: {} });
		expect(result.reply.text).toBe("hello");
	});
});
