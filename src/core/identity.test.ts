import { describe, expect, it } from "vitest";
import { actor } from "../testing/fixtures.ts";
import type { Tier } from "./access.ts";
import { IdentityService } from "./identity.ts";
import type { TierSource } from "./ports/tier-source.ts";

const source = (tier: Tier | null): TierSource => ({ name: "fixed", tierFor: async () => tier });

describe("IdentityService", () => {
	it("makes unknown actors guests", async () => {
		const identity = new IdentityService([source(null)]);
		expect((await identity.resolve(actor())).tier).toBe("guest");
	});

	it("is guest with no sources at all", async () => {
		expect((await new IdentityService([]).resolve(actor())).tier).toBe("guest");
	});

	it("takes the highest tier across sources", async () => {
		const identity = new IdentityService([source("friend"), source(null), source("member")]);
		expect((await identity.resolve(actor())).tier).toBe("member");
	});

	it("keeps the actor's fields on the principal", async () => {
		const a = actor({ displayName: "Ada" });
		const p = await new IdentityService([source("admin")]).resolve(a);
		expect(p).toEqual({ ...a, tier: "admin" });
	});
});
