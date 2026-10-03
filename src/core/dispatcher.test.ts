import { describe, expect, it, vi } from "vitest";
import { actor, command, group, IDS, subcommand, subgroup } from "../testing/fixtures.ts";
import type { PlatformActor, Tier } from "./access.ts";
import { CapabilityRegistry } from "./capabilities.ts";
import type { CommandDefinition, ResolvedUser } from "./command.ts";
import { Dispatcher, MESSAGES, validateArgs } from "./dispatcher.ts";
import { UserFacingError } from "./errors.ts";
import { IdentityService } from "./identity.ts";
import type { Logger } from "./logger.ts";
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
