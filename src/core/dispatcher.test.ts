import { describe, expect, it, vi } from "vitest";
import { actor, command, IDS } from "../testing/fixtures.ts";
import type { PlatformActor, Tier } from "./access.ts";
import type { CommandDefinition } from "./command.ts";
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
	const reporter = { capture: vi.fn<ErrorReporter["capture"]>() };
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
			topic: "a",
			count: 3,
			loud: true,
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
