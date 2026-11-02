import { describe, expect, it, vi } from "vitest";
import { actor, command, IDS } from "../testing/fixtures.ts";
import type { PlatformActor, Tier } from "./access.ts";
import { CapabilityRegistry } from "./capabilities.ts";
import { Dispatcher, MESSAGES } from "./dispatcher.ts";
import { UserFacingError } from "./errors.ts";
import { IdentityService } from "./identity.ts";
import type { Logger } from "./logger.ts";
import type { ErrorReporter } from "./ports/error-reporter.ts";
import { RateLimiter } from "./rate-limit.ts";
import { CommandRegistry, RegistryError } from "./registry.ts";
import type { ActionDefinition } from "./ui.ts";

const TIERS: Record<string, Tier> = {
	[IDS.admin]: "admin",
	[IDS.member]: "member",
	[IDS.friend]: "friend",
};

const DOOR = new CapabilityRegistry([{ name: "door", description: "Open the door" }]);

function action(overrides: Partial<ActionDefinition> = {}): ActionDefinition {
	return {
		name: "feat.go",
		access: { minTier: "member" },
		handler: async () => ({ reply: { text: "done" } }),
		...overrides,
	};
}

function recordingLogger() {
	const entries: Record<string, unknown>[] = [];
	const make = (bindings: Record<string, unknown>): Logger => ({
		debug: (obj) => entries.push({ ...bindings, ...obj }),
		info: (obj) => entries.push({ ...bindings, ...obj }),
		warn: (obj) => entries.push({ ...bindings, ...obj }),
		error: (obj) => entries.push({ ...bindings, ...obj }),
		child: (more) => make({ ...bindings, ...more }),
	});
	return { logger: make({}), entries };
}

function setup(
	actions: ActionDefinition[],
	opts: { capacity?: number; grants?: Record<string, string[]>; withContext?: boolean } = {},
) {
	const registry = new CommandRegistry({ capabilities: DOOR });
	registry.register({ name: "feat", actions });
	const { logger, entries } = recordingLogger();
	const contexts: unknown[] = [];
	const reporter: ErrorReporter = {
		capture: vi.fn(),
		captureBackground: vi.fn(),
		breadcrumb: vi.fn(),
		...(opts.withContext
			? {
					withContext: async <T>(context: unknown, work: () => Promise<T>) => {
						contexts.push(context);
						return work();
					},
				}
			: {}),
	};
	const dispatcher = new Dispatcher({
		registry,
		identity: new IdentityService(
			[{ name: "test", tierFor: async (a: PlatformActor) => TIERS[a.userId] ?? null }],
			[
				{
					name: "test",
					capabilitiesFor: async (a: PlatformActor) => opts.grants?.[a.userId] ?? [],
				},
			],
		),
		rateLimiter: new RateLimiter({
			capacity: opts.capacity ?? 100,
			refillPerSecond: 0,
			now: () => 0,
		}),
		logger,
		reporter,
	});
	return { dispatcher, entries, reporter, contexts };
}

const as = (userId: string) => actor({ userId });

describe("registering actions", () => {
	const register = (definition: ActionDefinition) =>
		new CommandRegistry({ capabilities: DOOR }).register({ name: "feat", actions: [definition] });

	it("accepts a well-formed action and finds it by name", () => {
		const registry = new CommandRegistry({ capabilities: DOOR });
		registry.register({ name: "feat", actions: [action()] });
		expect(registry.action("feat.go")?.feature).toBe("feat");
		expect(registry.action("feat.nope")).toBeUndefined();
	});

	it.each(["go", "Feat.go", "feat..go", "feat.go.", "feat go", `feat.${"x".repeat(60)}`])(
		"refuses the name %j",
		(name) => {
			expect(() => register(action({ name }))).toThrow(RegistryError);
		},
	);

	it("refuses an action without a valid minTier, because no tier must never mean open", () => {
		expect(() => register(action({ access: {} as never }))).toThrow(/minTier/);
		expect(() => register(action({ access: { minTier: "root" } as never }))).toThrow(/minTier/);
	});

	it("refuses an unknown capability, and a capability on a guest action", () => {
		expect(() => register(action({ access: { minTier: "member", capability: "nope" } }))).toThrow(
			/capability/,
		);
		expect(() => register(action({ access: { minTier: "guest", capability: "door" } }))).toThrow(
			/above guest/,
		);
	});

	it("refuses a missing handler", () => {
		expect(() => register(action({ handler: undefined as never }))).toThrow(/handler/);
	});

	it("refuses bad, repeated, form and suggested options, and too many", () => {
		const text = { name: "x", description: "x", type: "string" } as const;
		expect(() => register(action({ options: [{ ...text, name: "Bad name" }] }))).toThrow(
			/option name/,
		);
		expect(() => register(action({ options: [text, text] }))).toThrow(/Duplicate option/);
		expect(() =>
			register(action({ options: [{ ...text, form: { style: "short", maxLength: 5 } }] })),
		).toThrow(/form or suggestions/);
		expect(() => register(action({ options: [{ ...text, suggest: async () => [] }] }))).toThrow(
			/form or suggestions/,
		);
		const many = Array.from({ length: 26 }, (_, i) => ({ ...text, name: `o${i}` }));
		expect(() => register(action({ options: many }))).toThrow(/At most 25/);
	});

	it("refuses the same action twice, even from another feature", () => {
		const registry = new CommandRegistry({ capabilities: DOOR });
		registry.register({ name: "feat", actions: [action()] });
		expect(() => registry.register({ name: "other", actions: [action()] })).toThrow(/Duplicate/);
	});

	it("keeps commands and actions apart", () => {
		const registry = new CommandRegistry({ capabilities: DOOR });
		registry.register({ name: "feat", commands: [command({ name: "go" })], actions: [action()] });
		expect(registry.get("go")).toBeDefined();
		expect(registry.action("go")).toBeUndefined();
	});
});

describe("Dispatcher.act", () => {
	it("runs an allowed action for whoever used the control and replaces the message", async () => {
		const handler = vi.fn(async () => ({ reply: { text: "done" } }));
		const { dispatcher } = setup([action({ handler })]);
		const outcome = await dispatcher.act({ actor: as(IDS.member), action: "feat.go", args: {} });
		expect(outcome).toEqual({ kind: "update", reply: { text: "done" } });
		expect(handler).toHaveBeenCalledWith(
			expect.objectContaining({
				principal: expect.objectContaining({ userId: IDS.member, tier: "member" }),
			}),
		);
	});

	it("opens a form when the action asks for one", async () => {
		const form = { title: "T", submit: { action: "feat.go" }, fields: [] };
		const { dispatcher } = setup([action({ handler: async () => ({ form }) })]);
		expect(await dispatcher.act({ actor: as(IDS.member), action: "feat.go", args: {} })).toEqual({
			kind: "form",
			form,
		});
	});

	it("refuses an unknown action without running anything", async () => {
		const { dispatcher, entries } = setup([]);
		expect(await dispatcher.act({ actor: as(IDS.member), action: "feat.go", args: {} })).toEqual({
			kind: "refused",
			reply: { text: MESSAGES.unknownAction, private: true },
		});
		expect(entries).toContainEqual(expect.objectContaining({ event: "action.unknown" }));
	});

	it.each([
		[IDS.admin, true],
		[IDS.member, true],
		[IDS.friend, false],
		[IDS.guest, false],
	])("checks the tier at the moment it's used (%s → %s)", async (userId, allowed) => {
		const handler = vi.fn(async () => ({ reply: { text: "done" } }));
		const { dispatcher, entries } = setup([action({ handler })]);
		const outcome = await dispatcher.act({ actor: as(userId), action: "feat.go", args: {} });
		expect(outcome.kind).toBe(allowed ? "update" : "refused");
		expect(handler).toHaveBeenCalledTimes(allowed ? 1 : 0);
		if (!allowed) {
			expect(outcome).toEqual({
				kind: "refused",
				reply: { text: MESSAGES.deniedTier, private: true },
			});
			expect(entries).toContainEqual(
				expect.objectContaining({ event: "action.denied", reason: "tier", required: "member" }),
			);
		}
	});

	it("needs the capability as well as the tier", async () => {
		const gated = action({ access: { minTier: "member", capability: "door" } });
		const without = setup([gated]);
		expect(
			(await without.dispatcher.act({ actor: as(IDS.member), action: "feat.go", args: {} })).kind,
		).toBe("refused");
		expect(without.entries).toContainEqual(
			expect.objectContaining({ event: "action.denied", reason: "capability", capability: "door" }),
		);
		const granted = setup([gated], { grants: { [IDS.member]: ["door"] } });
		expect(
			(await granted.dispatcher.act({ actor: as(IDS.member), action: "feat.go", args: {} })).kind,
		).toBe("update");
	});

	it("refuses outside the contexts it allows", async () => {
		const { dispatcher } = setup([action({ access: { minTier: "member", contexts: ["group"] } })]);
		const outcome = await dispatcher.act({
			actor: actor({ userId: IDS.member, chat: "dm" }),
			action: "feat.go",
			args: {},
		});
		expect(outcome).toEqual({
			kind: "refused",
			reply: { text: MESSAGES.deniedContext, private: true },
		});
	});

	it("takes a rate-limit token per use", async () => {
		const handler = vi.fn(async () => ({ reply: { text: "done" } }));
		const { dispatcher, entries } = setup([action({ handler })], { capacity: 1 });
		const request = { actor: as(IDS.member), action: "feat.go", args: {} };
		expect((await dispatcher.act(request)).kind).toBe("update");
		expect(await dispatcher.act(request)).toEqual({
			kind: "refused",
			reply: { text: MESSAGES.rateLimited, private: true },
		});
		expect(handler).toHaveBeenCalledTimes(1);
		expect(entries).toContainEqual(expect.objectContaining({ event: "action.rate_limited" }));
	});

	it("validates arguments against the declared options and drops unknown ones", async () => {
		const handler = vi.fn(async () => ({ reply: { text: "done" } }));
		const { dispatcher } = setup([
			action({
				handler,
				options: [{ name: "id", description: "Which", type: "string", required: true }],
			}),
		]);
		await dispatcher.act({
			actor: as(IDS.member),
			action: "feat.go",
			args: { id: "abc", extra: "x" },
		});
		expect(handler).toHaveBeenCalledWith(expect.objectContaining({ args: { id: "abc" } }));
		const missing = await dispatcher.act({ actor: as(IDS.member), action: "feat.go", args: {} });
		expect(missing).toEqual({
			kind: "refused",
			reply: { text: 'Missing required option "id".', private: true },
		});
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it("passes a channel only if the adapter resolved the same one", async () => {
		const handler = vi.fn(async () => ({ reply: { text: "done" } }));
		const { dispatcher } = setup([
			action({
				handler,
				options: [{ name: "channel", description: "Where", type: "channel", required: true }],
			}),
		]);
		const channel = {
			id: "100000000000000050",
			name: "general",
			caller: { canPost: true, canMentionEveryone: false, canCreatePolls: true },
		};
		const ok = await dispatcher.act({
			actor: as(IDS.member),
			action: "feat.go",
			args: { channel: channel.id },
			channels: { channel },
		});
		expect(ok.kind).toBe("update");
		expect(handler).toHaveBeenCalledWith(expect.objectContaining({ channels: { channel } }));
		const forged = await dispatcher.act({
			actor: as(IDS.member),
			action: "feat.go",
			args: { channel: "100000000000000051" },
			channels: { channel },
		});
		expect(forged.kind).toBe("refused");
	});

	it("shows a user-facing error privately and logs the outcome", async () => {
		const { dispatcher, entries } = setup([
			action({
				handler: async () => {
					throw new UserFacingError("Nope.");
				},
			}),
		]);
		expect(await dispatcher.act({ actor: as(IDS.member), action: "feat.go", args: {} })).toEqual({
			kind: "refused",
			reply: { text: "Nope.", private: true },
		});
		expect(entries).toContainEqual(
			expect.objectContaining({ event: "action.executed", outcome: "user_error" }),
		);
	});

	it("reports anything else and gives a generic reply", async () => {
		const boom = new Error("boom");
		const { dispatcher, reporter, entries } = setup([
			action({
				handler: async () => {
					throw boom;
				},
			}),
		]);
		expect(await dispatcher.act({ actor: as(IDS.member), action: "feat.go", args: {} })).toEqual({
			kind: "refused",
			reply: { text: MESSAGES.internalError, private: true },
		});
		expect(reporter.capture).toHaveBeenCalledWith(
			boom,
			expect.objectContaining({ command: "feat.go", feature: "feat" }),
		);
		expect(entries).toContainEqual(expect.objectContaining({ event: "action.failed" }));
	});

	it("logs who used it by ID, and runs inside the reporter's context", async () => {
		const { dispatcher, entries, contexts } = setup([action()], { withContext: true });
		await dispatcher.act({ actor: as(IDS.member), action: "feat.go", args: { secret: "x" } });
		const executed = entries.find((e) => e.event === "action.executed");
		expect(executed).toMatchObject({
			action: "feat.go",
			user: `discord:${IDS.member}`,
			outcome: "ok",
			tier: "member",
		});
		expect(JSON.stringify(entries)).not.toContain("secret");
		expect(contexts).toEqual([expect.objectContaining({ command: "feat.go", feature: "feat" })]);
	});
});
