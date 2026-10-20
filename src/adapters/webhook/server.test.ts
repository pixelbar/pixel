import { once } from "node:events";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../../core/logger.ts";
import { MAX_BODY_BYTES, SPACE_STATE_WEBHOOK_PATH, startWebhookServer } from "./server.ts";
import { SIGNATURE_HEADER, sign, TIMESTAMP_HEADER } from "./signature.ts";

const SECRET = "test-webhook-secret-not-a-real-one-0000";
const NOW = new Date("2026-10-20T12:00:00Z");
const SENT_AT = NOW.getTime() / 1000;
const BODY = '{"state":"open","changedAt":"2026-10-20T12:00:00.000Z"}';

function recordingLogger() {
	const lines: { level: string; obj: object }[] = [];
	const logger: Logger = {
		debug: (obj) => lines.push({ level: "debug", obj }),
		info: (obj) => lines.push({ level: "info", obj }),
		warn: (obj) => lines.push({ level: "warn", obj }),
		error: (obj) => lines.push({ level: "error", obj }),
		child: () => logger,
	};
	return { logger, lines };
}

const signed = (body = BODY, secret = SECRET) => ({
	[TIMESTAMP_HEADER]: String(SENT_AT),
	[SIGNATURE_HEADER]: sign(secret, SENT_AT, body),
});

describe("startWebhookServer", () => {
	let close: (() => void) | undefined;
	afterEach(() => close?.());

	async function start(
		onSpaceStateChanged: () => void = vi.fn(),
		clock: "fixed" | "real" = "fixed",
	) {
		const { logger, lines } = recordingLogger();
		const server = startWebhookServer({
			port: 0,
			secret: SECRET,
			logger,
			onSpaceStateChanged,
			...(clock === "fixed" ? { now: () => NOW } : {}),
		});
		close = () => server.close();
		await once(server, "listening");
		const { port } = server.address() as AddressInfo;
		const send = async (
			path: string,
			init: { method?: string; body?: string; headers?: Record<string, string> } = {},
		) => {
			const response = await fetch(`http://127.0.0.1:${port}${path}`, {
				method: init.method ?? "POST",
				...(init.body === undefined ? {} : { body: init.body }),
				headers: init.headers ?? {},
			});
			return { status: response.status, text: await response.text(), headers: response.headers };
		};
		return { send, lines, port };
	}

	it("accepts a signed request and asks for a fresh reading, after replying", async () => {
		const onChange = vi.fn();
		const { send, lines } = await start(onChange);
		const response = await send(SPACE_STATE_WEBHOOK_PATH, { body: BODY, headers: signed() });
		expect(response).toMatchObject({ status: 202, text: "accepted" });
		expect(onChange).toHaveBeenCalledOnce();
		expect(lines).toContainEqual({
			level: "info",
			obj: { event: "webhook.received", hook: "space-state" },
		});
	});

	it("ignores a query string on the path", async () => {
		const { send } = await start();
		const response = await send(`${SPACE_STATE_WEBHOOK_PATH}?source=test`, {
			body: BODY,
			headers: signed(),
		});
		expect(response.status).toBe(202);
	});

	it("refuses an unsigned or badly signed request, says nothing more, and logs why", async () => {
		const onChange = vi.fn();
		const { send, lines } = await start(onChange);
		const unsigned = await send(SPACE_STATE_WEBHOOK_PATH, { body: BODY });
		const forged = await send(SPACE_STATE_WEBHOOK_PATH, {
			body: BODY,
			headers: signed(BODY, "a-guessed-secret"),
		});
		expect(unsigned).toMatchObject({ status: 401, text: "unauthorized" });
		expect(forged).toMatchObject({ status: 401, text: "unauthorized" });
		expect(onChange).not.toHaveBeenCalled();
		expect(lines.filter((l) => l.level === "warn").map((l) => l.obj)).toEqual([
			{ event: "webhook.rejected", hook: "space-state", reason: "missing" },
			{ event: "webhook.rejected", hook: "space-state", reason: "bad-signature" },
		]);
	});

	it("never logs the body or the signature", async () => {
		const { send, lines } = await start();
		await send(SPACE_STATE_WEBHOOK_PATH, { body: BODY, headers: signed() });
		await send(SPACE_STATE_WEBHOOK_PATH, { body: BODY, headers: signed(BODY, "wrong") });
		const logged = JSON.stringify(lines);
		expect(logged).not.toContain("changedAt");
		expect(logged).not.toContain("sha256=");
		expect(logged).not.toContain(SECRET);
	});

	it("returns 404 for any other path, without logging", async () => {
		const { send, lines } = await start();
		expect((await send("/", { method: "GET" })).status).toBe(404);
		expect((await send("/healthz", { method: "GET" })).status).toBe(404);
		expect((await send("/hooks/other", { body: BODY, headers: signed() })).status).toBe(404);
		expect(lines).toEqual([]);
	});

	it("only takes POST", async () => {
		const { send } = await start();
		const response = await send(SPACE_STATE_WEBHOOK_PATH, { method: "GET" });
		expect(response.status).toBe(405);
		expect(response.headers.get("allow")).toBe("POST");
	});

	it("refuses a body that says it is too large, without reading it", async () => {
		const onChange = vi.fn();
		const { send } = await start(onChange);
		const body = "x".repeat(MAX_BODY_BYTES + 1);
		const response = await send(SPACE_STATE_WEBHOOK_PATH, { body, headers: signed(body) });
		expect(response.status).toBe(413);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("drops the connection when a body sent without a length grows too large", async () => {
		const onChange = vi.fn();
		const { port } = await start(onChange);
		const outcome = await new Promise<string>((resolve) => {
			const req = request({
				host: "127.0.0.1",
				port,
				path: SPACE_STATE_WEBHOOK_PATH,
				method: "POST",
				headers: { "transfer-encoding": "chunked", ...signed() },
			});
			req.on("response", (res) => resolve(`status ${res.statusCode}`));
			req.on("error", () => resolve("dropped"));
			req.write("x".repeat(MAX_BODY_BYTES));
			req.write("x".repeat(MAX_BODY_BYTES));
			req.end();
		});
		expect(outcome).toBe("dropped");
		expect(onChange).not.toHaveBeenCalled();
	});

	it("ignores repeated signature headers", async () => {
		const onChange = vi.fn();
		const { port } = await start(onChange);
		const status = await new Promise<number | undefined>((resolve, reject) => {
			const signature = sign(SECRET, SENT_AT, BODY);
			const req = request({
				host: "127.0.0.1",
				port,
				path: SPACE_STATE_WEBHOOK_PATH,
				method: "POST",
				// Node joins most repeated headers with ", ", which no longer matches.
				headers: {
					[TIMESTAMP_HEADER]: String(SENT_AT),
					[SIGNATURE_HEADER]: [signature, signature],
				},
			});
			req.on("response", (res) => {
				res.resume();
				resolve(res.statusCode);
			});
			req.on("error", reject);
			req.end(BODY);
		});
		expect(status).toBe(401);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("still answers when the handler throws, and logs it", async () => {
		const { send, lines } = await start(() => {
			throw new Error("boom");
		});
		const response = await send(SPACE_STATE_WEBHOOK_PATH, { body: BODY, headers: signed() });
		expect(response.status).toBe(202);
		expect(lines.some((l) => l.level === "error")).toBe(true);
	});

	it("uses the real clock by default", async () => {
		const onChange = vi.fn();
		const { send } = await start(onChange, "real");
		const sentAt = Math.floor(Date.now() / 1000);
		const response = await send(SPACE_STATE_WEBHOOK_PATH, {
			body: BODY,
			headers: {
				[TIMESTAMP_HEADER]: String(sentAt),
				[SIGNATURE_HEADER]: sign(SECRET, sentAt, BODY),
			},
		});
		expect(response.status).toBe(202);
		expect(onChange).toHaveBeenCalledOnce();
	});

	it("shrugs off a sender that hangs up mid-request, and keeps serving", async () => {
		const onChange = vi.fn();
		const { port, send, lines } = await start(onChange);
		const req = request({
			host: "127.0.0.1",
			port,
			path: SPACE_STATE_WEBHOOK_PATH,
			method: "POST",
			headers: { "transfer-encoding": "chunked", ...signed() },
		});
		req.on("error", () => {});
		req.write("{");
		await vi.waitFor(() => expect(req.socket).toBeTruthy());
		await new Promise((resolve) => setTimeout(resolve, 20));
		req.destroy();
		await vi.waitFor(() =>
			expect(lines).toContainEqual(
				expect.objectContaining({
					level: "debug",
					obj: expect.objectContaining({ event: "webhook.aborted" }),
				}),
			),
		);
		expect(onChange).not.toHaveBeenCalled();
		expect((await send(SPACE_STATE_WEBHOOK_PATH, { body: BODY, headers: signed() })).status).toBe(
			202,
		);
	});
});
