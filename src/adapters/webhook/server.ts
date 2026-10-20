import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Logger } from "../../core/logger.ts";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verify } from "./signature.ts";

/**
 * The one public HTTP endpoint: the space state service calls it when the space opens or
 * closes, so Pixel notices straight away instead of at the next SpaceAPI poll.
 *
 * It listens on its own port, which is the only one Azure's ingress exposes, so the health
 * probes stay private. Every request must be signed (`signature.ts`). An accepted one only
 * asks Pixel to read SpaceAPI again: the body is never trusted, logged or echoed, so the
 * worst a replayed or forged request can do is cause one extra read. Polling carries on as
 * before, so a webhook that never arrives costs only the delay.
 */

export const SPACE_STATE_WEBHOOK_PATH = "/hooks/space-state";

/** The sender's body is small; anything bigger is refused before it's read. */
export const MAX_BODY_BYTES = 4 * 1024;

export type WebhookServerOptions = {
	port: number;
	/** Shared with the space state service. A secret. */
	secret: string;
	logger: Logger;
	/** Called once per accepted webhook, after the reply has gone. Must not throw. */
	onSpaceStateChanged: () => void;
	now?: () => Date;
};

export function startWebhookServer(options: WebhookServerOptions): Server {
	const logger = options.logger.child({ service: "webhook" });
	const now = options.now ?? (() => new Date());

	const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		const path = (req.url ?? "").split("?")[0];
		if (path !== SPACE_STATE_WEBHOOK_PATH) return reply(res, 404, "not found");
		if (req.method !== "POST") return reply(res, 405, "method not allowed", { allow: "POST" });
		if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) {
			return reply(res, 413, "too large");
		}

		const body = await readBody(req);
		if (body === undefined) {
			// Sent without a length and too big: drop the connection rather than read on.
			res.destroy();
			return;
		}

		const check = verify({
			secret: options.secret,
			timestamp: header(req, TIMESTAMP_HEADER),
			signature: header(req, SIGNATURE_HEADER),
			body,
			now: now(),
		});
		if (!check.ok) {
			logger.warn(
				{ event: "webhook.rejected", hook: "space-state", reason: check.reason },
				"refused a space state webhook",
			);
			return reply(res, 401, "unauthorized");
		}

		logger.info({ event: "webhook.received", hook: "space-state" }, "space state webhook");
		reply(res, 202, "accepted");
		try {
			options.onSpaceStateChanged();
		} catch (error) {
			logger.error({ event: "webhook.failed", err: error }, "space state webhook handler failed");
		}
	};

	const server = createServer((req, res) => {
		handle(req, res).catch((error: unknown) => {
			// The client went away mid-request, most likely. There's nobody left to tell.
			logger.debug({ event: "webhook.aborted", err: error }, "webhook request failed");
			if (!res.headersSent) reply(res, 400, "bad request");
		});
	});
	// A slow sender can't hold a connection open for long.
	server.headersTimeout = 5_000;
	server.requestTimeout = 10_000;
	server.listen(options.port);
	return server;
}

function reply(
	res: ServerResponse,
	status: number,
	text: string,
	headers: Record<string, string> = {},
): void {
	res.writeHead(status, { "content-type": "text/plain", ...headers }).end(text);
}

function header(req: IncomingMessage, name: string): string | undefined {
	const value = req.headers[name];
	return Array.isArray(value) ? undefined : value;
}

/** The body as text, or undefined once it passes {@link MAX_BODY_BYTES}. */
async function readBody(req: IncomingMessage): Promise<string | undefined> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = chunk as Buffer;
		size += buffer.length;
		if (size > MAX_BODY_BYTES) return undefined;
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}
