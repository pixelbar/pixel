import { describe, expect, it, vi } from "vitest";
import { UserFacingError } from "../../../src/core/errors.ts";
import { createDoorbellSubgroup, describeDoorbell } from "../../../src/features/admin/doorbell.ts";
import { context, IDS, principal, subcommand } from "../../../src/testing/fixtures.ts";

const CHANNEL = "100000000000000050";
const general = {
	id: CHANNEL,
	name: "general",
	caller: { canPost: true, canMentionEveryone: false, canCreatePolls: false },
};

const deps = (over: { channelId?: string; problem?: string; saved?: boolean } = {}) => ({
	settings: {
		channelId: over.channelId,
		problem: over.problem,
		set: vi.fn(() => ({ changed: true, saved: over.saved ?? true })),
	},
	posts: { check: vi.fn(async () => ({ ok: true as const, name: "general" })) },
	configured: true,
});

const op = (name: string, d: ReturnType<typeof deps>) => {
	const found = createDoorbellSubgroup(d).subcommands.find((s) => s.name === name);
	return found ?? subcommand();
};
const admin = principal("admin", { userId: IDS.admin });

describe("describeDoorbell", () => {
	it("says where it's posted, and what's wrong with the file", () => {
		expect(describeDoorbell(deps({ channelId: CHANNEL }))).toBe(
			`The doorbell is posted in <#${CHANNEL}>.`,
		);
		expect(describeDoorbell(deps({ problem: "data/doorbell.yaml is invalid" }))).toBe(
			"No channel is set, so the doorbell isn't posted.\n⚠️ data/doorbell.yaml is invalid.",
		);
		expect(describeDoorbell({ ...deps(), configured: false })).toMatch(/isn't connected here/);
	});
});

describe("the doorbell operations", () => {
	it("needs a channel", async () => {
		await expect(
			op("set", deps()).handler(context({ principal: admin, channels: {} })),
		).rejects.toBeInstanceOf(UserFacingError);
	});

	it("says when a change couldn't be saved", async () => {
		const d = deps({ saved: false });
		const set = await op("set", d).handler(
			context({ principal: admin, channels: { channel: general } }),
		);
		expect(set.text).toContain("only holds until Pixel restarts");
		const clear = await op("clear", d).handler(context({ principal: admin }));
		expect(clear.text).toContain("only holds until Pixel restarts");
		expect(d.settings.set).toHaveBeenLastCalledWith(undefined, `discord:${IDS.admin}`);
	});
});
