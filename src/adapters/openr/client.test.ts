import { describe, expect, it, vi } from "vitest";
import {
	ACCESS_COOKIE,
	APP_VERSION,
	cookieHeader,
	OpenrClient,
	OpenrError,
	type OpenrSession,
	REFRESH_COOKIE,
	sessionCookies,
} from "./client.ts";

// Obviously fake values. Never put anything that looks like a real credential here.
const BASE = "https://openr.example/api/v4";
const EMAIL = "pixel@example.invalid";
const PASSWORD = "not-a-real-password";
const ACCESS_EXP = 1_900_000_000;
const REFRESH_EXP = 1_900_600_000;

type Call = { url: string; init: RequestInit };

function fakeFetch() {
	const calls: Call[] = [];
	const queue: (() => Promise<Response>)[] = [];
	const fn = vi.fn<typeof globalThis.fetch>(async (input, init) => {
		calls.push({ url: String(input), init: init ?? {} });
		const next = queue.shift();
		if (!next) throw new Error("unexpected fetch");
		return next();
	});
	const api = {
		fn,
		calls,
		json(body: unknown, init: ResponseInit = {}) {
			queue.push(async () => new Response(JSON.stringify(body), init));
			return api;
		},
		raw(body: ConstructorParameters<typeof Response>[0], init: ResponseInit = {}) {
			queue.push(async () => new Response(body, init));
			return api;
		},
		fail(error: unknown) {
			queue.push(async () => Promise.reject(error));
			return api;
		},
		hang() {
			queue.push(
				() =>
					new Promise<Response>((_, reject) => {
						const signal = calls.at(-1)?.init.signal;
						signal?.addEventListener("abort", () => reject(signal.reason));
					}),
			);
			return api;
		},
	};
	return api;
}

function client(
	fetch: typeof globalThis.fetch,
	extras: { timeoutMs?: number; maxResponseBytes?: number } = {},
) {
	return new OpenrClient({ baseUrl: `${BASE}/`, fetch, ...extras });
}

function headersOf(call: Call | undefined): Record<string, string> {
	return (call?.init.headers ?? {}) as Record<string, string>;
}

function sessionAnswer(extra: { access?: string | null; refresh?: string | null } = {}) {
	return {
		data: {
			access: null,
			refresh: null,
			access_exp: ACCESS_EXP,
			refresh_exp: REFRESH_EXP,
			...extra,
		},
	};
}

function setCookies(...lines: string[]): Headers {
	const headers = new Headers({ "content-type": "application/json" });
	for (const line of lines) headers.append("set-cookie", line);
	return headers;
}

const COOKIES = setCookies(
	`${ACCESS_COOKIE}=access-one; Path=/api/v4; HttpOnly; Secure`,
	`${REFRESH_COOKIE}=refresh-one; Path=/api/v4/me/current_session/refresh; HttpOnly; Secure`,
);

function session(overrides: Partial<OpenrSession> = {}): OpenrSession {
	return {
		cookies: { [ACCESS_COOKIE]: "access-one", [REFRESH_COOKIE]: "refresh-one" },
		accessToken: undefined,
		refreshToken: undefined,
		accessUntil: new Date(ACCESS_EXP * 1000),
		refreshUntil: new Date(REFRESH_EXP * 1000),
		...overrides,
	};
}

describe("OpenrClient.login", () => {
	it("posts the account like the dashboard does, and gets the token for the emailed code", async () => {
		const http = fakeFetch().json({ data: { protosession_token: "proto-1" } });
		expect(await client(http.fn).login(EMAIL, PASSWORD)).toEqual({
			kind: "code",
			token: "proto-1",
		});
		const [call] = http.calls;
		expect(call?.url).toBe(`${BASE}/me/current_session`);
		expect(call?.init.method).toBe("POST");
		expect(call?.init.redirect).toBe("error");
		expect(call?.init.signal).toBeInstanceOf(AbortSignal);
		expect(JSON.parse(String(call?.init.body))).toEqual({
			email: EMAIL,
			password: PASSWORD,
			persistent_session: true,
			token_signature_transport: "cookie_only",
		});
		expect(headersOf(call)).toEqual({
			accept: "application/json",
			"content-type": "application/json",
			origin: "https://openr.example",
			"x-csrf-token": "anything",
			"yy-app-version": APP_VERSION,
		});
	});

	it("takes the session at once from an account that needs no code", async () => {
		const http = fakeFetch().json(sessionAnswer(), { headers: COOKIES });
		expect(await client(http.fn).login(EMAIL, PASSWORD)).toEqual({
			kind: "session",
			session: session(),
		});
	});

	it("says OpenR refused it, without the password", async () => {
		const http = fakeFetch().json({ errors: { password: [PASSWORD] } }, { status: 401 });
		const error = await client(http.fn)
			.login(EMAIL, PASSWORD)
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(OpenrError);
		expect(error).toMatchObject({ kind: "http", status: 401, refused: true });
		expect(String((error as Error).message)).not.toContain(PASSWORD);
	});

	it("fails on an answer with neither a token nor a session", async () => {
		const http = fakeFetch().json({ data: {} });
		await expect(client(http.fn).login(EMAIL, PASSWORD)).rejects.toMatchObject({
			kind: "response",
		});
	});
});

describe("OpenrClient.completeLogin", () => {
	it("sends the token and the code, and reads the cookies and expiry times", async () => {
		const http = fakeFetch().json(sessionAnswer(), { headers: COOKIES });
		expect(await client(http.fn).completeLogin("proto-1", "123456")).toEqual(session());
		expect(http.calls[0]?.url).toBe(`${BASE}/me/current_session/mfa`);
		expect(JSON.parse(String(http.calls[0]?.init.body))).toEqual({
			token: "proto-1",
			mfa_code: "123456",
		});
	});

	it("keeps bearer tokens when OpenR puts them in the body instead", async () => {
		const http = fakeFetch().json(sessionAnswer({ access: "a-token", refresh: "r-token" }));
		expect(await client(http.fn).completeLogin("proto-1", "123456")).toEqual(
			session({ cookies: {}, accessToken: "a-token", refreshToken: "r-token" }),
		);
	});

	it("needs both an access and a refresh credential", async () => {
		const onlyAccess = fakeFetch().json(sessionAnswer(), {
			headers: setCookies(`${ACCESS_COOKIE}=a`),
		});
		await expect(client(onlyAccess.fn).completeLogin("p", "1")).rejects.toThrow(
			/no refresh cookie/,
		);
		const onlyRefresh = fakeFetch().json(sessionAnswer(), {
			headers: setCookies(`${REFRESH_COOKIE}=r`),
		});
		await expect(client(onlyRefresh.fn).completeLogin("p", "1")).rejects.toThrow(
			/no access cookie/,
		);
	});

	it("needs the expiry times", async () => {
		const http = fakeFetch().json({ data: { access_exp: ACCESS_EXP } }, { headers: COOKIES });
		await expect(client(http.fn).completeLogin("p", "1")).rejects.toThrow(/no session/);
	});

	it("refuses a wrong code as refused", async () => {
		const http = fakeFetch().json({}, { status: 422 });
		await expect(client(http.fn).completeLogin("p", "1")).rejects.toMatchObject({ refused: true });
	});
});

describe("OpenrClient.refresh", () => {
	it("sends both cookies and keeps what OpenR doesn't replace", async () => {
		const http = fakeFetch().json(sessionAnswer(), {
			headers: setCookies(`${ACCESS_COOKIE}=access-two; Path=/`),
		});
		const fresh = await client(http.fn).refresh(session());
		expect(http.calls[0]?.url).toBe(`${BASE}/me/current_session/refresh`);
		expect(headersOf(http.calls[0]).cookie).toBe(
			`${ACCESS_COOKIE}=access-one; ${REFRESH_COOKIE}=refresh-one`,
		);
		expect(headersOf(http.calls[0]).authorization).toBeUndefined();
		expect(fresh.cookies).toEqual({
			[ACCESS_COOKIE]: "access-two",
			[REFRESH_COOKIE]: "refresh-one",
		});
	});

	it("sends the refresh token as a bearer when there is one, and keeps the old tokens when the body has none", async () => {
		const http = fakeFetch().json(sessionAnswer());
		const old = session({ accessToken: "a-old", refreshToken: "r-old" });
		const fresh = await client(http.fn).refresh(old);
		expect(headersOf(http.calls[0]).authorization).toBe("Bearer r-old");
		expect(fresh).toMatchObject({ accessToken: "a-old", refreshToken: "r-old" });
	});

	it("says a 401 means the session is over", async () => {
		const http = fakeFetch().raw("nope", { status: 401 });
		await expect(client(http.fn).refresh(session())).rejects.toMatchObject({
			status: 401,
			refused: true,
		});
	});
});

describe("OpenrClient.openDoor", () => {
	it("posts to the door with the access cookie only", async () => {
		const http = fakeFetch().json({ data: {} });
		await client(http.fn).openDoor(session(), "49", "125");
		expect(http.calls[0]?.url).toBe(`${BASE}/buildings/49/doors/125/open`);
		expect(http.calls[0]?.init.method).toBe("POST");
		expect(http.calls[0]?.init.body).toBeUndefined();
		expect(headersOf(http.calls[0]).cookie).toBe(`${ACCESS_COOKIE}=access-one`);
	});

	it("sends the access token as a bearer when there is one, and no cookie header without cookies", async () => {
		const http = fakeFetch().raw(null, { status: 204 });
		await client(http.fn).openDoor(session({ cookies: {}, accessToken: "a-token" }), "49", "1");
		expect(headersOf(http.calls[0]).authorization).toBe("Bearer a-token");
		expect(headersOf(http.calls[0]).cookie).toBeUndefined();
	});

	it("escapes the IDs in the path", async () => {
		const http = fakeFetch().json({});
		await client(http.fn).openDoor(session(), "4/9", "1?x");
		expect(http.calls[0]?.url).toBe(`${BASE}/buildings/4%2F9/doors/1%3Fx/open`);
	});

	it("fails on an HTTP error", async () => {
		const http = fakeFetch().raw("down", { status: 503 });
		await expect(client(http.fn).openDoor(session(), "49", "1")).rejects.toMatchObject({
			kind: "http",
			status: 503,
			refused: false,
		});
	});

	it("gives up at its time limit", async () => {
		const http = fakeFetch().hang();
		await expect(
			client(http.fn, { timeoutMs: 20 }).openDoor(session(), "49", "1"),
		).rejects.toMatchObject({
			kind: "timeout",
		});
	});

	it("gives up when the caller's deadline passes", async () => {
		const http = fakeFetch().hang();
		const deadline = new AbortController();
		const opening = client(http.fn).openDoor(session(), "49", "1", deadline.signal);
		deadline.abort();
		await expect(opening).rejects.toMatchObject({ kind: "timeout" });
	});

	it("says when OpenR couldn't be reached", async () => {
		const http = fakeFetch().fail(new TypeError("fetch failed"));
		await expect(client(http.fn).openDoor(session(), "49", "1")).rejects.toMatchObject({
			kind: "network",
		});
	});
});

describe("OpenrClient.logout", () => {
	it("deletes the current session", async () => {
		const http = fakeFetch().raw(null, { status: 204 });
		await client(http.fn).logout(session({ accessToken: "a-token" }));
		expect(http.calls[0]?.url).toBe(`${BASE}/me/current_session`);
		expect(http.calls[0]?.init.method).toBe("DELETE");
		expect(headersOf(http.calls[0]).authorization).toBe("Bearer a-token");
	});
});

describe("reading answers", () => {
	it("refuses an answer that isn't JSON", async () => {
		const http = fakeFetch().raw("<html>", { status: 200 });
		await expect(client(http.fn).login(EMAIL, PASSWORD)).rejects.toThrow(/wasn't JSON/);
	});

	it("refuses an empty answer", async () => {
		const http = fakeFetch().raw(null, { status: 200 });
		await expect(client(http.fn).login(EMAIL, PASSWORD)).rejects.toThrow(/wasn't JSON/);
	});

	it("refuses an answer that says it's too large, without reading it", async () => {
		const http = fakeFetch().raw("{}", { headers: { "content-length": "999999" } });
		await expect(client(http.fn, { maxResponseBytes: 10 }).login(EMAIL, PASSWORD)).rejects.toThrow(
			/too large/,
		);
	});

	it("stops reading an answer that turns out too large", async () => {
		const big = JSON.stringify({ data: { protosession_token: "x".repeat(100) } });
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(big.slice(0, 50)));
				controller.enqueue(new TextEncoder().encode(big.slice(50)));
				controller.close();
			},
		});
		const http = fakeFetch().raw(stream);
		await expect(client(http.fn, { maxResponseBytes: 60 }).login(EMAIL, PASSWORD)).rejects.toThrow(
			/too large/,
		);
	});

	it("drains an error's body without failing on it", async () => {
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.error(new Error("broken"));
			},
		});
		const http = fakeFetch().raw(stream, { status: 500 });
		await expect(client(http.fn).openDoor(session(), "49", "1")).rejects.toMatchObject({
			status: 500,
		});
	});
});

describe("sessionCookies", () => {
	it("keeps only OpenR's cookies, without their attributes, and skips ones being deleted", () => {
		const headers = setCookies(
			`${ACCESS_COOKIE}=a=b; Path=/; Secure`,
			"other=x; Path=/",
			`${REFRESH_COOKIE}=; Path=/`,
			"_openr_old=gone; Max-Age=0",
			"_openr_older=gone; max-age=-1",
			"=nameless",
			"broken",
		);
		expect(sessionCookies(headers)).toEqual({ [ACCESS_COOKIE]: "a=b" });
	});
});

describe("cookieHeader", () => {
	it("leaves the refresh cookie out unless asked", () => {
		const cookies = { [ACCESS_COOKIE]: "a", [REFRESH_COOKIE]: "r" };
		expect(cookieHeader(cookies, false)).toBe(`${ACCESS_COOKIE}=a`);
		expect(cookieHeader(cookies, true)).toBe(`${ACCESS_COOKIE}=a; ${REFRESH_COOKIE}=r`);
	});
});

describe("OpenrError", () => {
	it("only counts 400, 401, 403 and 422 as refused", () => {
		expect(new OpenrError("http", "x", { status: 403 }).refused).toBe(true);
		expect(new OpenrError("http", "x", { status: 404 }).refused).toBe(false);
		expect(new OpenrError("http", "x").refused).toBe(false);
		expect(new OpenrError("network", "x", { status: 401 }).refused).toBe(false);
	});
});

describe("defaults", () => {
	it("uses the global fetch unless given one", async () => {
		const spy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response(null, { status: 204 }));
		await new OpenrClient({ baseUrl: BASE }).logout(session());
		expect(spy).toHaveBeenCalledWith(`${BASE}/me/current_session`, expect.anything());
		spy.mockRestore();
	});
});

describe("cancelling large answers", () => {
	function failingCancel(chunks: number) {
		let pulled = 0;
		return new ReadableStream<Uint8Array>({
			pull(controller) {
				if (pulled++ >= chunks) return controller.close();
				controller.enqueue(new Uint8Array(40).fill(120));
			},
			cancel() {
				throw new Error("cancel failed");
			},
		});
	}

	it("doesn't mind when cancelling a body that says it's too large fails", async () => {
		const http = fakeFetch().raw(failingCancel(1), { headers: { "content-length": "999999" } });
		await expect(client(http.fn, { maxResponseBytes: 10 }).login(EMAIL, PASSWORD)).rejects.toThrow(
			/too large/,
		);
	});

	it("doesn't mind when cancelling a body that turns out too large fails", async () => {
		const http = fakeFetch().raw(failingCancel(5));
		await expect(client(http.fn, { maxResponseBytes: 60 }).login(EMAIL, PASSWORD)).rejects.toThrow(
			/too large/,
		);
	});
});

describe("listing buildings and doors", () => {
	it("lists the buildings with the session, keeping only IDs and names", async () => {
		const http = fakeFetch().json({
			data: {
				buildings: [
					{ id: 49, name: "Main building", address: "somewhere", units: [1] },
					{ id: "50", name: null },
				],
			},
		});
		expect(await client(http.fn).listBuildings(session())).toEqual([
			{ id: "49", name: "Main building" },
			{ id: "50", name: "" },
		]);
		expect(http.calls[0]?.url).toBe(`${BASE}/buildings?limit=250`);
		expect(http.calls[0]?.init.method).toBe("GET");
		expect(http.calls[0]?.init.body).toBeUndefined();
		expect(headersOf(http.calls[0]).cookie).toBe(`${ACCESS_COOKIE}=access-one`);
	});

	it("lists a building's doors, and the account's own doors with their buildings", async () => {
		const http = fakeFetch()
			.json({ data: { doors: [{ id: 103, name: "Entrance", secret: "never-kept" }] } })
			.json({
				data: {
					doors: [
						{ id: 103, name: "Entrance", building_id: 49 },
						{ id: 7, name: "Elsewhere", building: { id: "60" } },
						{ id: 8 },
					],
				},
			});
		const api = client(http.fn);
		expect(await api.listDoors(session(), "49")).toEqual([
			{ id: "103", name: "Entrance", buildingId: "49" },
		]);
		expect(await api.myDoors(session())).toEqual([
			{ id: "103", name: "Entrance", buildingId: "49" },
			{ id: "7", name: "Elsewhere", buildingId: "60" },
			{ id: "8", name: "", buildingId: undefined },
		]);
		expect(http.calls.map((c) => c.url)).toEqual([
			`${BASE}/buildings/49/doors?limit=250`,
			`${BASE}/me/doors?limit=250`,
		]);
	});

	it("refuses a list that isn't one", async () => {
		const http = fakeFetch()
			.json({ data: {} })
			.json({ data: { doors: [{ id: "x" }] } });
		const api = client(http.fn);
		await expect(api.listBuildings(session())).rejects.toThrow(/no buildings/);
		await expect(api.myDoors(session())).rejects.toThrow(/no doors/);
	});

	it("says when the account may not list something", async () => {
		const http = fakeFetch().raw("no", { status: 403 });
		await expect(client(http.fn).listBuildings(session())).rejects.toMatchObject({ status: 403 });
	});

	it("takes a larger list than other answers", async () => {
		const doors = Array.from({ length: 250 }, (_, i) => ({ id: i, name: "x".repeat(300) }));
		const http = fakeFetch().json({ data: { doors } });
		expect(await client(http.fn).listDoors(session(), "49")).toHaveLength(250);
	});
});
