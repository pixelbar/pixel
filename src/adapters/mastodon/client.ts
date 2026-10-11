import type { Toot } from "./toots.ts";

/**
 * Posts statuses to a Mastodon instance. This is the only module that talks
 * HTTP to Mastodon. The token is a secret: it is sent as a bearer header and
 * never included in errors or messages.
 *
 * Outbound only: it never reads mentions, replies or DMs.
 */

export class MastodonError extends Error {
	override name = "MastodonError";
}

export type MastodonClientOptions = {
	/** Instance origin, e.g. `https://mastodon.example`. Never a hard-coded default. */
	instanceUrl: string;
	/** Access token with `write:statuses`. A secret. */
	token: string;
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
	maxResponseBytes?: number;
};

export type MastodonStatusClient = {
	postStatus(toot: Toot): Promise<void>;
};

export class MastodonClient implements MastodonStatusClient {
	readonly #statusesUrl: string;
	readonly #token: string;
	readonly #fetch: typeof globalThis.fetch;
	readonly #timeoutMs: number;
	readonly #maxResponseBytes: number;

	constructor(options: MastodonClientOptions) {
		this.#statusesUrl = `${options.instanceUrl.replace(/\/$/, "")}/api/v1/statuses`;
		this.#token = options.token;
		this.#fetch = options.fetch ?? globalThis.fetch;
		this.#timeoutMs = options.timeoutMs ?? 10_000;
		this.#maxResponseBytes = options.maxResponseBytes ?? 64 * 1024;
	}

	async postStatus(toot: Toot): Promise<void> {
		let response: Response;
		try {
			response = await this.#fetch(this.#statusesUrl, {
				method: "POST",
				// Do not follow redirects: the bearer token must not be sent to another host.
				redirect: "error",
				signal: AbortSignal.timeout(this.#timeoutMs),
				headers: {
					authorization: `Bearer ${this.#token}`,
					accept: "application/json",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					status: toot.status,
					visibility: toot.visibility,
					language: "en",
				}),
			});
		} catch (error) {
			throw new MastodonError("Mastodon request failed", { cause: error });
		}

		if (!response.ok) {
			await discardBody(response, this.#maxResponseBytes);
			throw new MastodonError(`Mastodon responded with HTTP ${response.status}`);
		}
		await discardBody(response, this.#maxResponseBytes);
	}
}

/** Read the body only to bound memory; never put it in an error (it is untrusted). */
async function discardBody(response: Response, maxBytes: number): Promise<void> {
	const declared = Number(response.headers.get("content-length"));
	if (declared > maxBytes) return;
	const body = await response.text();
	if (body.length > maxBytes) return;
}
