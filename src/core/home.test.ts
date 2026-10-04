import { describe, expect, it, vi } from "vitest";
import {
	type EntityState,
	HOME_MESSAGES,
	Home,
	type HomeBackend,
	HomeRequestError,
	type HomeStatus,
	HomeUnavailableError,
} from "./home.ts";
import { silentLogger } from "./logger.ts";
import { nullErrorReporter } from "./ports/error-reporter.ts";

const CONNECTED: HomeStatus = { kind: "connected", haVersion: "2026.10.0", adminToken: false };

const entity = (entityId: string, state = "on"): EntityState => ({
	entityId,
	state,
	attributes: {},
	lastChanged: null,
});

function setup(
	backend?: Partial<HomeBackend> & { status?: () => HomeStatus },
	options: { timeoutMs?: number } = {},
) {
	const logger = { ...silentLogger, info: vi.fn(), warn: vi.fn(), error: vi.fn() };
	logger.child = () => logger;
	const reporter = { ...nullErrorReporter, captureBackground: vi.fn() };
	const home = new Home({ logger, reporter, ...options });
	const full = backend && {
		status: () => CONNECTED,
		check: async () => CONNECTED,
		getStates: async () => new Map(),
		callService: async () => {},
		...backend,
	};
	if (full) home.attach(full);
	return { home, logger, reporter, backend: full };
}

describe("with no backend", () => {
	it("is unconfigured, and fails every call plainly without reporting it as an outage", async () => {
		const { home, reporter } = setup();
		expect(home.status()).toEqual({ kind: "unconfigured" });
		expect(await home.check()).toEqual({ kind: "unconfigured" });
		for (const call of [
			() => home.getStates(["light.a"]),
			() => home.getState("light.a"),
			() => home.callService({ domain: "light", service: "turn_on", entityId: "light.a" }),
		]) {
			const error = await call().catch((e: unknown) => e);
			expect(error).toBeInstanceOf(HomeUnavailableError);
			expect((error as Error).message).toBe(HOME_MESSAGES.notSetUp);
		}
		expect(reporter.captureBackground).not.toHaveBeenCalled();
	});
});

describe("reading", () => {
	it("returns what the backend reports, and a single state", async () => {
		const getStates = vi.fn(async () => new Map([["light.a", entity("light.a")]]));
		const { home } = setup({ getStates });
		expect((await home.getStates(["light.a", "light.b"])).get("light.a")?.state).toBe("on");
		expect(getStates).toHaveBeenCalledWith(["light.a", "light.b"]);
		expect((await home.getState("light.a"))?.entityId).toBe("light.a");
		expect(await home.getState("light.zzz")).toBeUndefined();
	});

	it("never caches: every read asks the backend", async () => {
		const getStates = vi.fn(async () => new Map([["light.a", entity("light.a")]]));
		const { home } = setup({ getStates });
		await home.getState("light.a");
		await home.getState("light.a");
		expect(getStates).toHaveBeenCalledTimes(2);
	});
});

describe("calling a service", () => {
	it("passes exactly the call on, once", async () => {
		const callService = vi.fn(async () => {});
		const { home } = setup({ callService });
		const call = { domain: "lock", service: "unlock", entityId: "lock.front_door", data: { x: 1 } };
		await home.callService(call);
		expect(callService).toHaveBeenCalledTimes(1);
		expect(callService).toHaveBeenCalledWith(call);
	});

	it.each(["connecting", "reconnecting"] as const)(
		"fails at once, without trying, while %s, so nothing waits to arrive late",
		async (kind) => {
			const callService = vi.fn(async () => {});
			const { home } = setup({ callService, status: () => ({ kind }) });
			await expect(
				home.callService({ domain: "lock", service: "unlock", entityId: "lock.front_door" }),
			).rejects.toThrow(HOME_MESSAGES.unreachable);
			expect(callService).not.toHaveBeenCalled();
		},
	);

	it("fails at once, without trying, when the login was refused", async () => {
		const getStates = vi.fn(async () => new Map());
		const { home } = setup({ getStates, status: () => ({ kind: "off", reason: "token refused" }) });
		await expect(home.getStates(["light.a"])).rejects.toBeInstanceOf(HomeUnavailableError);
		expect(getStates).not.toHaveBeenCalled();
	});

	it("never retries a failed call", async () => {
		const callService = vi.fn(async () => {
			throw new HomeUnavailableError(HOME_MESSAGES.unreachable);
		});
		const { home } = setup({ callService });
		await expect(
			home.callService({ domain: "lock", service: "unlock", entityId: "lock.front_door" }),
		).rejects.toBeInstanceOf(HomeUnavailableError);
		expect(callService).toHaveBeenCalledTimes(1);
	});

	it("gives up on a call that hangs, and says it can't reach Home Assistant", async () => {
		const callService = vi.fn(() => new Promise<void>(() => {}));
		const { home } = setup({ callService }, { timeoutMs: 20 });
		const started = Date.now();
		await expect(
			home.callService({ domain: "lock", service: "unlock", entityId: "lock.front_door" }),
		).rejects.toThrow(HOME_MESSAGES.unreachable);
		expect(Date.now() - started).toBeLessThan(1000);
	});

	it("gives up on a read that hangs", async () => {
		const { home } = setup({ getStates: () => new Promise(() => {}) }, { timeoutMs: 20 });
		await expect(home.getStates(["light.a"])).rejects.toThrow(HOME_MESSAGES.unreachable);
	});
});

describe("errors", () => {
	it("passes on Home Assistant's own refusal, which is not an outage", async () => {
		const refusal = new HomeRequestError(HOME_MESSAGES.refused, "not_found");
		const { home, reporter, logger } = setup({
			callService: async () => {
				throw refusal;
			},
		});
		await expect(
			home.callService({ domain: "lock", service: "explode", entityId: "lock.front_door" }),
		).rejects.toBe(refusal);
		expect(reporter.captureBackground).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalledWith(
			{ event: "home.rejected", action: "callService", code: "not_found" },
			expect.any(String),
		);
	});

	it("turns an unexpected failure into a plain one, and logs and reports the real error", async () => {
		const bug = new TypeError("something unexpected with the token abc");
		const { home, reporter, logger } = setup({
			getStates: async () => {
				throw bug;
			},
		});
		const error = await home.getStates(["light.a"]).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(HomeUnavailableError);
		expect((error as Error).message).toBe(HOME_MESSAGES.unreachable);
		expect((error as Error).message).not.toContain("abc");
		expect(reporter.captureBackground).toHaveBeenCalledWith(bug, "home-assistant");
		expect(logger.error).toHaveBeenCalled();
	});

	it("reports an outage once, not on every command, and again after it recovers", async () => {
		let up = false;
		const { home, reporter } = setup({
			status: () => (up ? CONNECTED : { kind: "reconnecting" }),
			getStates: async () => new Map(),
		});
		for (let i = 0; i < 3; i++) await home.getStates(["light.a"]).catch(() => {});
		expect(reporter.captureBackground).toHaveBeenCalledTimes(1);

		up = true;
		await home.getStates(["light.a"]);
		up = false;
		await home.getStates(["light.a"]).catch(() => {});
		expect(reporter.captureBackground).toHaveBeenCalledTimes(2);
	});
});

describe("check", () => {
	it("says it's connected, and says nothing more when all is well", async () => {
		const { home, logger, reporter } = setup({});
		expect(await home.check()).toEqual(CONNECTED);
		expect(logger.info).toHaveBeenCalledWith(
			{ event: "home.connected", haVersion: "2026.10.0" },
			expect.any(String),
		);
		expect(reporter.captureBackground).not.toHaveBeenCalled();
	});

	it("warns, and reports once, when the token belongs to an admin", async () => {
		const admin: HomeStatus = { kind: "connected", haVersion: undefined, adminToken: true };
		const { home, logger, reporter } = setup({ check: async () => admin });
		await home.check();
		await home.check();
		expect(logger.warn).toHaveBeenCalledWith(
			{ event: "home.admin_token" },
			expect.stringContaining("non-admin"),
		);
		expect(reporter.captureBackground).toHaveBeenCalledTimes(1);
	});

	it("doesn't flag a token whose owner is unknown", async () => {
		const unknown: HomeStatus = { kind: "connected", haVersion: undefined, adminToken: undefined };
		const { home, reporter } = setup({ check: async () => unknown });
		await home.check();
		expect(reporter.captureBackground).not.toHaveBeenCalled();
	});

	it("reports a login that was refused, with the reason and no secrets", async () => {
		const off: HomeStatus = {
			kind: "off",
			reason: "Home Assistant refused the token, so it needs replacing",
		};
		const { home, logger, reporter } = setup({ check: async () => off });
		expect(await home.check()).toEqual(off);
		expect(logger.error).toHaveBeenCalledWith(
			{ event: "home.off" },
			expect.stringContaining("refused the token"),
		);
		const [error, source] = reporter.captureBackground.mock.calls[0] ?? [];
		expect((error as Error).message).toBe(
			"Home Assistant is off: Home Assistant refused the token, so it needs replacing",
		);
		expect(source).toBe("home-assistant");
	});

	it.each(["connecting", "reconnecting"] as const)(
		"notes, without reporting, that it's %s",
		async (kind) => {
			const { home, logger, reporter } = setup({ check: async () => ({ kind }) });
			expect(await home.check()).toEqual({ kind });
			expect(logger.warn).toHaveBeenCalledWith(
				{ event: "home.not_connected", status: kind },
				expect.any(String),
			);
			expect(reporter.captureBackground).not.toHaveBeenCalled();
		},
	);

	it("copes with a check that fails or hangs", async () => {
		const failing = setup({
			check: async () => {
				throw new Error("boom");
			},
		});
		expect(await failing.home.check()).toEqual({ kind: "reconnecting" });
		const hanging = setup({ check: () => new Promise(() => {}) }, { timeoutMs: 20 });
		expect(await hanging.home.check()).toEqual({ kind: "reconnecting" });
	});
});
