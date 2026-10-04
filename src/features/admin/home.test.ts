import { describe, expect, it } from "vitest";
import type { HomeStatus } from "../../core/home.ts";
import { describeHome, homeLines } from "./home.ts";

const connected = (
	extra: Partial<Extract<HomeStatus, { kind: "connected" }>> = {},
): HomeStatus => ({
	kind: "connected",
	haVersion: "2026.10.1",
	adminToken: false,
	...extra,
});

describe("describeHome", () => {
	it.each([
		[{ kind: "unconfigured" }, "Not configured"],
		[{ kind: "connecting" }, "Connecting…"],
		[{ kind: "reconnecting" }, "Not connected, trying to reconnect"],
		[{ kind: "off", reason: "the token was refused" }, "Off: the token was refused"],
	] as const)("describes %j", (status, text) => {
		expect(describeHome(status)).toBe(text);
	});

	it("says connected, with the version as a code span", () => {
		expect(describeHome(connected())).toBe("Connected (version `2026.10.1`)");
		expect(describeHome(connected({ haVersion: undefined }))).toBe("Connected");
	});

	it("shows an untrusted version inertly", () => {
		expect(describeHome(connected({ haVersion: "**@everyone** [x](https://evil.example)" }))).toBe(
			"Connected (version `**@everyone** [x](https://evil.example)`)",
		);
	});

	it("warns when the token belongs to an admin", () => {
		expect(describeHome(connected({ adminToken: true }))).toContain(
			"⚠ The token belongs to an admin user",
		);
		expect(describeHome(connected({ adminToken: undefined }))).not.toContain("⚠");
	});
});

describe("homeLines", () => {
	it("says nothing when all is well, or Home Assistant isn't used", () => {
		expect(homeLines(connected())).toEqual([]);
		expect(homeLines(connected({ adminToken: undefined }))).toEqual([]);
		expect(homeLines({ kind: "unconfigured" })).toEqual([]);
	});

	it("says what needs attention", () => {
		expect(homeLines({ kind: "off", reason: "the token was refused" })).toEqual([
			"Home Assistant is off: the token was refused.",
		]);
		expect(homeLines({ kind: "connecting" })).toEqual([
			"Home Assistant isn't connected right now.",
		]);
		expect(homeLines({ kind: "reconnecting" })).toEqual([
			"Home Assistant isn't connected right now.",
		]);
		expect(homeLines(connected({ adminToken: true }))).toEqual([
			"Home Assistant's token belongs to an admin user. Use a non-admin user's token.",
		]);
	});
});
