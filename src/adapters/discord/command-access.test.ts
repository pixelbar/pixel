import { describe, expect, it } from "vitest";
import { command, group, IDS } from "../../testing/fixtures.ts";
import {
	adminOverrides,
	authorizeUrl,
	COMMAND_PERMISSIONS_SCOPE,
	hiddenCommandNames,
	MAX_OVERRIDES,
	parseGrant,
} from "./command-access.ts";

describe("hiddenCommandNames", () => {
	it("lists only admin-tier commands and groups", () => {
		expect(
			hiddenCommandNames([
				command({ name: "open" }),
				command({ name: "member", access: { minTier: "member" } }),
				command({ name: "secret", access: { minTier: "admin" } }),
				group({ name: "admin", access: { minTier: "admin" } }),
			]),
		).toEqual(["secret", "admin"]);
	});
});

describe("adminOverrides", () => {
	it("allows each admin by ID and nobody else", () => {
		const access = new Map([
			[`discord:${IDS.admin}`, "admin" as const],
			[`discord:${IDS.member}`, "member" as const],
			[`discord:${IDS.friend}`, "friend" as const],
			// An admin's Telegram ID can't be given a Discord override.
			["telegram:123456789", "admin" as const],
		]);
		expect(adminOverrides(access)).toEqual([{ id: IDS.admin, type: 2, permission: true }]);
	});

	it("refuses more than Discord's limit instead of silently dropping admins", () => {
		const access = new Map(
			Array.from({ length: MAX_OVERRIDES + 1 }, (_, i) => [
				`discord:${100000000000000000n + BigInt(i)}`,
				"admin" as const,
			]),
		);
		expect(() => adminOverrides(access)).toThrow(/at most 100/);
	});
});

describe("authorizeUrl", () => {
	it("asks only for the permissions scope, using the implicit grant", () => {
		const url = new URL(
			authorizeUrl({ appId: "1", redirectUri: "http://localhost:1/callback", state: "abc" }),
		);
		expect(url.origin + url.pathname).toBe("https://discord.com/oauth2/authorize");
		expect(Object.fromEntries(url.searchParams)).toEqual({
			client_id: "1",
			response_type: "token",
			scope: COMMAND_PERMISSIONS_SCOPE,
			redirect_uri: "http://localhost:1/callback",
			state: "abc",
			prompt: "consent",
		});
	});
});

describe("parseGrant", () => {
	const good = "#access_token=tok&token_type=Bearer&expires_in=604800&state=abc";

	it("returns the token when the state matches", () => {
		expect(parseGrant(good, "abc")).toBe("tok");
		expect(parseGrant(good.slice(1), "abc")).toBe("tok");
	});

	it.each([
		["a different state", good, "other"],
		["a missing token", "#token_type=Bearer&state=abc", "abc"],
		["a non-bearer token", "#access_token=tok&token_type=Mac&state=abc", "abc"],
		["an empty fragment", "", "abc"],
	])("rejects %s", (_label, fragment, state) => {
		expect(() => parseGrant(fragment, state)).toThrow();
	});
});
