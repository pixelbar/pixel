/**
 * Sets whether Pixelbar is open or closed, by calling the space's state API:
 *
 *   POST <url>?user=<user>&token=<token>&state=<open|closed>
 *
 * The API answers `SUCCESS` when it took the change. Anything else means it didn't.
 *
 * The user and token travel in the query string, so the whole URL is a secret:
 * it is never logged, never put in an error, and redirects are refused so it can't
 * be sent to another host. The response is untrusted input: size-capped,
 * time-limited, and never echoed back.
 *
 * What was sent and what came back is handed to an optional `observe` callback, so
 * operators can see the exchange in Sentry. It is sanitised first: the user and token
 * are shown as `[redacted]`, request headers are left out, only a couple of harmless
 * response headers are kept, and the body is capped and stripped of control characters.
 *
 * This only asks the API to change the state. Whether Pixel notices and announces it
 * is up to the SpaceAPI poller (`space-status.ts`), which reads the state back.
 */

/** What can be sent to the API. Note `closed`, not `close`. */
export type SettableSpaceState = "open" | "closed";

export type SpaceStateApi = {
	/** Resolves when the API said `SUCCESS`; throws a `SpaceStateApiError` otherwise. */
	set(state: SettableSpaceState): Promise<void>;
};

/** The message never contains the URL, the token or the response body. */
export class SpaceStateApiError extends Error {
	override name = "SpaceStateApiError";
}

/** How a call ended. */
export type SpaceStateOutcome =
	| "success"
	| "rejected" // HTTP 2xx, but not `SUCCESS`
	| "http-error"
	| "too-large"
	| "unreadable"
	| "network-error";

/**
 * What was sent and what came back, safe to show to operators. The URL has no
 * secret in it, there are no request headers, and the body is capped.
 */
export type SpaceStateExchange = {
	request: {
		method: "POST";
		/** The address with `user` and `token` shown as `[redacted]`. */
		url: string;
		state: SettableSpaceState;
	};
	/** Absent when no response arrived (a network error, a timeout, a refused redirect). */
	response?: {
		status: number;
		contentType?: string;
		contentLength?: string;
		/** Absent when it was too large to read or could not be read. */
		body?: string;
		/** True when `body` is cut short for display. */
		truncated?: boolean;
	};
	outcome: SpaceStateOutcome;
	/** The error's name (never its message, which can carry the URL) when `outcome` is `network-error`. */
	errorName?: string;
	durationMs: number;
};

/** How much of the response body is passed to `observe`. */
export const OBSERVED_BODY_CHARS = 1024;

export type HttpSpaceStateApiOptions = {
	/** The API address, without the query. */
	url: string;
	user: string;
	/** A secret. */
	token: string;
	/** Extra request headers. Their values are secrets, like the token. */
	headers?: Record<string, string>;
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
	maxResponseBytes?: number;
	/**
	 * Called once per call with the sanitised request and response. It must not throw,
	 * but if it does the call is not affected.
	 */
	observe?: (exchange: SpaceStateExchange) => void;
};

export const SUCCESS_BODY = "SUCCESS";

export class HttpSpaceStateApi implements SpaceStateApi {
	readonly #url: string;
	readonly #user: string;
	readonly #token: string;
	readonly #headers: Record<string, string>;
	readonly #fetch: typeof globalThis.fetch;
	readonly #timeoutMs: number;
	readonly #maxResponseBytes: number;
	readonly #observe: ((exchange: SpaceStateExchange) => void) | undefined;

	constructor(options: HttpSpaceStateApiOptions) {
		this.#url = options.url;
		this.#user = options.user;
		this.#token = options.token;
		this.#headers = options.headers ?? {};
		this.#fetch = options.fetch ?? globalThis.fetch;
		this.#timeoutMs = options.timeoutMs ?? 10_000;
		this.#maxResponseBytes = options.maxResponseBytes ?? 4 * 1024;
		this.#observe = options.observe;
	}

	async set(state: SettableSpaceState): Promise<void> {
		// Built with URLSearchParams so odd characters in the user or token are encoded.
		const url = new URL(this.#url);
		url.searchParams.set("user", this.#user);
		url.searchParams.set("token", this.#token);
		url.searchParams.set("state", state);

		// Set last, so a configured header can't change what we ask for.
		const headers = new Headers(this.#headers);
		headers.set("accept", "text/plain");

		const startedAt = performance.now();
		const request: SpaceStateExchange["request"] = {
			method: "POST",
			url: `${url.origin}${url.pathname}?user=[redacted]&token=[redacted]&state=${state}`,
			state,
		};
		const done = (
			outcome: SpaceStateOutcome,
			extra: Pick<SpaceStateExchange, "response" | "errorName"> = {},
		) => this.#report({ request, outcome, ...extra, durationMs: performance.now() - startedAt });

		let response: Response;
		try {
			response = await this.#fetch(url, {
				method: "POST",
				// The token is in the URL: never follow a redirect to another host.
				redirect: "error",
				signal: AbortSignal.timeout(this.#timeoutMs),
				headers,
			});
		} catch (error) {
			// No `cause`: a network error can carry the URL, and the URL holds the token.
			const reason = error instanceof Error ? error.name : "unknown error";
			done("network-error", { errorName: reason });
			throw new SpaceStateApiError(`Space state API request failed (${reason})`);
		}

		const contentType = response.headers.get("content-type") ?? undefined;
		const contentLength = response.headers.get("content-length") ?? undefined;
		const seen = (body?: string): NonNullable<SpaceStateExchange["response"]> => ({
			status: response.status,
			...(contentType === undefined ? {} : { contentType }),
			...(contentLength === null || contentLength === undefined ? {} : { contentLength }),
			...(body === undefined ? {} : observedBody(body)),
		});

		const declared = Number(contentLength);
		let body: string | undefined;
		let unreadable = false;
		if (!(declared > this.#maxResponseBytes)) {
			try {
				body = await response.text();
			} catch {
				unreadable = true;
			}
		}
		const tooLarge =
			declared > this.#maxResponseBytes || (body?.length ?? 0) > this.#maxResponseBytes;
		// A body past the cap is never passed on, even cut short.
		const shown = tooLarge ? undefined : body;

		if (!response.ok) {
			done("http-error", { response: seen(shown) });
			throw new SpaceStateApiError(`Space state API responded with HTTP ${response.status}`);
		}
		if (tooLarge) {
			done("too-large", { response: seen() });
			throw new SpaceStateApiError("Space state API response too large");
		}
		if (unreadable || body === undefined) {
			done("unreadable", { response: seen() });
			throw new SpaceStateApiError("Space state API response could not be read");
		}
		if (body.trim() !== SUCCESS_BODY) {
			done("rejected", { response: seen(body) });
			// What it said instead is untrusted and may be anything, so it stays out of the error.
			throw new SpaceStateApiError("Space state API did not accept the change");
		}
		done("success", { response: seen(body) });
	}

	#report(exchange: SpaceStateExchange): void {
		try {
			this.#observe?.(exchange);
		} catch {
			// Watching the call must never change how it ends.
		}
	}
}

/** The body as shown to operators: no control characters, cut to `OBSERVED_BODY_CHARS`. */
function observedBody(body: string): { body: string; truncated?: true } {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point.
	const clean = body.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "\uFFFD");
	return clean.length > OBSERVED_BODY_CHARS
		? { body: clean.slice(0, OBSERVED_BODY_CHARS), truncated: true }
		: { body: clean };
}
