import { describe, expect, it } from "vitest";
import { actor } from "../testing/fixtures.ts";
import type { Tier } from "./access.ts";
import { IdentityService } from "./identity.ts";
import type { CapabilitySource } from "./ports/capability-source.ts";
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
		expect(p).toEqual({ ...a, tier: "admin", capabilities: [] });
	});
});

describe("IdentityService capabilities", () => {
	const grants = (...names: string[]): CapabilitySource => ({
		name: "fixed",
		capabilitiesFor: async () => names,
	});

	it("has none without capability sources", async () => {
		const p = await new IdentityService([source("member")]).resolve(actor());
		expect(p.capabilities).toEqual([]);
	});

	it("combines what every source grants, without repeats", async () => {
		const identity = new IdentityService(
			[source("member")],
			[grants("door", "workshop"), grants("door"), grants()],
		);
		expect((await identity.resolve(actor())).capabilities).toEqual(["door", "workshop"]);
	});

	it("gives a guest none, whatever a source says", async () => {
		const identity = new IdentityService([source(null)], [grants("door")]);
		const p = await identity.resolve(actor());
		expect(p.tier).toBe("guest");
		expect(p.capabilities).toEqual([]);
	});

	it("gives a member their grants, and an admin theirs", async () => {
		expect(
			(await new IdentityService([source("admin")], [grants("door")]).resolve(actor()))
				.capabilities,
		).toEqual(["door"]);
	});
});
