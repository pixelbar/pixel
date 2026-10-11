import { describe, expect, it } from "vitest";
import type { HomeStatus } from "../core/home.ts";
import { homeIsConnected, homeMonitorSlug, withOutageGrace } from "./home-outage.ts";

describe("homeMonitorSlug", () => {
	it("is one Home Assistant monitor per environment", () => {
		expect(homeMonitorSlug("prod")).toBe("pixel-prod-home-assistant");
		expect(homeMonitorSlug("dev")).toBe("pixel-dev-home-assistant");
	});
});

describe("homeIsConnected", () => {
	it.each<[HomeStatus["kind"], boolean]>([
		["connected", true],
		["connecting", false],
		["reconnecting", false],
		["off", false],
		["unconfigured", false],
	])("%s → %s", (kind, expected) => {
		const status: HomeStatus =
			kind === "connected"
				? { kind, haVersion: "2026.1", adminToken: false }
				: kind === "off"
					? { kind, reason: "refused" }
					: { kind };
		expect(homeIsConnected(status)).toBe(expected);
	});
});

describe("withOutageGrace", () => {
	it("stays ok through a short drop, then errors until it is back", () => {
		let now = 0;
		let up = true;
		const healthy = withOutageGrace(
			() => up,
			15 * 60_000,
			() => now,
		);

		expect(healthy()).toBe(true);
		up = false;
		now = 5 * 60_000;
		expect(healthy()).toBe(true);
		now = 14 * 60_000 + 999;
		expect(healthy()).toBe(true);
		now = 15 * 60_000;
		expect(healthy()).toBe(false);
		now = 40 * 60_000;
		expect(healthy()).toBe(false);
		up = true;
		now = 41 * 60_000;
		expect(healthy()).toBe(true);
	});

	it("resets the grace after a recovery, so two short drops do not add up", () => {
		let now = 0;
		let up = true;
		const healthy = withOutageGrace(
			() => up,
			15 * 60_000,
			() => now,
		);

		up = false;
		now = 10 * 60_000;
		expect(healthy()).toBe(true);
		up = true;
		now = 11 * 60_000;
		expect(healthy()).toBe(true);
		up = false;
		now = 12 * 60_000;
		expect(healthy()).toBe(true);
		now = 26 * 60_000;
		expect(healthy()).toBe(false);
	});
});
