import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDS, principal } from "../testing/fixtures.ts";

const scope = { setTags: vi.fn(), setTag: vi.fn(), setUser: vi.fn() };
const isolationScope = { setTags: vi.fn(), setTag: vi.fn(), setUser: vi.fn() };
const captureException = vi.fn();
const addBreadcrumb = vi.fn();
const startSpan = vi.fn((_opts: unknown, run: (span: unknown) => unknown) => run({}));
const metricsCount = vi.fn();

vi.mock("@sentry/node", () => ({
	withScope: (callback: (s: typeof scope) => void) => callback(scope),
	withIsolationScope: <T>(callback: (s: typeof isolationScope) => T) => callback(isolationScope),
	captureException: (error: unknown) => captureException(error),
	addBreadcrumb: (crumb: unknown) => addBreadcrumb(crumb),
	startSpan: (opts: unknown, run: (span: unknown) => unknown) => startSpan(opts, run),
	metrics: { count: (...args: unknown[]) => metricsCount(...args) },
}));

const { createSentryReporter } = await import("./sentry-reporter.ts");

describe("createSentryReporter", () => {
	beforeEach(() => vi.clearAllMocks());

	it("leaves breadcrumbs with their data, or without", () => {
		const reporter = createSentryReporter();
		reporter.breadcrumb("access", "tier changed", { target: "discord:1" });
		reporter.breadcrumb("access", "reloaded");
		expect(addBreadcrumb).toHaveBeenNthCalledWith(1, {
			category: "access",
			message: "tier changed",
			level: "info",
			data: { target: "discord:1" },
		});
		expect(addBreadcrumb).toHaveBeenNthCalledWith(2, {
			category: "access",
			message: "reloaded",
			level: "info",
		});
	});

	it("captures background errors tagged with their source and no user", () => {
		const error = new Error("SpaceAPI down");
		createSentryReporter().captureBackground(error, "spaceapi");
		expect(scope.setTag).toHaveBeenCalledWith("source", "spaceapi");
		expect(scope.setUser).not.toHaveBeenCalled();
		expect(captureException).toHaveBeenCalledWith(error);
	});

	const caller = principal("member", { userId: IDS.member, displayName: "Ada Lovelace" });

	it("captures the error with command, feature, platform and tier tags", () => {
		const error = new Error("boom");
		createSentryReporter().capture(error, {
			command: "whoami",
			feature: "whoami",
			principal: caller,
		});
		expect(captureException).toHaveBeenCalledWith(error);
		expect(scope.setTags).toHaveBeenCalledWith({
			command: "whoami",
			feature: "whoami",
			platform: "discord",
			tier: "member",
		});
	});

	it("identifies the user by stable platform ID, plus handle and display name", () => {
		createSentryReporter().capture(new Error("boom"), {
			command: "x",
			feature: "x",
			principal: { ...caller, handle: "ada_l" },
		});
		expect(scope.setUser).toHaveBeenCalledWith({
			id: `discord:${IDS.member}`,
			username: "ada_l",
			name: "Ada Lovelace",
		});
	});

	it("omits the username when the platform has no handle", () => {
		createSentryReporter().capture(new Error("boom"), {
			command: "x",
			feature: "x",
			principal: { ...caller, handle: undefined },
		});
		expect(scope.setUser).toHaveBeenCalledWith({
			id: `discord:${IDS.member}`,
			name: "Ada Lovelace",
		});
	});

	it("names who a background error happened to, by ID, when it is told", () => {
		createSentryReporter().captureBackground(new Error("discord failed"), "discord", {
			platform: "discord",
			userId: IDS.member,
			displayName: "Ada Lovelace",
			handle: "ada_l",
		});
		expect(scope.setTag).toHaveBeenCalledWith("source", "discord");
		expect(scope.setUser).toHaveBeenCalledWith({
			id: `discord:${IDS.member}`,
			username: "ada_l",
			name: "Ada Lovelace",
		});
	});

	it("runs the work with the person and command attached to everything reported meanwhile", async () => {
		const run = vi.fn(async () => "result");
		const result = await createSentryReporter().withContext?.(
			{ command: "ha set", feature: "home", principal: { ...caller, handle: "ada_l" } },
			run,
		);
		expect(result).toBe("result");
		expect(run).toHaveBeenCalledTimes(1);
		expect(isolationScope.setTags).toHaveBeenCalledWith({
			command: "ha set",
			feature: "home",
			platform: "discord",
			tier: "member",
		});
		expect(isolationScope.setUser).toHaveBeenCalledWith({
			id: `discord:${IDS.member}`,
			username: "ada_l",
			name: "Ada Lovelace",
		});
		expect(startSpan).toHaveBeenCalledWith(
			{
				name: "ha set",
				op: "command",
				attributes: {
					command: "ha set",
					feature: "home",
					platform: "discord",
					tier: "member",
				},
			},
			run,
		);
		expect(metricsCount).toHaveBeenCalledWith("pixel.command", 1, {
			attributes: {
				command: "ha set",
				feature: "home",
				platform: "discord",
				tier: "member",
			},
		});
	});

	it("lets an error from the work through, unchanged", async () => {
		const error = new Error("handler failed");
		await expect(
			createSentryReporter().withContext?.(
				{ command: "x", feature: "x", principal: caller },
				async () => {
					throw error;
				},
			),
		).rejects.toBe(error);
	});
});
