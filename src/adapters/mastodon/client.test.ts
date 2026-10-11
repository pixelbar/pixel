import { describe, expect, it, vi } from "vitest";
import { MastodonClient, MastodonError } from "./client.ts";

const INSTANCE = "https://mastodon.example";
const TOKEN = "test-token";

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

function client(fetch: typeof globalThis.fetch, extras: { timeoutMs?: number } = {}) {
	return new MastodonClient({ instanceUrl: INSTANCE, token: TOKEN, fetch, ...extras });
}

describe("MastodonClient.postStatus", () => {
	it("POSTs the status to /api/v1/statuses with a bearer token", async () => {
		const fetch = fakeFetch().json({ id: "1" }, { status: 200 });
		await client(fetch.fn).postStatus({ status: "🟢 Pixelbar is now open", visibility: "public" });

		expect(fetch.fn).toHaveBeenCalledOnce();
		const [url, init] = fetch.fn.mock.calls[0] ?? [];
		expect(url).toBe("https://mastodon.example/api/v1/statuses");
		expect(init?.method).toBe("POST");
		expect(init?.redirect).toBe("error");
		const headers = new Headers(init?.headers);
		expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
		expect(headers.get("content-type")).toBe("application/json");
		expect(JSON.parse(String(init?.body))).toEqual({
			status: "🟢 Pixelbar is now open",
			visibility: "public",
			language: "en",
		});
	});

	it("strips a trailing slash on the instance URL", async () => {
		const fetch = fakeFetch().json({ id: "1" }, { status: 200 });
		await new MastodonClient({
			instanceUrl: `${INSTANCE}/`,
			token: TOKEN,
			fetch: fetch.fn,
		}).postStatus({ status: "ok", visibility: "unlisted" });
		expect(fetch.fn.mock.calls[0]?.[0]).toBe("https://mastodon.example/api/v1/statuses");
	});

	it("throws a safe error on a non-OK response, without the token or body", async () => {
		const fetch = fakeFetch().raw(`unauthorized ${TOKEN}`, { status: 401 });
		let message = "";
		try {
			await client(fetch.fn).postStatus({ status: "x", visibility: "public" });
		} catch (error) {
			expect(error).toBeInstanceOf(MastodonError);
			message = (error as Error).message;
		}
		expect(message).toBe("Mastodon responded with HTTP 401");
		expect(message).not.toContain(TOKEN);
		expect(message).not.toContain("unauthorized");
	});

	it("throws a safe error when the request fails", async () => {
		const fetch = fakeFetch().fail(new Error(`network ${TOKEN}`));
		const error = await client(fetch.fn)
			.postStatus({ status: "x", visibility: "public" })
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(MastodonError);
		expect((error as Error).message).toBe("Mastodon request failed");
		expect((error as Error).message).not.toContain(TOKEN);
	});

	it("accepts a large declared content-length without putting the body in an error", async () => {
		const fetch = fakeFetch().raw("ignored", {
			status: 200,
			headers: { "content-length": "999999" },
		});
		await expect(
			client(fetch.fn).postStatus({ status: "ok", visibility: "public" }),
		).resolves.toBeUndefined();
	});

	it("accepts an oversized body without putting it in an error", async () => {
		const fetch = fakeFetch().raw("x".repeat(200), { status: 200 });
		await expect(
			new MastodonClient({
				instanceUrl: INSTANCE,
				token: TOKEN,
				fetch: fetch.fn,
				maxResponseBytes: 50,
			}).postStatus({ status: "ok", visibility: "public" }),
		).resolves.toBeUndefined();
	});
});
