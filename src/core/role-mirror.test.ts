import { describe, expect, it, vi } from "vitest";
import { silentLogger } from "./logger.ts";
import { nullErrorReporter } from "./ports/error-reporter.ts";
import { type MirrorBackend, RoleMirror, type TierMirrorState } from "./role-mirror.ts";

function setup(backend?: Partial<MirrorBackend>) {
	const logger = { ...silentLogger, info: vi.fn(), error: vi.fn() };
	logger.child = () => logger;
	const reporter = { ...nullErrorReporter, captureBackground: vi.fn() };
	const mirror = new RoleMirror({ logger, reporter });
	if (backend) {
		mirror.attach({
			states: async () => [],
			apply: async () => ({ kind: "unconfigured" }),
			inspect: async () => ({ kind: "unconfigured" }),
			...backend,
		});
	}
	return { mirror, logger, reporter };
}

describe("before a backend is attached", () => {
	it("touches nothing and says nothing is configured", async () => {
		const { mirror } = setup();
		expect(await mirror.apply("1", "member", "why")).toEqual({ kind: "unconfigured" });
		expect(await mirror.inspect("1")).toEqual({ kind: "unconfigured" });
		expect(await mirror.states()).toEqual([
			{ tier: "member", status: "unconfigured" },
			{ tier: "friend", status: "unconfigured" },
		]);
	});

	it("checks without reporting anything", async () => {
		const { mirror, reporter } = setup();
		await mirror.check();
		expect(reporter.captureBackground).not.toHaveBeenCalled();
	});
});

describe("with a backend", () => {
	it("passes calls through, including the reason for the audit log", async () => {
		const apply = vi.fn(async () => ({ kind: "in-sync" as const, off: [] }));
		const inspect = vi.fn(async () => ({ kind: "not-in-server" as const }));
		const { mirror } = setup({ apply, inspect });
		expect(await mirror.apply("42", "friend", "Set to friend by Ada")).toEqual({
			kind: "in-sync",
			off: [],
		});
		expect(apply).toHaveBeenCalledWith("42", "friend", "Set to friend by Ada");
		expect(await mirror.inspect("42")).toEqual({ kind: "not-in-server" });
		expect(inspect).toHaveBeenCalledWith("42");
	});

	it("turns an unexpected failure into a plain one, and logs and reports the real error", async () => {
		const boom = new Error("socket hang up for 100000000000000001");
		const { mirror, logger, reporter } = setup({
			apply: async () => {
				throw boom;
			},
			inspect: async () => {
				throw boom;
			},
			states: async () => {
				throw boom;
			},
		});
		const failed = { kind: "failed", reason: "Discord didn't accept the change" };
		expect(await mirror.apply("1", "member", "why")).toEqual(failed);
		expect(await mirror.inspect("1")).toEqual(failed);
		expect(await mirror.states()).toEqual([
			{ tier: "member", status: "off", reason: failed.reason },
			{ tier: "friend", status: "off", reason: failed.reason },
		]);
		expect(reporter.captureBackground).toHaveBeenCalledTimes(3);
		expect(reporter.captureBackground).toHaveBeenCalledWith(boom, "role-mirror");
		expect(logger.error).toHaveBeenCalled();
	});
});

describe("check", () => {
	const states: TierMirrorState[] = [
		{ tier: "member", status: "on", role: "member" },
		{ tier: "friend", status: "off", reason: "that role isn't below the bot's highest role" },
	];

	it("logs each tier and reports only the ones that are off, once each", async () => {
		const { mirror, logger, reporter } = setup({ states: async () => states });
		expect(await mirror.check()).toEqual(states);
		expect(logger.info).toHaveBeenCalledWith(
			{ event: "role_mirror.on", tier: "member" },
			expect.any(String),
		);
		expect(logger.error).toHaveBeenCalledWith(
			{ event: "role_mirror.off", tier: "friend" },
			expect.stringContaining("isn't below the bot's highest role"),
		);
		expect(reporter.captureBackground).toHaveBeenCalledTimes(1);
		const [error, source] = reporter.captureBackground.mock.calls[0] ?? [];
		expect((error as Error).message).toBe(
			"Role mirroring for friend is off: that role isn't below the bot's highest role",
		);
		expect(source).toBe("role-mirror");
	});

	it("says which tiers aren't configured, without reporting them", async () => {
		const { mirror, logger, reporter } = setup({
			states: async () => [{ tier: "member", status: "unconfigured" }],
		});
		await mirror.check();
		expect(logger.info).toHaveBeenCalledWith(
			{ event: "role_mirror.unconfigured", tier: "member" },
			expect.any(String),
		);
		expect(reporter.captureBackground).not.toHaveBeenCalled();
	});
});
