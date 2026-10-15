import { describe, expect, it, vi } from "vitest";
import type { PlatformActor, Tier } from "../../core/access.ts";
import { CapabilityRegistry } from "../../core/capabilities.ts";
import { Dispatcher, MESSAGES } from "../../core/dispatcher.ts";
import { IdentityService } from "../../core/identity.ts";
import { silentLogger } from "../../core/logger.ts";
import { nullErrorReporter } from "../../core/ports/error-reporter.ts";
import { RateLimiter } from "../../core/rate-limit.ts";
import { CommandRegistry } from "../../core/registry.ts";
import { type SpaceStateApi, SpaceStateApiError } from "../../services/space-state-api.ts";
import { actor, context, IDS, principal } from "../../testing/fixtures.ts";
import { CAPABILITIES } from "../capabilities.ts";
import { createSpaceStateFeature, SPACESTATE_CAPABILITY, SPACESTATE_MESSAGES } from "./index.ts";

/** Obviously fake people: a tier and the capabilities each holds. */
const PEOPLE: Record<string, { tier: Tier | null; holds: string[] }> = {
	[IDS.admin]: { tier: "admin", holds: [] },
	[IDS.member]: { tier: "member", holds: [] },
	[IDS.friend]: { tier: "friend", holds: [SPACESTATE_CAPABILITY.name] },
	[IDS.guest]: { tier: null, holds: [SPACESTATE_CAPABILITY.name] },
	"100000000000000020": { tier: "member", holds: [SPACESTATE_CAPABILITY.name] },
	"100000000000000021": { tier: "admin", holds: [SPACESTATE_CAPABILITY.name] },
	"100000000000000022": { tier: "member", holds: ["schedule-posts", "ha-admin"] },
};
const HOLDER = "100000000000000020";
const ADMIN_HOLDER = "100000000000000021";

function setup(options: { api?: SpaceStateApi | null } = {}) {
	const set = vi.fn<SpaceStateApi["set"]>(async () => {});
	const api = options.api === null ? undefined : (options.api ?? { set });
	const logger = { ...silentLogger, info: vi.fn(), warn: vi.fn() };
	logger.child = () => logger;
	const reporter = { ...nullErrorReporter, breadcrumb: vi.fn(), captureBackground: vi.fn() };

	const registry = new CommandRegistry({ capabilities: new CapabilityRegistry(CAPABILITIES) });
	registry.register(createSpaceStateFeature({ api, reporter }));
	const dispatcher = new Dispatcher({
		registry,
		identity: new IdentityService(
			[
				{
					name: "test",
					tierFor: async (a: PlatformActor) => PEOPLE[a.userId]?.tier ?? null,
				},
			],
			[
				{
					name: "test",
					capabilitiesFor: async (a: PlatformActor) => PEOPLE[a.userId]?.holds ?? [],
				},
			],
		),
		rateLimiter: new RateLimiter({ capacity: 1000, refillPerSecond: 0, now: () => 0 }),
		logger,
		reporter: nullErrorReporter,
	});
	const run = (userId: string, state?: string) =>
		dispatcher.dispatch({
			actor: actor({ userId, displayName: "Grace", handle: "grace" }),
			command: "spacestate",
			subcommand: "set",
			args: state === undefined ? {} : { state },
		});
	return { run, set, logger, reporter, registry, dispatcher };
}

describe("/spacestate set", () => {
	it("is a capability that admins can grant", () => {
		expect(new CapabilityRegistry(CAPABILITIES).get("spacestate")).toEqual(SPACESTATE_CAPABILITY);
	});

	it("requires the member tier and the spacestate capability, at every level", () => {
		const { registry } = setup();
		const def = registry.get("spacestate")?.definition;
		expect(def?.access).toEqual({ minTier: "member", capability: "spacestate" });
		const sub = def?.subcommands?.[0];
		expect(sub?.access).toEqual({ minTier: "member", capability: "spacestate" });
	});

	it("offers open and close, and sends closed for close", () => {
		const sub = setup().registry.get("spacestate")?.definition.subcommands?.[0];
		const option = sub && "options" in sub ? sub.options?.[0] : undefined;
		expect(option).toMatchObject({
			name: "state",
			type: "string",
			required: true,
			choices: ["open", "close"],
		});
	});

	it("sets the space open for a member who holds the capability", async () => {
		const { run, set } = setup();
		const result = await run(HOLDER, "open");
		expect(set).toHaveBeenCalledExactlyOnceWith("open");
		expect(result.private).toBe(true);
		expect(result.reply.text).toContain("**open**");
	});

	it("sends closed, not close, when the space is closed", async () => {
		const { run, set } = setup();
		const result = await run(HOLDER, "close");
		expect(set).toHaveBeenCalledExactlyOnceWith("closed");
		expect(result.reply.text).toContain("**closed**");
	});

	it("lets an admin who also holds the capability use it", async () => {
		const { run, set } = setup();
		await run(ADMIN_HOLDER, "open");
		expect(set).toHaveBeenCalledOnce();
	});

	it.each([
		["a plain member", IDS.member],
		["an admin without the capability", IDS.admin],
		["a friend who holds it", IDS.friend],
		["a guest who holds it", IDS.guest],
		["a member holding other capabilities", "100000000000000022"],
		["someone nobody has heard of", "100000000000000099"],
	])("refuses %s, and never calls the API", async (_label, userId) => {
		const { run, set } = setup();
		const result = await run(userId, "open");
		expect(result.reply.text).toBe(MESSAGES.deniedTier);
		expect(set).not.toHaveBeenCalled();
	});

	it.each(["closed", "OPEN", "toString", "__proto__", "constructor", " open", ""])(
		"the dispatcher refuses the state %j, and the API isn't called",
		async (state) => {
			const { run, set } = setup();
			const result = await run(HOLDER, state);
			expect(result.reply.text).toBe('Invalid value for option "state".');
			expect(set).not.toHaveBeenCalled();
		},
	);

	it("the dispatcher refuses a missing state", async () => {
		const { run, set } = setup();
		const result = await run(HOLDER);
		expect(result.reply.text).not.toContain("**");
		expect(set).not.toHaveBeenCalled();
	});

	it.each([
		"closed",
		"toString",
		"__proto__",
		"constructor",
		"hasOwnProperty",
		"",
		undefined,
		true,
		1,
	])("the handler checks the state itself too: %j", async (state) => {
		const { registry, set } = setup();
		const sub = registry.get("spacestate")?.definition.subcommands?.[0];
		if (!sub || !("handler" in sub)) throw new Error("expected a runnable subcommand");
		await expect(
			sub.handler(
				context({
					args: state === undefined ? {} : { state },
					principal: principal("member", { userId: HOLDER }, [SPACESTATE_CAPABILITY.name]),
				}),
			),
		).rejects.toThrow(SPACESTATE_MESSAGES.badState);
		expect(set).not.toHaveBeenCalled();
	});

	it("says so, privately, when it isn't configured", async () => {
		const { run, reporter } = setup({ api: null });
		const result = await run(HOLDER, "open");
		expect(result.reply).toEqual({ text: SPACESTATE_MESSAGES.notSetUp, private: true });
		expect(reporter.breadcrumb).not.toHaveBeenCalled();
	});

	it("says nothing changed, and reports it, when the API doesn't accept the change", async () => {
		const failure = new SpaceStateApiError("Space state API did not accept the change");
		const { run, reporter, logger } = setup({
			api: {
				set: async () => {
					throw failure;
				},
			},
		});
		const result = await run(HOLDER, "close");
		expect(result.reply).toEqual({ text: SPACESTATE_MESSAGES.failed, private: true });
		expect(reporter.captureBackground).toHaveBeenCalledWith(
			failure,
			"spacestate",
			expect.objectContaining({ userId: HOLDER, platform: "discord" }),
		);
		expect(logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "spacestate.failed",
				state: "closed",
				user: `discord:${HOLDER}`,
			}),
			expect.any(String),
		);
		expect(reporter.breadcrumb).not.toHaveBeenCalled();
	});

	it("gives a generic reply for a bug that isn't an API failure", async () => {
		const { run } = setup({
			api: {
				set: async () => {
					throw new Error("boom");
				},
			},
		});
		const result = await run(HOLDER, "open");
		expect(result.reply.text).toBe(MESSAGES.internalError);
		expect(result.private).toBe(true);
	});

	it("logs who did it, and leaves a breadcrumb, but no secrets", async () => {
		const { run, reporter, logger } = setup();
		await run(HOLDER, "open");
		expect(logger.info).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "spacestate.set",
				state: "open",
				user: `discord:${HOLDER}`,
				userName: "Grace",
				userHandle: "grace",
			}),
			expect.any(String),
		);
		expect(reporter.breadcrumb).toHaveBeenCalledWith("spacestate.set", "space open", {
			user: `discord:${HOLDER}`,
		});
	});
});
