import { afterEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "../core/logger.ts";
import type { PersistedSpaceState, SpaceStateStore } from "./space-state-store.ts";
import { SpaceApiError, SpaceApiStatus, type SpaceChange } from "./space-status.ts";

const URL = "https://spaceapi.example/";

/** An in-memory store that records saves; `load`/`save` can be made to throw. */
class FakeStore implements SpaceStateStore {
	saved: PersistedSpaceState | undefined;
	readonly saves: PersistedSpaceState[] = [];
	loadError: unknown;
	saveError: unknown;

	constructor(initial?: PersistedSpaceState) {
		this.saved = initial;
	}

	load(): PersistedSpaceState | undefined {
		if (this.loadError) throw this.loadError;
		return this.saved;
	}

	save(state: PersistedSpaceState): void {
		if (this.saveError) throw this.saveError;
		this.saved = state;
		this.saves.push(state);
	}
}

const fakeStore = (initial?: PersistedSpaceState) => new FakeStore(initial);

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

function setup(options: { failureThreshold?: number; store?: SpaceStateStore } = {}) {
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
		expect(changes).toEqual([{ from: "closed", to: "open", at, previousSince: null }]);
	});

	it("tells listeners when the state it changed from began, if it saw that", async () => {
		const { service, fetch, advance } = setup();
		const changes: SpaceChange[] = [];
		service.onChange((c) => changes.push(c));
		fetch.json(open(false)).json(open(true)).json(open(false));
		await service.checkNow();
		const openedAt = advance(60_000);
		await service.checkNow();
		const closedAt = advance(3 * 3_600_000);
		await service.checkNow();
		expect(changes).toEqual([
			{ from: "closed", to: "open", at: openedAt, previousSince: null },
			{ from: "open", to: "closed", at: closedAt, previousSince: openedAt },
		]);
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

	it("by default reports after 10 failures in a row: about 5 minutes at the default interval", async () => {
		const { service, fetch, reportError } = setup();
		for (let i = 0; i < 12; i++) fetch.fail(new Error("down"));
		for (let i = 0; i < 9; i++) await service.checkNow().catch(() => {});
		expect(reportError).not.toHaveBeenCalled();
		await service.checkNow().catch(() => {});
		expect(reportError).toHaveBeenCalledOnce();
		expect(String(reportError.mock.calls[0]?.[0])).toMatch(/10 times in a row/);
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

	it("polls every 30 seconds by default, and says so", async () => {
		vi.useFakeTimers();
		const fetch = fakeFetch();
		for (let i = 0; i < 4; i++) fetch.json(open(true));
		const service = new SpaceApiStatus({
			url: URL,
			logger: silentLogger,
			reportError: vi.fn(),
			fetch: fetch.fn,
		});
		expect(service.pollIntervalMs).toBe(30_000);

		service.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(fetch.fn).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(29_999);
		expect(fetch.fn).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(fetch.fn).toHaveBeenCalledTimes(2);
		service.stop();
	});

	it("reports the interval it was given", () => {
		const service = new SpaceApiStatus({
			url: URL,
			logger: silentLogger,
			reportError: vi.fn(),
			pollIntervalMs: 1234,
		});
		expect(service.pollIntervalMs).toBe(1234);
	});

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

describe("persistence", () => {
	// setup()'s clock starts at 2026-10-03T12:00:00Z.
	const earlier = new Date("2026-10-03T09:30:00Z");

	it("keeps the saved 'since' when the live state matches, and doesn't rewrite it", async () => {
		const store = fakeStore({ state: "open", since: earlier });
		const { service, fetch } = setup({ store });
		fetch.json(open(true));
		const listener = vi.fn();
		service.onChange(listener);
		expect(await service.checkNow()).toMatchObject({ state: "open", since: earlier });
		expect(store.saves).toEqual([]);
		expect(listener).not.toHaveBeenCalled();
	});

	it("knows the saved time even before the first live check finishes", async () => {
		const store = fakeStore({ state: "closed", since: earlier });
		const { service, fetch } = setup({ store });
		fetch.json(open(false)).json(open(false));
		// Two checks in a row: the restored time must survive both.
		await service.checkNow();
		expect((await service.checkNow()).since).toEqual(earlier);
	});

	it("clears 'since' and stays quiet when the state changed while Pixel was down", async () => {
		const store = fakeStore({ state: "open", since: earlier });
		const { service, fetch } = setup({ store });
		const listener = vi.fn();
		service.onChange(listener);
		fetch.json(open(false));
		expect(await service.checkNow()).toMatchObject({ state: "closed", since: null });
		expect(listener).not.toHaveBeenCalled();
		expect(store.saves).toEqual([{ state: "closed", since: null }]);
	});

	it("announces changes that happen after startup once the saved state is confirmed", async () => {
		const store = fakeStore({ state: "open", since: earlier });
		const { service, fetch, advance } = setup({ store });
		const changes: SpaceChange[] = [];
		service.onChange((c) => changes.push(c));
		fetch.json(open(true)).json(open(false));
		await service.checkNow();
		const at = advance(60_000);
		await service.checkNow();
		expect(changes).toEqual([{ from: "open", to: "closed", at, previousSince: earlier }]);
		expect(store.saves).toEqual([{ state: "closed", since: at }]);
	});

	it("doesn't treat an 'unknown' reading as confirming the saved state", async () => {
		const store = fakeStore({ state: "open", since: earlier });
		const { service, fetch } = setup({ store });
		const listener = vi.fn();
		service.onChange(listener);
		fetch.json(open(null)).json(open(false));
		await service.checkNow();
		// Still unconfirmed, so a differing definite reading is "changed while down", not a live change.
		expect(await service.checkNow()).toMatchObject({ state: "closed", since: null });
		expect(listener).not.toHaveBeenCalled();
	});

	it("saves the first observation when nothing was saved", async () => {
		const store = fakeStore();
		const { service, fetch } = setup({ store });
		fetch.json(open(true));
		await service.checkNow();
		expect(store.saves).toEqual([{ state: "open", since: null }]);
	});

	it("saves every change with its time", async () => {
		const store = fakeStore();
		const { service, fetch, advance } = setup({ store });
		fetch.json(open(false)).json(open(true)).json(open(true));
		await service.checkNow();
		const at = advance(60_000);
		await service.checkNow();
		advance(60_000);
		await service.checkNow();
		expect(store.saves).toEqual([
			{ state: "closed", since: null },
			{ state: "open", since: at },
		]);
	});

	it("ignores a saved time in the future", async () => {
		const store = fakeStore({ state: "open", since: new Date("2026-10-04T00:00:00Z") });
		const { service, fetch } = setup({ store });
		fetch.json(open(true));
		expect(await service.checkNow()).toMatchObject({ state: "open", since: null });
	});

	it("starts fresh, without failing, when the saved state is unusable", async () => {
		const store = fakeStore();
		store.loadError = new Error("space.state has an unexpected shape");
		const { service, fetch } = setup({ store });
		fetch.json(open(true));
		expect(await service.checkNow()).toMatchObject({ state: "open", since: null });
		expect(store.saves).toEqual([{ state: "open", since: null }]);
	});

	it("keeps checking when saving fails, and reports the failure only once", async () => {
		const store = fakeStore();
		store.saveError = new Error("EROFS");
		const { service, fetch, reportError, advance } = setup({ store });
		fetch.json(open(false)).json(open(true)).json(open(false));
		await expect(service.checkNow()).resolves.toMatchObject({ state: "closed" });
		advance(60_000);
		await expect(service.checkNow()).resolves.toMatchObject({ state: "open" });
		advance(60_000);
		await expect(service.checkNow()).resolves.toMatchObject({ state: "closed" });
		expect(reportError).toHaveBeenCalledOnce();
		expect(String(reportError.mock.calls[0]?.[0])).toMatch(/couldn't save space state/);
	});

	it("works without a store", async () => {
		const { service, fetch } = setup();
		fetch.json(open(true));
		expect((await service.checkNow()).since).toBeNull();
	});
});
