import { describe, expect, it, vi } from "vitest";
import {
	AnnouncementRoutes,
	AnnouncementRoutesUnavailableError,
	ROUTES_UNAVAILABLE,
	type RouteManager,
} from "./announcement-routes.ts";

const manager = (): RouteManager => ({
	list: vi.fn(() => [{ style: "single" as const, channelId: "1" }]),
	set: vi.fn(async () => ({ result: "added" as const, saved: true })),
	remove: vi.fn(async () => ({ removed: true, saved: true })),
});

describe("AnnouncementRoutes", () => {
	it("says so while no adapter has plugged in a manager", async () => {
		const routes = new AnnouncementRoutes();
		expect(routes.ready).toBe(false);
		expect(() => routes.list()).toThrow(ROUTES_UNAVAILABLE);
		expect(() => routes.list()).toThrow(AnnouncementRoutesUnavailableError);
		expect(() => routes.set("live", "1")).toThrow(ROUTES_UNAVAILABLE);
		expect(() => routes.remove("1")).toThrow(ROUTES_UNAVAILABLE);
	});

	it("passes everything on once a manager is plugged in", async () => {
		const routes = new AnnouncementRoutes();
		const plugged = manager();
		routes.use(plugged);
		expect(routes.ready).toBe(true);
		expect(routes.list()).toHaveLength(1);
		await expect(routes.set("live", "1")).resolves.toEqual({ result: "added", saved: true });
		await expect(routes.remove("1")).resolves.toEqual({ removed: true, saved: true });
		expect(plugged.set).toHaveBeenCalledWith("live", "1");
		expect(plugged.remove).toHaveBeenCalledWith("1");
	});
});
