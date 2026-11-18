import { z } from "zod";
import { CALL_ID } from "../../core/doorbell.ts";
import type { AcceptResult, DoorbellAccept } from "../../core/ports/doorbell-accept.ts";

/**
 * pixel-phone's accept API (`POST /api/v1/calls/{callId}/accept`), with Pixel's own key.
 * Accepting answers a phone call, so it's one attempt under one deadline: no retries, no
 * redirects (the key would follow them), and anything unexpected counts as failed. The key
 * never reaches a log, an error or a result; neither does a response body.
 */

const TIMEOUT_MS = 5000;
/** pixel-phone's answers are tiny; anything bigger isn't one. */
const MAX_BODY = 2048;

const conflict = z.object({
	via: z.string().min(1).max(64),
	by: z.string().min(1).max(100).optional(),
});

export function createAcceptClient(options: {
	/** pixel-phone's origin, like `https://phone.example`. */
	url: string;
	apiKey: string;
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
}): DoorbellAccept {
	const fetcher = options.fetch ?? globalThis.fetch;
	const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
	const origin = new URL(options.url).origin;

	return {
		async accept(callId, by): Promise<AcceptResult> {
			// The dispatcher's arguments are checked already; this keeps the path safe regardless.
			if (!CALL_ID.test(callId)) return { kind: "too-late" };
			const signal = AbortSignal.timeout(timeoutMs);
			let response: Response;
			try {
				response = await fetcher(`${origin}/api/v1/calls/${callId}/accept`, {
					method: "POST",
					headers: {
						authorization: `Bearer ${options.apiKey}`,
						"content-type": "application/json",
						accept: "application/json",
					},
					body: JSON.stringify({ by }),
					redirect: "error",
					signal,
				});
			} catch {
				return { kind: "failed", why: signal.aborted ? "timeout" : "network" };
			}
			switch (response.status) {
				case 202:
					return { kind: "accepted" };
				case 404:
				case 410:
					return { kind: "too-late" };
				case 409: {
					const body = await readJson(response);
					const parsed = conflict.safeParse(body);
					// Someone was first either way; who, only if pixel-phone said so clearly.
					if (!parsed.success) return { kind: "already", via: "unknown" };
					return {
						kind: "already",
						via: parsed.data.via,
						...(parsed.data.by ? { by: parsed.data.by } : {}),
					};
				}
				default:
					// 400, 401, 429, 503 and the rest: Pixel or pixel-phone is set up wrong, or busy.
					return { kind: "failed", why: "status", status: response.status };
			}
		},
	};
}

/** The body as JSON, if it's small and is JSON. Undefined otherwise. */
async function readJson(response: Response): Promise<unknown> {
	try {
		const text = await response.text();
		if (text.length > MAX_BODY) return undefined;
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}
