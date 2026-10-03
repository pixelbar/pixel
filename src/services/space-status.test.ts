import { afterEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "../core/logger.ts";
import { SpaceApiError, SpaceApiStatus, type SpaceChange } from "./space-status.ts";

const URL = "https://spaceapi.example/";

/** A fake fetch whose responses can be scripted per call. */
function fakeFetch() {
	const queue: (() => Promise<Response>)[] = [];
	const fn = vi.fn<typeof globalThis.fetch>(async () => {
		const next = queue.shift();
		if (!next) throw new Error("unexpected fetch");
		return next();
	});
	return {
		fn,
		json(body: unknown, init?: ResponseInit) {
			queue.push(async () => new Response(JSON.stringify(body), init));
			return this;
		},
		raw(body: string, init?: ResponseInit) {
			queue.push(async () => new Response(body, init));
			return this;
		},
		fail(error: unknown) {
			queue.push(async () => Promise.reject(error));
			return this;
		},
	};
}

const open = (value: boolean | null) => ({
	api: "0.13",
	space: "Pixelbar",
	state: { open: value },
});

function setup(options: { failureThreshold?: number } = {}) {
	const fetch = fakeFetch();
	let now = new Date("2026-10-03T12:00:00Z");
	const reportError = vi.fn();
	const service = new SpaceApiStatus({
		url: URL,
		logger: silentLogger,
		reportError,
		fetch: fetch.fn,
		now: () => now,
		...options,
	});
	return {
		service,
		fetch,
		reportError,
		advance(ms: number) {
			now = new Date(now.getTime() + ms);
			return now;
		},
	};
}

describe("SpaceApiStatus.checkNow", () => {
	it("reads open and closed from state.open", async () => {
		const { service, fetch } = setup();
		fetch.json(open(true)).json(open(false));
		expect((await service.checkNow()).state).toBe("open");
		expect((await service.checkNow()).state).toBe("closed");
		expect(fetch.fn).toHaveBeenCalledWith(
			URL,
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});

	it("falls back to the deprecated top-level open field", async () => {
		const { service, fetch } = setup();
		fetch.json({ open: true });
		expect((await service.checkNow()).state).toBe("open");
	});

	it("prefers state.open over top-level open", async () => {
		const { service, fetch } = setup();
		fetch.json({ open: true, state: { open: false } });
		expect((await service.checkNow()).state).toBe("closed");
	});

	it("treats null as unknown", async () => {
		const { service, fetch } = setup();
		fetch.json(open(null));
		expect(await service.checkNow()).toMatchObject({ state: "unknown", since: null });
	});

	it("shares one request between concurrent checks", async () => {
		const { service, fetch } = setup();
		fetch.json(open(true));
		const [a, b] = await Promise.all([service.checkNow(), service.checkNow()]);
		expect(a).toBe(b);
		expect(fetch.fn).toHaveBeenCalledTimes(1);
	});

	it("makes a fresh request once the previous one finished", async () => {
		const { service, fetch } = setup();
		fetch.json(open(true)).json(open(true));
		await service.checkNow();
		await service.checkNow();
		expect(fetch.fn).toHaveBeenCalledTimes(2);
	});

	describe("rejects bad responses as SpaceApiError", () => {
		it.each([
			[
				"HTTP errors",
				(f: ReturnType<typeof fakeFetch>) => f.raw("nope", { status: 502 }),
				/HTTP 502/,
			],
			["invalid JSON", (f: ReturnType<typeof fakeFetch>) => f.raw("<html>"), /invalid JSON/],
			[
				"wrong types",
				(f: ReturnType<typeof fakeFetch>) => f.json({ state: { open: "yes" } }),
				/unexpected shape/,
			],
			[
				"no open state",
				(f: ReturnType<typeof fakeFetch>) => f.json({ space: "Pixelbar" }),
				/no open state/,
			],
			[
				"oversized bodies",
				(f: ReturnType<typeof fakeFetch>) =>
					f.raw(JSON.stringify({ open: true, pad: "x".repeat(70_000) })),
				/too large/,
			],
			[
				"oversized declared length",
				(f: ReturnType<typeof fakeFetch>) =>
					f.raw("{}", { headers: { "content-length": "999999999" } }),
				/too large/,
			],
			[
				"network errors",
				(f: ReturnType<typeof fakeFetch>) => f.fail(new TypeError("fetch failed")),
				/request failed/,
			],
		])("%s", async (_label, script, message) => {
			const { service, fetch } = setup();
			script(fetch);
			const error = await service.checkNow().catch((e: unknown) => e);
			expect(error).toBeInstanceOf(SpaceApiError);
			expect((error as Error).message).toMatch(message);
		});
	});
});

describe("tracking changes", () => {
	it("doesn't claim a 'since' for the first observation", async () => {
		const { service, fetch } = setup();
		fetch.json(open(true));
		expect((await service.checkNow()).since).toBeNull();
	});

	it("records when it saw a change, and keeps it until the next change", async () => {
		const { service, fetch, advance } = setup();
		fetch.json(open(false)).json(open(true)).json(open(true));
		await service.checkNow();
		const changedAt = advance(60_000);
		expect((await service.checkNow()).since).toEqual(changedAt);
		advance(60_000);
		expect((await service.checkNow()).since).toEqual(changedAt);
	});

	it("ignores unknown readings when tracking changes", async () => {
		const { service, fetch, advance } = setup();
		const listener = vi.fn();
		service.onChange(listener);
		fetch.json(open(true)).json(open(null)).json(open(true));
		await service.checkNow();
		advance(60_000);
		await service.checkNow();
		advance(60_000);
		const reading = await service.checkNow();
		expect(reading.since).toBeNull();
		expect(listener).not.toHaveBeenCalled();
	});

	it("notifies listeners of open↔closed flips only", async () => {
		const { service, fetch, advance } = setup();
		const changes: SpaceChange[] = [];
		service.onChange((c) => changes.push(c));
		fetch.json(open(false)).json(open(false)).json(open(true));
		await service.checkNow();
		await service.checkNow();
		const at = advance(1000);
		await service.checkNow();
		expect(changes).toEqual([{ from: "closed", to: "open", at }]);
	});

	it("stops notifying after unsubscribe", async () => {
		const { service, fetch } = setup();
		const listener = vi.fn();
		const unsubscribe = service.onChange(listener);
		unsubscribe();
		fetch.json(open(false)).json(open(true));
		await service.checkNow();
		await service.checkNow();
		expect(listener).not.toHaveBeenCalled();
	});

	it("survives a throwing listener and reports it", async () => {
		const { service, fetch, reportError } = setup();
		const boom = new Error("listener bug");
		const second = vi.fn();
		service.onChange(() => {
			throw boom;
		});
		service.onChange(second);
		fetch.json(open(false)).json(open(true));
		await service.checkNow();
		await expect(service.checkNow()).resolves.toMatchObject({ state: "open" });
		expect(reportError).toHaveBeenCalledWith(boom);
		expect(second).toHaveBeenCalledOnce();
	});
});

describe("failure reporting", () => {
	it("reports once when failures reach the threshold, not on every failure", async () => {
		const { service, fetch, reportError } = setup({ failureThreshold: 3 });
		for (let i = 0; i < 5; i++) fetch.raw("", { status: 503 });
		for (let i = 0; i < 5; i++) await service.checkNow().catch(() => {});
		expect(reportError).toHaveBeenCalledOnce();
		const reported: unknown = reportError.mock.calls[0]?.[0];
		expect(reported).toBeInstanceOf(SpaceApiError);
		expect(String(reported)).toMatch(/3 times in a row/);
	});

	it("resets after a success, so a later outage is reported again", async () => {
		const { service, fetch, reportError } = setup({ failureThreshold: 2 });
		fetch
			.fail(new Error("a"))
			.fail(new Error("b"))
			.json(open(true))
			.fail(new Error("c"))
			.fail(new Error("d"));
		for (let i = 0; i < 5; i++) await service.checkNow().catch(() => {});
		expect(reportError).toHaveBeenCalledTimes(2);
	});
});

describe("background polling", () => {
	afterEach(() => vi.useRealTimers());

	it("checks immediately and then on every interval until stopped", async () => {
		vi.useFakeTimers();
		const fetch = fakeFetch();
		for (let i = 0; i < 3; i++) fetch.json(open(true));
		const service = new SpaceApiStatus({
			url: URL,
			logger: silentLogger,
			reportError: vi.fn(),
			fetch: fetch.fn,
			pollIntervalMs: 60_000,
		});

		service.start();
		service.start(); // idempotent
		await vi.advanceTimersByTimeAsync(0);
		expect(fetch.fn).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(60_000);
		expect(fetch.fn).toHaveBeenCalledTimes(2);

		service.stop();
		await vi.advanceTimersByTimeAsync(180_000);
		expect(fetch.fn).toHaveBeenCalledTimes(2);
	});

	it("keeps polling through failures without unhandled rejections", async () => {
		vi.useFakeTimers();
		const fetch = fakeFetch();
		fetch.fail(new Error("down")).json(open(true));
		const service = new SpaceApiStatus({
			url: URL,
			logger: silentLogger,
			reportError: vi.fn(),
			fetch: fetch.fn,
			pollIntervalMs: 1000,
		});
		service.start();
		await vi.advanceTimersByTimeAsync(1000);
		expect(fetch.fn).toHaveBeenCalledTimes(2);
		service.stop();
	});
});
