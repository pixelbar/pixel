import { describe, expect, it, vi } from "vitest";
import { HttpRevbank } from "./revbank.ts";

const actor = "discord:100000000000000001";
const target = "discord:100000000000000002";
const token = "fake-token-for-testing-only-not-secret";
const requestId = "10000000-0000-4000-8000-000000000001";
const at = "2026-10-21T10:00:00+00:00";

function setup(body: unknown = {}) {
	const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(body));
	return { fetch, api: new HttpRevbank({ url: "https://gateway.example/", token, fetch }) };
}

describe("private RevBank client", () => {
	it("sends only the authenticated actor and operation, without redirects", async () => {
		const { api, fetch } = setup({ balanceCents: 1234, updatedAt: at });
		expect(await api.balance(actor)).toEqual({ balanceCents: 1234, updatedAt: at });
		const call = fetch.mock.calls[0];
		if (!call) throw new Error("No request");
		const [url, init] = call;
		expect(String(url)).toBe("https://gateway.example/v1/balance");
		expect(init).toMatchObject({
			method: "POST",
			redirect: "error",
			body: JSON.stringify({ actor }),
			headers: { authorization: `Bearer ${token}` },
		});
		expect(init?.signal).toBeInstanceOf(AbortSignal);
	});
	it("implements the link lifecycle and manager actions", async () => {
		const { api, fetch } = setup({ state: "unlinked" });
		expect(await api.status(actor)).toEqual({ state: "unlinked" });
		fetch.mockResolvedValueOnce(
			Response.json({ state: "pending", nick: "Example", requestId, expiresAt: at }),
		);
		expect(await api.request(actor, "Example")).toMatchObject({ requestId });
		fetch.mockResolvedValueOnce(Response.json({ state: "linked", nick: "Example" }));
		expect((await api.review(actor, target)).state).toBe("linked");
		fetch.mockImplementation(async () => Response.json({}));
		await api.unlink(actor);
		await api.decide(actor, target, requestId, true);
		await api.decide(actor, target, requestId, false);
		await api.revoke(actor, target);
		expect(
			fetch.mock.calls
				.slice(-3)
				.map(([url, init]) => [String(url), JSON.parse(String(init?.body))]),
		).toEqual([
			["https://gateway.example/v1/approve", { actor, target, requestId }],
			["https://gateway.example/v1/reject", { actor, target, requestId }],
			["https://gateway.example/v1/revoke", { actor, target }],
		]);
	});
	it("validates history and rejects unexpected fields or unsafe numbers", async () => {
		const body = {
			updatedAt: at,
			transactions: [{ id: "1", at, amountCents: -150, balanceCents: 850, description: "Cola" }],
		};
		const { api, fetch } = setup(body);
		expect(await api.history(actor)).toEqual(body);
		for (const bad of [
			{ ...body, accounts: [] },
			{ updatedAt: "yesterday", transactions: [] },
			{ updatedAt: at, transactions: Array(11).fill(body.transactions[0]) },
		]) {
			fetch.mockResolvedValueOnce(Response.json(bad));
			await expect(api.history(actor)).rejects.toMatchObject({ code: "unavailable" });
		}
		fetch.mockResolvedValueOnce(
			Response.json({ balanceCents: Number.MAX_SAFE_INTEGER + 1, updatedAt: at }),
		);
		await expect(api.balance(actor)).rejects.toMatchObject({ code: "unavailable" });
	});
	it.each([
		[403, "denied"],
		[404, "not-linked"],
		[409, "conflict"],
		[503, "unavailable"],
	])("maps HTTP %s without retaining the body", async (status, code) => {
		const { api, fetch } = setup();
		fetch.mockResolvedValueOnce(
			new Response("private upstream details", { status: Number(status) }),
		);
		await expect(api.balance(actor)).rejects.toMatchObject({ code });
		fetch.mockResolvedValueOnce(new Response(null, { status: Number(status) }));
		await expect(api.balance(actor)).rejects.toMatchObject({ code });
	});
	it("discards network errors, invalid JSON and missing bodies", async () => {
		const { api, fetch } = setup();
		fetch.mockRejectedValueOnce(new Error(`private URL and ${token}`));
		await expect(api.balance(actor)).rejects.toThrow("RevBank: unavailable");
		fetch.mockResolvedValueOnce(new Response("not json"));
		await expect(api.balance(actor)).rejects.toThrow("RevBank: unavailable");
		fetch.mockResolvedValueOnce(new Response(null));
		await expect(api.balance(actor)).rejects.toThrow("RevBank: unavailable");
	});
	it("bounds chunked response bodies and cancels the stream", async () => {
		const { api, fetch } = setup();
		const cancel = vi.fn();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(16_385));
			},
			cancel,
		});
		fetch.mockResolvedValueOnce(new Response(stream));
		await expect(api.history(actor)).rejects.toMatchObject({ code: "unavailable" });
		expect(cancel).toHaveBeenCalledOnce();
	});
	it("uses the default fetch when not injected", async () => {
		const fetch = vi.fn().mockResolvedValue(Response.json({ state: "unlinked" }));
		vi.stubGlobal("fetch", fetch);
		try {
			await new HttpRevbank({ url: "https://gateway.example/", token }).status(actor);
		} finally {
			vi.unstubAllGlobals();
		}
		expect(fetch).toHaveBeenCalledOnce();
	});
});
