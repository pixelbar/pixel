import { describe, expect, it } from "vitest";
import { principal } from "../testing/fixtures.ts";
import {
	actorLogFields,
	actorRef,
	checkAccess,
	highestTier,
	TIERS,
	tierAtLeast,
} from "./access.ts";

describe("actorRef", () => {
	it("is the platform-prefixed user ID", () => {
		expect(actorRef({ platform: "discord", userId: "100000000000000002" })).toBe(
			"discord:100000000000000002",
		);
	});
});

describe("actorLogFields", () => {
	const base = {
		platform: "discord",
		userId: "100000000000000002",
		displayName: "Ada",
		chat: "group",
	} as const;

	it("includes the ID, display name and handle", () => {
		expect(actorLogFields({ ...base, handle: "ada_l" })).toEqual({
			user: "discord:100000000000000002",
			userName: "Ada",
			userHandle: "ada_l",
		});
	});

	it("omits the handle when the platform has none", () => {
		expect(actorLogFields(base)).toEqual({ user: "discord:100000000000000002", userName: "Ada" });
	});
});

describe("tiers", () => {
	it("are ordered guest < friend < member < admin", () => {
		expect(TIERS).toEqual(["guest", "friend", "member", "admin"]);
	});

	it.each([
		["guest", "guest", true],
		["guest", "friend", false],
		["friend", "member", false],
		["member", "friend", true],
		["admin", "member", true],
		["member", "admin", false],
	] as const)("tierAtLeast(%s, %s) is %s", (tier, required, expected) => {
		expect(tierAtLeast(tier, required)).toBe(expected);
	});

	it("highestTier defaults to guest", () => {
		expect(highestTier([])).toBe("guest");
	});

	it("highestTier picks the most privileged tier", () => {
		expect(highestTier(["friend", "admin", "member"])).toBe("admin");
	});
});

describe("checkAccess", () => {
	it("allows a tier at or above the minimum", () => {
		expect(checkAccess({ minTier: "member" }, principal("member"))).toEqual({ allowed: true });
		expect(checkAccess({ minTier: "member" }, principal("admin"))).toEqual({ allowed: true });
	});

	it("denies a tier below the minimum", () => {
		expect(checkAccess({ minTier: "member" }, principal("friend"))).toEqual({
			allowed: false,
			reason: "tier",
		});
	});

	it("denies a disallowed chat context", () => {
		expect(
			checkAccess({ minTier: "guest", contexts: ["dm"] }, principal("admin", { chat: "group" })),
		).toEqual({ allowed: false, reason: "context" });
	});

	it("denies a command on a platform it doesn't run on, after the tier", () => {
		const discordOnly = { minTier: "member", platforms: ["discord"] } as const;
		expect(checkAccess(discordOnly, principal("admin"))).toEqual({ allowed: true });
		expect(checkAccess(discordOnly, principal("admin", { platform: "telegram" }))).toEqual({
			allowed: false,
			reason: "platform",
		});
		expect(checkAccess(discordOnly, principal("guest", { platform: "telegram" }))).toEqual({
			allowed: false,
			reason: "tier",
		});
		expect(checkAccess({ minTier: "guest" }, principal("guest", { platform: "telegram" }))).toEqual(
			{
				allowed: true,
			},
		);
	});

	it("checks the tier before the context", () => {
		expect(
			checkAccess({ minTier: "admin", contexts: ["dm"] }, principal("guest", { chat: "group" })),
		).toEqual({ allowed: false, reason: "tier" });
	});

	describe("capabilities", () => {
		const needsDoor = { minTier: "member", capability: "door" } as const;

		it("needs both the tier and the capability", () => {
			expect(checkAccess(needsDoor, principal("member", {}, ["door"]))).toEqual({ allowed: true });
			expect(checkAccess(needsDoor, principal("member"))).toEqual({
				allowed: false,
				reason: "capability",
			});
			expect(checkAccess(needsDoor, principal("member", {}, ["other"]))).toEqual({
				allowed: false,
				reason: "capability",
			});
		});

		it("is refused below the tier even with the capability", () => {
			expect(checkAccess(needsDoor, principal("friend", {}, ["door"]))).toEqual({
				allowed: false,
				reason: "tier",
			});
		});

		it("is never implied by a tier, admin included", () => {
			expect(checkAccess(needsDoor, principal("admin"))).toEqual({
				allowed: false,
				reason: "capability",
			});
			expect(checkAccess(needsDoor, principal("admin", {}, ["door"]))).toEqual({ allowed: true });
		});

		it("never lets a guest through, whatever they hold", () => {
			expect(
				checkAccess({ minTier: "guest", capability: "door" }, principal("guest", {}, ["door"])),
			).toEqual({
				allowed: false,
				reason: "tier",
			});
		});

		it("checks the context before the capability", () => {
			expect(
				checkAccess(
					{ minTier: "member", contexts: ["dm"], capability: "door" },
					principal("member", { chat: "group" }, ["door"]),
				),
			).toEqual({ allowed: false, reason: "context" });
		});

		it("doesn't matter when the command names no capability", () => {
			expect(checkAccess({ minTier: "member" }, principal("member", {}, ["door"]))).toEqual({
				allowed: true,
			});
		});
	});
});
