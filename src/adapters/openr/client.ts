import { z } from "zod";

/**
 * Talks HTTP to OpenR's dashboard API, the same calls its own web dashboard makes. This
 * is the only module that does. Everything it sends or gets back that proves who Pixel
 * is (the password, the emailed code, the login token, the session cookies and tokens)
 * is a secret: none of it is ever put in an error or a message, and neither is a
 * response body (it is untrusted).
 *
 * How OpenR's login works (from its dashboard, `dashboard.openr.nl`):
 *  1. `POST /me/current_session` with the email and password gives a short-lived
 *     `protosession_token`, and OpenR emails a code to the account.
 *  2. `POST /me/current_session/mfa` with that token and the code starts the session. In
 *     cookie-only mode (what the dashboard uses) the session is two cookies,
 *     `_openr_access_sig` and `_openr_refresh_sig`, and the body says when each expires
 *     (`access_exp`, `refresh_exp`, in Unix seconds).
 *  3. `POST /me/current_session/refresh` with the refresh cookie gives fresh ones. A 401
 *     there means the session is over.
 * A door opens with `POST /buildings/<building>/doors/<door>/open`. For setting Pixel up,
 * `GET /buildings`, `GET /buildings/<building>/doors` and `GET /me/doors` list what the
 * account can see (`just openr-doors`); Pixel itself never uses them.
 *
 * Every call has a time limit, follows no redirects (the cookies must not go to another
 * host) and is made once: nothing here retries.
 */

export const ACCESS_COOKIE = "_openr_access_sig";
export const REFRESH_COOKIE = "_openr_refresh_sig";

/**
 * Sent as the dashboard sends it. The API wants to see the header (it guards against
 * cross-site requests from browsers); the value isn't a secret.
 */
const CSRF_TOKEN = "anything";
/** The dashboard version Pixel speaks like. If OpenR starts refusing Pixel, check this first. */
export const APP_VERSION = "openr-dashboard 1.72.13";

export type OpenrErrorKind =
	/** OpenR answered with an HTTP error. `status` says which. */
	| "http"
	/** The request never got an answer: the network, DNS or TLS. */
	| "network"
	| "timeout"
	/** OpenR answered, but not with what Pixel expected. */
	| "response";

export class OpenrError extends Error {
	override name = "OpenrError";
	readonly kind: OpenrErrorKind;
	readonly status: number | undefined;

	constructor(
		kind: OpenrErrorKind,
		message: string,
		options?: { status?: number; cause?: unknown },
	) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.kind = kind;
		this.status = options?.status;
	}

	/** OpenR refused who Pixel says it is (as opposed to an outage). */
	get refused(): boolean {
		return (
			this.kind === "http" &&
			this.status !== undefined &&
			[400, 401, 403, 422].includes(this.status)
		);
	}
}

/** A session with OpenR. Every field but the dates is a secret. */
export type OpenrSession = {
	/** The session's cookies, by name (`_openr_access_sig`, `_openr_refresh_sig`). */
	cookies: Readonly<Record<string, string>>;
	/** Bearer tokens, when OpenR puts them in the body rather than only in cookies. */
	accessToken: string | undefined;
	refreshToken: string | undefined;
	accessUntil: Date;
	refreshUntil: Date;
};

export type LoginAnswer =
	/** OpenR emailed a code. The token goes back with it. */
	| { kind: "code"; token: string }
	/** The account needs no code: the session started straight away. */
	| { kind: "session"; session: OpenrSession };

/** What the rest of the adapter needs from the client, so tests can stand in for it. */
export type OpenrApi = {
	login(email: string, password: string): Promise<LoginAnswer>;
	completeLogin(token: string, code: string): Promise<OpenrSession>;
	refresh(session: OpenrSession): Promise<OpenrSession>;
	openDoor(
		session: OpenrSession,
		buildingId: string,
		doorId: string,
		signal?: AbortSignal,
	): Promise<void>;
	logout(session: OpenrSession): Promise<void>;
};

/** A building, as listed: only its ID and name are kept. */
export type OpenrBuilding = { id: string; name: string };

/** A door, as listed: only its ID, name and building are kept. */
export type OpenrDoorInfo = { id: string; name: string; buildingId: string | undefined };

export type OpenrClientOptions = {
	/** Where the API lives, e.g. `https://dashboard.openr.nl/api/v4`. */
	baseUrl: string;
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
	maxResponseBytes?: number;
};

const sessionBody = z.object({
	data: z.object({
		access: z.string().min(1).nullish(),
		refresh: z.string().min(1).nullish(),
		access_exp: z.number().int().positive(),
		refresh_exp: z.number().int().positive(),
	}),
});

const openrId = z.union([z.number().int().nonnegative(), z.string().regex(/^\d{1,10}$/)]);

/** Only the fields Pixel prints; everything else in a listed item is dropped unread. */
const listedBuilding = z.object({ id: openrId, name: z.string().nullish() });
const listedDoor = z.object({
	id: openrId,
	name: z.string().nullish(),
	building_id: openrId.nullish(),
	building: z.object({ id: openrId }).nullish(),
});
const buildingsBody = z.object({ data: z.object({ buildings: z.array(listedBuilding) }) });
const doorsBody = z.object({ data: z.object({ doors: z.array(listedDoor) }) });

/** How many items a list asks for, as the dashboard does. */
export const LIST_LIMIT = 250;
/** Lists can be larger than other answers. */
const LIST_MAX_BYTES = 2 * 1024 * 1024;

const loginBody = z.object({
	data: z.object({ protosession_token: z.string().min(1) }),
});

export class OpenrClient implements OpenrApi {
	readonly #baseUrl: string;
	readonly #origin: string;
	readonly #fetch: typeof globalThis.fetch;
	readonly #timeoutMs: number;
	readonly #maxResponseBytes: number;

	constructor(options: OpenrClientOptions) {
		this.#baseUrl = options.baseUrl.replace(/\/$/, "");
		this.#origin = new URL(this.#baseUrl).origin;
		this.#fetch = options.fetch ?? globalThis.fetch;
		this.#timeoutMs = options.timeoutMs ?? 10_000;
		this.#maxResponseBytes = options.maxResponseBytes ?? 64 * 1024;
	}

	async login(email: string, password: string): Promise<LoginAnswer> {
		const response = await this.#send("POST", "/me/current_session", {
			body: {
				email,
				password,
				persistent_session: true,
				token_signature_transport: "cookie_only",
			},
		});
		const body = await this.#json(response);
		const code = loginBody.safeParse(body);
		if (code.success) return { kind: "code", token: code.data.data.protosession_token };
		// An account without a second step gets its session at once.
		return { kind: "session", session: this.#session(response, body, undefined) };
	}

	async completeLogin(token: string, code: string): Promise<OpenrSession> {
		const response = await this.#send("POST", "/me/current_session/mfa", {
			body: { token, mfa_code: code },
		});
		return this.#session(response, await this.#json(response), undefined);
	}

	async refresh(session: OpenrSession): Promise<OpenrSession> {
		const response = await this.#send("POST", "/me/current_session/refresh", {
			session,
			bearer: session.refreshToken,
			withRefreshCookie: true,
		});
		return this.#session(response, await this.#json(response), session);
	}

	async openDoor(
		session: OpenrSession,
		buildingId: string,
		doorId: string,
		signal?: AbortSignal,
	): Promise<void> {
		const path = `/buildings/${encodeURIComponent(buildingId)}/doors/${encodeURIComponent(doorId)}/open`;
		const response = await this.#send("POST", path, {
			session,
			bearer: session.accessToken,
			signal,
		});
		await discardBody(response, this.#maxResponseBytes);
	}

	async logout(session: OpenrSession): Promise<void> {
		const response = await this.#send("DELETE", "/me/current_session", {
			session,
			bearer: session.accessToken,
		});
		await discardBody(response, this.#maxResponseBytes);
	}

	/** The buildings the account can see. A 403 means it isn't allowed to list them. */
	async listBuildings(session: OpenrSession): Promise<OpenrBuilding[]> {
		const body = await this.#list(session, `/buildings?limit=${LIST_LIMIT}`);
		const parsed = buildingsBody.safeParse(body);
		if (!parsed.success) throw new OpenrError("response", "OpenR's answer had no buildings in it");
		return parsed.data.data.buildings.map((b) => ({ id: String(b.id), name: b.name ?? "" }));
	}

	/** A building's doors. */
	async listDoors(session: OpenrSession, buildingId: string): Promise<OpenrDoorInfo[]> {
		const path = `/buildings/${encodeURIComponent(buildingId)}/doors?limit=${LIST_LIMIT}`;
		return this.#doors(await this.#list(session, path), buildingId);
	}

	/** The doors the account itself may open, in any building. */
	async myDoors(session: OpenrSession): Promise<OpenrDoorInfo[]> {
		return this.#doors(await this.#list(session, `/me/doors?limit=${LIST_LIMIT}`), undefined);
	}

	async #list(session: OpenrSession, path: string): Promise<unknown> {
		const response = await this.#send("GET", path, { session, bearer: session.accessToken });
		return this.#json(response, LIST_MAX_BYTES);
	}

	#doors(body: unknown, buildingId: string | undefined): OpenrDoorInfo[] {
		const parsed = doorsBody.safeParse(body);
		if (!parsed.success) throw new OpenrError("response", "OpenR's answer had no doors in it");
		return parsed.data.data.doors.map((d) => {
			const building = d.building_id ?? d.building?.id;
			return {
				id: String(d.id),
				name: d.name ?? "",
				buildingId: building === undefined || building === null ? buildingId : String(building),
			};
		});
	}

	/** Makes one request and returns the response if it's a success. Never retries. */
	async #send(
		method: "GET" | "POST" | "DELETE",
		path: string,
		options: {
			body?: Record<string, unknown>;
			session?: OpenrSession;
			bearer?: string | undefined;
			withRefreshCookie?: boolean;
			signal?: AbortSignal | undefined;
		},
	): Promise<Response> {
		const headers: Record<string, string> = {
			accept: "application/json",
			"content-type": "application/json",
			origin: this.#origin,
			"x-csrf-token": CSRF_TOKEN,
			"yy-app-version": APP_VERSION,
		};
		if (options.session) {
			const cookie = cookieHeader(options.session.cookies, options.withRefreshCookie ?? false);
			if (cookie) headers.cookie = cookie;
		}
		if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
		const timeout = AbortSignal.timeout(this.#timeoutMs);
		const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;

		let response: Response;
		try {
			response = await this.#fetch(`${this.#baseUrl}${path}`, {
				method,
				redirect: "error",
				signal,
				headers,
				...(options.body ? { body: JSON.stringify(options.body) } : {}),
			});
		} catch (error) {
			if (signal.aborted)
				throw new OpenrError("timeout", "OpenR didn't answer in time", { cause: error });
			throw new OpenrError("network", "Couldn't reach OpenR", { cause: error });
		}
		if (!response.ok) {
			await discardBody(response, this.#maxResponseBytes);
			throw new OpenrError("http", `OpenR answered HTTP ${response.status}`, {
				status: response.status,
			});
		}
		return response;
	}

	async #json(response: Response, maxBytes = this.#maxResponseBytes): Promise<unknown> {
		const text = await readText(response, maxBytes);
		if (text === undefined) throw new OpenrError("response", "OpenR's answer was too large");
		try {
			return JSON.parse(text);
		} catch {
			throw new OpenrError("response", "OpenR's answer wasn't JSON");
		}
	}

	/** The session a login or refresh answered with, on top of `previous` for a refresh. */
	#session(response: Response, body: unknown, previous: OpenrSession | undefined): OpenrSession {
		const parsed = sessionBody.safeParse(body);
		if (!parsed.success) throw new OpenrError("response", "OpenR's answer had no session in it");
		const { data } = parsed.data;
		const cookies = { ...previous?.cookies, ...sessionCookies(response.headers) };
		const accessToken = data.access ?? previous?.accessToken;
		const refreshToken = data.refresh ?? previous?.refreshToken;
		if (cookies[ACCESS_COOKIE] === undefined && accessToken === undefined) {
			throw new OpenrError("response", "OpenR's answer had no access cookie");
		}
		if (cookies[REFRESH_COOKIE] === undefined && refreshToken === undefined) {
			throw new OpenrError("response", "OpenR's answer had no refresh cookie");
		}
		return {
			cookies,
			accessToken,
			refreshToken,
			accessUntil: new Date(data.access_exp * 1000),
			refreshUntil: new Date(data.refresh_exp * 1000),
		};
	}
}

/**
 * The `name=value` of each OpenR cookie a response sets, without its attributes. A
 * cookie set to expire (a logout, say) is left out.
 */
export function sessionCookies(headers: Headers): Record<string, string> {
	const cookies: Record<string, string> = {};
	for (const line of headers.getSetCookie()) {
		const [pair = "", ...attributes] = line.split(";");
		const at = pair.indexOf("=");
		if (at <= 0) continue;
		const name = pair.slice(0, at).trim();
		const value = pair.slice(at + 1).trim();
		if (!name.startsWith("_openr_") || value === "") continue;
		const expired = attributes.some((a) => /^\s*max-age\s*=\s*(0|-\d+)\s*$/i.test(a));
		if (expired) continue;
		cookies[name] = value;
	}
	return cookies;
}

/** The cookie header for a request. The refresh cookie only goes to the refresh call. */
export function cookieHeader(
	cookies: Readonly<Record<string, string>>,
	withRefresh: boolean,
): string {
	return Object.entries(cookies)
		.filter(([name]) => withRefresh || name !== REFRESH_COOKIE)
		.map(([name, value]) => `${name}=${value}`)
		.join("; ");
}

/** The body as text, or undefined when it's larger than `maxBytes`. */
async function readText(response: Response, maxBytes: number): Promise<string | undefined> {
	const body = response.body;
	if (!body) return "";
	if (Number(response.headers.get("content-length")) > maxBytes) {
		await body.cancel().catch(() => undefined);
		return undefined;
	}
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let received = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			received += value.byteLength;
			if (received > maxBytes) {
				await reader.cancel().catch(() => undefined);
				return undefined;
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks).toString("utf8");
}

/** Drains the body so the connection can be reused, reading at most `maxBytes`. */
async function discardBody(response: Response, maxBytes: number): Promise<void> {
	await readText(response, maxBytes).catch(() => undefined);
}
