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

	constructor(options: HttpSpaceStateApiOptions) {
		this.#url = options.url;
		this.#user = options.user;
		this.#token = options.token;
		this.#headers = options.headers ?? {};
		this.#fetch = options.fetch ?? globalThis.fetch;
		this.#timeoutMs = options.timeoutMs ?? 10_000;
		this.#maxResponseBytes = options.maxResponseBytes ?? 4 * 1024;
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
			throw new SpaceStateApiError(`Space state API request failed (${reason})`);
		}

		if (!response.ok) {
			throw new SpaceStateApiError(`Space state API responded with HTTP ${response.status}`);
		}

		const declared = Number(response.headers.get("content-length"));
		if (declared > this.#maxResponseBytes) {
			throw new SpaceStateApiError("Space state API response too large");
		}
		let body: string;
		try {
			body = await response.text();
		} catch {
			throw new SpaceStateApiError("Space state API response could not be read");
		}
		if (body.length > this.#maxResponseBytes) {
			throw new SpaceStateApiError("Space state API response too large");
		}
		if (body.trim() !== SUCCESS_BODY) {
			// What it said instead is untrusted and may be anything, so it stays out of the error.
			throw new SpaceStateApiError("Space state API did not accept the change");
		}
	}
}
