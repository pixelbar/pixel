import { describe, expect, it, vi } from "vitest";
import {
	HttpSpaceStateApi,
	OBSERVED_BODY_CHARS,
	SpaceStateApiError,
	type SpaceStateExchange,
} from "./space-state-api.ts";

const URL_ = "https://space.example/api/state";
const USER = "pixel-test-user";
const TOKEN = "spacestate-test-token";

function api(fetch: typeof globalThis.fetch, extras: { timeoutMs?: number } = {}) {
	return new HttpSpaceStateApi({ url: URL_, user: USER, token: TOKEN, fetch, ...extras });
}

const respond = (body: string, init?: ResponseInit) =>
	vi.fn<typeof globalThis.fetch>(async () => new Response(body, init));

/** Runs `work` and returns what it threw, failing the test if it didn't. */
async function thrown(work: Promise<unknown>): Promise<SpaceStateApiError> {
	try {
		await work;
	} catch (error) {
		expect(error).toBeInstanceOf(SpaceStateApiError);
		return error as SpaceStateApiError;
	}
	throw new Error("expected it to throw");
}

describe("HttpSpaceStateApi.set", () => {
	it.each(["open", "closed"] as const)("POSTs state=%s with the user and token", async (state) => {
		const fetch = respond("SUCCESS", { status: 200 });
		await api(fetch).set(state);

		expect(fetch).toHaveBeenCalledOnce();
		const [url, init] = fetch.mock.calls[0] ?? [];
		const sent = new URL(String(url));
		expect(`${sent.origin}${sent.pathname}`).toBe(URL_);
		expect(Object.fromEntries(sent.searchParams)).toEqual({
			user: USER,
			token: TOKEN,
			state,
		});
		expect(init?.method).toBe("POST");
	});

	it("sends the extra headers, but can't override accept", async () => {
		const fetch = respond("SUCCESS");
		await new HttpSpaceStateApi({
			url: URL_,
			user: USER,
			token: TOKEN,
			headers: { "X-Example": "value-1", Accept: "text/html", accept: "x" },
			fetch,
		}).set("open");
		const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
		expect(headers.get("x-example")).toBe("value-1");
		expect(headers.get("accept")).toBe("text/plain");
	});

	it("never follows a redirect, because the token is in the URL", async () => {
		const fetch = respond("SUCCESS");
		await api(fetch).set("open");
		expect(fetch.mock.calls[0]?.[1]?.redirect).toBe("error");
	});

	it("keeps what is already in the address and encodes odd characters", async () => {
		const fetch = respond("SUCCESS");
		await new HttpSpaceStateApi({
			url: `${URL_}?space=pixelbar`,
			user: "a b&c",
			token: "t=o/k+e n",
			fetch,
		}).set("open");

		const sent = new URL(String(fetch.mock.calls[0]?.[0]));
		expect(sent.searchParams.get("space")).toBe("pixelbar");
		expect(sent.searchParams.get("user")).toBe("a b&c");
		expect(sent.searchParams.get("token")).toBe("t=o/k+e n");
		expect(sent.searchParams.getAll("state")).toEqual(["open"]);
	});

	it("accepts SUCCESS with surrounding whitespace", async () => {
		await expect(api(respond(" SUCCESS\n")).set("open")).resolves.toBeUndefined();
	});

	it.each(["", "success", "FAILURE", "SUCCESS, but not really", "ERROR: bad token", "{}"])(
		"says the change wasn't accepted for the body %j, without repeating it",
		async (body) => {
			const error = await thrown(api(respond(body, { status: 200 })).set("closed"));
			expect(error.message).toBe("Space state API did not accept the change");
			if (body.length > 2) expect(error.message).not.toContain(body);
		},
	);

	it("reports an HTTP error status", async () => {
		const error = await thrown(api(respond("SUCCESS", { status: 403 })).set("open"));
		expect(error.message).toBe("Space state API responded with HTTP 403");
	});

	it("reports a failed request without the URL, the token or a cause", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => {
			throw new TypeError(`fetch failed: ${URL_}?user=${USER}&token=${TOKEN}`);
		});
		const error = await thrown(api(fetch).set("open"));
		expect(error.message).toBe("Space state API request failed (TypeError)");
		expect(error.cause).toBeUndefined();
		expect(JSON.stringify(error)).not.toContain(TOKEN);
		expect(String(error.stack)).not.toContain(TOKEN);
	});

	it("reports a request that times out", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			(_url, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
				}),
		);
		const error = await thrown(api(fetch, { timeoutMs: 5 }).set("open"));
		expect(error.message).toMatch(/^Space state API request failed \(/);
	});

	it("refuses a response that declares itself too large", async () => {
		const fetch = respond("SUCCESS", { headers: { "content-length": "999999" } });
		const error = await thrown(api(fetch).set("open"));
		expect(error.message).toBe("Space state API response too large");
	});

	it("refuses a response that turns out too large", async () => {
		const error = await thrown(api(respond("SUCCESS".padEnd(10_000, " "))).set("open"));
		expect(error.message).toBe("Space state API response too large");
	});

	it("reports a body that can't be read", async () => {
		const broken = new Response("SUCCESS");
		vi.spyOn(broken, "text").mockRejectedValue(new Error("socket hang up"));
		const fetch = vi.fn<typeof globalThis.fetch>(async () => broken);
		const error = await thrown(api(fetch).set("open"));
		expect(error.message).toBe("Space state API response could not be read");
	});
});

describe("HttpSpaceStateApi observe", () => {
	function watched(fetch: typeof globalThis.fetch, observe?: (e: SpaceStateExchange) => void) {
		const seen: SpaceStateExchange[] = [];
		const instance = new HttpSpaceStateApi({
			url: URL_,
			user: USER,
			token: TOKEN,
			headers: { "X-Secret-Header": "header-secret" },
			fetch,
			observe: observe ?? ((exchange) => seen.push(exchange)),
		});
		return { instance, seen };
	}

	it("shows the request and the response of a successful call, without secrets", async () => {
		const { instance, seen } = watched(
			respond("SUCCESS", { headers: { "content-type": "text/plain", "content-length": "7" } }),
		);
		await instance.set("closed");

		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({
			request: {
				method: "POST",
				url: `${URL_}?user=[redacted]&token=[redacted]&state=closed`,
				state: "closed",
			},
			response: { status: 200, contentType: "text/plain", contentLength: "7", body: "SUCCESS" },
			outcome: "success",
		});
		expect(seen[0]?.durationMs).toBeGreaterThanOrEqual(0);
		const text = JSON.stringify(seen);
		for (const secret of [TOKEN, USER, "header-secret", "X-Secret-Header"]) {
			expect(text).not.toContain(secret);
		}
	});

	it("shows what a rejecting API said, while the error still doesn't repeat it", async () => {
		const { instance, seen } = watched(respond("ERROR: bad token", { status: 200 }));
		const error = await thrown(instance.set("open"));
		expect(error.message).not.toContain("bad token");
		expect(seen[0]).toMatchObject({
			outcome: "rejected",
			response: { status: 200, body: "ERROR: bad token" },
		});
	});

	it("shows an HTTP error status and its body", async () => {
		const { instance, seen } = watched(respond("Forbidden", { status: 403 }));
		await thrown(instance.set("open"));
		expect(seen[0]).toMatchObject({
			outcome: "http-error",
			response: { status: 403, body: "Forbidden" },
		});
	});

	it("shows a network error by name only, with no response", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => {
			throw new TypeError(`fetch failed: ${URL_}?user=${USER}&token=${TOKEN}`);
		});
		const { instance, seen } = watched(fetch);
		await thrown(instance.set("open"));
		expect(seen[0]).toMatchObject({ outcome: "network-error", errorName: "TypeError" });
		expect(seen[0]?.response).toBeUndefined();
		expect(JSON.stringify(seen)).not.toContain(TOKEN);
	});

	it("cuts a long body for display and strips control characters", async () => {
		const body = `a\u0000b\u001b${"x".repeat(OBSERVED_BODY_CHARS)}`;
		const { instance, seen } = watched(respond(body, { status: 200 }));
		await thrown(instance.set("open"));
		const shown = seen[0]?.response;
		expect(shown?.truncated).toBe(true);
		expect(shown?.body).toHaveLength(OBSERVED_BODY_CHARS);
		expect(shown?.body?.startsWith("a\uFFFDb\uFFFDx")).toBe(true);
	});

	it("never passes on a body over the size cap", async () => {
		const { instance, seen } = watched(respond("SUCCESS".padEnd(10_000, " ")));
		await thrown(instance.set("open"));
		expect(seen[0]).toMatchObject({ outcome: "too-large", response: { status: 200 } });
		expect(seen[0]?.response?.body).toBeUndefined();
	});

	it("doesn't read a body that declares itself too large", async () => {
		const response = new Response("SUCCESS", { headers: { "content-length": "999999" } });
		const text = vi.spyOn(response, "text");
		const { instance, seen } = watched(vi.fn<typeof globalThis.fetch>(async () => response));
		await thrown(instance.set("open"));
		expect(text).not.toHaveBeenCalled();
		expect(seen[0]?.outcome).toBe("too-large");
	});

	it("shows a body that can't be read", async () => {
		const broken = new Response("SUCCESS");
		vi.spyOn(broken, "text").mockRejectedValue(new Error("socket hang up"));
		const { instance, seen } = watched(vi.fn<typeof globalThis.fetch>(async () => broken));
		await thrown(instance.set("open"));
		expect(seen[0]).toMatchObject({ outcome: "unreadable", response: { status: 200 } });
	});

	it("is not affected by an observer that throws", async () => {
		const { instance } = watched(respond("SUCCESS"), () => {
			throw new Error("observer broke");
		});
		await expect(instance.set("open")).resolves.toBeUndefined();
		const failing = watched(respond("nope"), () => {
			throw new Error("observer broke");
		}).instance;
		expect((await thrown(failing.set("open"))).message).toBe(
			"Space state API did not accept the change",
		);
	});
});
