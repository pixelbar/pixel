import { describe, expect, it, vi } from "vitest";
import { createAcceptClient } from "../../../src/adapters/pixel-phone/accept.ts";

const CALL = "20261118-3f9a1c2b7d4e";
// Obviously not a real key.
const KEY = "test-key-not-real-0123456789abcdef";

const respond = (status: number, body: unknown = {}) =>
	vi.fn(
		async (_url: string | URL | Request, _init?: RequestInit) =>
			new Response(typeof body === "string" ? body : JSON.stringify(body), {
				status,
				headers: { "content-type": "application/json" },
			}),
	);

const client = (fetch: ReturnType<typeof vi.fn>, timeoutMs?: number) =>
	createAcceptClient({
		url: "https://phone.example",
		apiKey: KEY,
		fetch: fetch as unknown as typeof globalThis.fetch,
		...(timeoutMs ? { timeoutMs } : {}),
	});

describe("the accept client", () => {
	it("posts to the call's accept route with Pixel's key and who's answering, once, without redirects", async () => {
		const fetch = respond(202, { callId: CALL });
		expect(await client(fetch).accept(CALL, "discord:1234")).toEqual({ kind: "accepted" });
		expect(fetch).toHaveBeenCalledTimes(1);
		const [url, init] = fetch.mock.calls[0] ?? [];
		expect(url).toBe(`https://phone.example/api/v1/calls/${CALL}/accept`);
		expect(init).toMatchObject({
			method: "POST",
			headers: {
				authorization: `Bearer ${KEY}`,
				"content-type": "application/json",
				accept: "application/json",
			},
			body: JSON.stringify({ by: "discord:1234" }),
			redirect: "error",
		});
		expect(init?.signal).toBeInstanceOf(AbortSignal);
	});

	it.each([404, 410])("says it's too late on %i", async (status) => {
		expect(await client(respond(status, { callId: CALL })).accept(CALL, "discord:1")).toEqual({
			kind: "too-late",
		});
	});

	it("says who was first on 409", async () => {
		expect(
			await client(respond(409, { callId: CALL, via: "pixel", by: "discord:9" })).accept(CALL, "x"),
		).toEqual({ kind: "already", via: "pixel", by: "discord:9" });
		expect(
			await client(respond(409, { callId: CALL, via: "home-assistant" })).accept(CALL, "x"),
		).toEqual({ kind: "already", via: "home-assistant" });
	});

	it.each([
		["not JSON", "<html>"],
		["no via", { callId: CALL }],
		["too big", JSON.stringify({ via: "x", pad: "y".repeat(3000) })],
	])("still says someone was first on a 409 that's %s", async (_label, body) => {
		expect(await client(respond(409, body)).accept(CALL, "x")).toEqual({
			kind: "already",
			via: "unknown",
		});
	});

	it.each([400, 401, 429, 500, 503, 302])("fails on %i, with the status", async (status) => {
		expect(await client(respond(status)).accept(CALL, "x")).toEqual({
			kind: "failed",
			why: "status",
			status,
		});
	});

	it("fails on a network error", async () => {
		const fetch = vi.fn(async () => {
			throw new TypeError("fetch failed");
		});
		expect(await client(fetch).accept(CALL, "x")).toEqual({ kind: "failed", why: "network" });
	});

	it("gives up after its time limit", async () => {
		const fetch = vi.fn(
			(_url: string, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
				}),
		);
		expect(await client(fetch, 20).accept(CALL, "x")).toEqual({ kind: "failed", why: "timeout" });
	});

	it("never sends anything for a call ID that isn't one", async () => {
		const fetch = respond(202);
		expect(await client(fetch).accept("../../admin", "x")).toEqual({ kind: "too-late" });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("uses only pixel-phone's origin", async () => {
		const fetch = respond(202);
		await createAcceptClient({
			url: "https://phone.example/",
			apiKey: KEY,
			fetch: fetch as unknown as typeof globalThis.fetch,
		}).accept(CALL, "x");
		expect(fetch.mock.calls[0]?.[0]).toBe(`https://phone.example/api/v1/calls/${CALL}/accept`);
	});
});
