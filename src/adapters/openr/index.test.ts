import { describe, expect, it, vi } from "vitest";
import { silentLogger } from "../../core/logger.ts";
import { createOpenr, OpenrConnection } from "./index.ts";

describe("createOpenr", () => {
	it("is off without config, and says so", () => {
		const info = vi.fn();
		const openr = createOpenr({
			openr: undefined,
			sessionFile: "unused.json",
			logger: { ...silentLogger, info },
			reporter: { captureBackground: vi.fn() },
		});
		expect(openr).toBeUndefined();
		expect(info).toHaveBeenCalledWith({ event: "openr.unconfigured" }, "OpenR isn't configured");
	});

	it("connects to the configured API, logged out until an admin logs in", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () => new Response(JSON.stringify({ data: { protosession_token: "p" } })),
		);
		const openr = createOpenr({
			openr: {
				url: "https://openr.example/api/v4",
				buildingId: "49",
				email: "pixel@example.invalid",
				password: "not-a-real-password",
			},
			sessionFile: "/nonexistent/openr-session.json",
			logger: silentLogger,
			reporter: { captureBackground: vi.fn() },
			fetch,
		});
		expect(openr).toBeInstanceOf(OpenrConnection);
		expect(openr?.status()).toEqual({ state: "logged-out" });
		expect((await openr?.startLogin())?.step).toBe("code-sent");
		expect(String(fetch.mock.calls[0]?.[0])).toBe(
			"https://openr.example/api/v4/me/current_session",
		);
	});

	it("uses the global fetch unless given one", () => {
		const openr = createOpenr({
			openr: { url: "https://openr.example/api/v4", buildingId: "49", email: "e", password: "p" },
			sessionFile: "/nonexistent/openr-session.json",
			logger: silentLogger,
			reporter: { captureBackground: vi.fn() },
		});
		expect(openr?.status().state).toBe("logged-out");
	});
});
