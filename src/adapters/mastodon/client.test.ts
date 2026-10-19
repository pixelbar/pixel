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
		response(make: () => Response) {
			queue.push(async () => make());
			return this;
		},
		fail(error: unknown) {
			queue.push(async () => Promise.reject(error));
			return this;
		},
	};
}

/** A streamed body of `chunks` chunks of `chunkSize` bytes that records how much was read and whether it was cancelled. */
function streamedBody(chunks: number, chunkSize: number, options: { cancelFails?: boolean } = {}) {
	const state = { pulled: 0, cancelled: false };
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (state.pulled >= chunks) {
				controller.close();
				return;
			}
			state.pulled += 1;
			controller.enqueue(new Uint8Array(chunkSize).fill(120));
		},
		cancel() {
			state.cancelled = true;
			if (options.cancelFails) throw new Error(`cancel failed ${TOKEN}`);
		},
	});
	return { stream, state };
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

	it("cancels a body whose declared content-length is over the limit, without reading it", async () => {
		const { stream, state } = streamedBody(10, 100);
		const fetch = fakeFetch().response(
			() => new Response(stream, { status: 200, headers: { "content-length": "1000" } }),
		);
		await new MastodonClient({
			instanceUrl: INSTANCE,
			token: TOKEN,
			fetch: fetch.fn,
			maxResponseBytes: 50,
		}).postStatus({ status: "ok", visibility: "public" });
		expect(state.cancelled).toBe(true);
		expect(state.pulled).toBeLessThanOrEqual(1);
	});

	it("stops reading a chunked body once it passes the limit and cancels it", async () => {
		const { stream, state } = streamedBody(1000, 64);
		const fetch = fakeFetch().response(() => new Response(stream, { status: 200 }));
		await new MastodonClient({
			instanceUrl: INSTANCE,
			token: TOKEN,
			fetch: fetch.fn,
			maxResponseBytes: 100,
		}).postStatus({ status: "ok", visibility: "public" });
		expect(state.cancelled).toBe(true);
		// Two chunks pass the limit; allow for the stream queueing one more ahead.
		expect(state.pulled).toBeLessThanOrEqual(3);
	});

	it("still throws the safe HTTP error when an oversized error body is cancelled", async () => {
		const { stream, state } = streamedBody(1000, 64);
		const fetch = fakeFetch().response(() => new Response(stream, { status: 500 }));
		const error = await new MastodonClient({
			instanceUrl: INSTANCE,
			token: TOKEN,
			fetch: fetch.fn,
			maxResponseBytes: 100,
		})
			.postStatus({ status: "x", visibility: "public" })
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(MastodonError);
		expect((error as Error).message).toBe("Mastodon responded with HTTP 500");
		expect(state.cancelled).toBe(true);
	});

	it("reads a chunked body under the limit to the end", async () => {
		const { stream, state } = streamedBody(3, 10);
		const fetch = fakeFetch().response(() => new Response(stream, { status: 200 }));
		await client(fetch.fn).postStatus({ status: "ok", visibility: "public" });
		expect(state.pulled).toBe(3);
		expect(state.cancelled).toBe(false);
	});

	it("accepts a response with no body", async () => {
		const fetch = fakeFetch().response(() => new Response(null, { status: 204 }));
		await expect(
			client(fetch.fn).postStatus({ status: "ok", visibility: "public" }),
		).resolves.toBeUndefined();
	});

	it("ignores a failed cancel of an oversized body", async () => {
		const declared = streamedBody(10, 100, { cancelFails: true });
		const chunked = streamedBody(1000, 64, { cancelFails: true });
		const fetch = fakeFetch()
			.response(
				() =>
					new Response(declared.stream, {
						status: 200,
						headers: { "content-length": "1000" },
					}),
			)
			.response(() => new Response(chunked.stream, { status: 200 }));
		const small = new MastodonClient({
			instanceUrl: INSTANCE,
			token: TOKEN,
			fetch: fetch.fn,
			maxResponseBytes: 100,
		});
		await expect(small.postStatus({ status: "ok", visibility: "public" })).resolves.toBeUndefined();
		await expect(small.postStatus({ status: "ok", visibility: "public" })).resolves.toBeUndefined();
		expect(declared.state.cancelled).toBe(true);
		expect(chunked.state.cancelled).toBe(true);
	});
});
