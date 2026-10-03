import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startHealthServer } from "./health.ts";

describe("startHealthServer", () => {
	let close: (() => void) | undefined;
	afterEach(() => close?.());

	async function start(isReady: () => boolean) {
		const server = startHealthServer(0, isReady);
		close = () => server.close();
		await once(server, "listening");
		const { port } = server.address() as AddressInfo;
		return (path: string) => fetch(`http://127.0.0.1:${port}${path}`).then((r) => r.status);
	}

	it("reports liveness regardless of readiness", async () => {
		const get = await start(() => false);
		expect(await get("/healthz")).toBe(200);
	});

	it("reports readiness from the callback", async () => {
		let ready = false;
		const get = await start(() => ready);
		expect(await get("/readyz")).toBe(503);
		ready = true;
		expect(await get("/readyz")).toBe(200);
	});

	it("returns 404 for anything else", async () => {
		const get = await start(() => true);
		expect(await get("/")).toBe(404);
		expect(await get("/admin")).toBe(404);
	});
});
