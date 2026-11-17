import { describe, expect, it, vi } from "vitest";
import type { AnnouncementRoute } from "../../../src/core/announcement-routes.ts";
import type { ResolvedChannel } from "../../../src/core/command.ts";
import { UserFacingError } from "../../../src/core/errors.ts";
import {
	createAnnouncementsSubgroup,
	describeRoute,
} from "../../../src/features/admin/announcements.ts";
import { context, IDS, principal } from "../../../src/testing/fixtures.ts";

const GENERAL = "111111111111111111";
const channel = (overrides: Partial<ResolvedChannel["caller"]> = {}): ResolvedChannel => ({
	id: GENERAL,
	name: "general",
	caller: { canPost: true, canMentionEveryone: false, canCreatePolls: false, ...overrides },
});

function setup(
	routes: AnnouncementRoute[] = [],
	release: { channelId: string; problem?: string }[] = [],
) {
	const fake = {
		list: vi.fn(() => routes),
		set: vi.fn(async () => ({ result: "added" as const, saved: true })),
		remove: vi.fn(async () => ({ removed: true, previous: "single" as const, saved: true })),
		listRelease: vi.fn(() => release),
		addRelease: vi.fn(async () => ({ result: "added" as const, saved: true })),
		removeRelease: vi.fn(async () => ({ removed: true, saved: true })),
		listNotifications: vi.fn(() => [
			{ kind: "bot" as const, channelId: undefined },
			{ kind: "closingTime" as const, channelId: undefined },
			{ kind: "parking" as const, channelId: undefined },
			{ kind: "foodAlert" as const, channelId: undefined },
		]),
		setNotification: vi.fn(async () => ({ result: "set" as const, saved: true })),
	};
	const group = createAnnouncementsSubgroup({ routes: fake });
	const sub = (name: string) => {
		const found = group.subcommands.find((s) => s.name === name);
		if (!found) throw new Error(`no ${name}`);
		return found;
	};
	return { fake, group, sub };
}

const admin = () => principal("admin", { userId: IDS.admin });

describe("/admin → Announcements", () => {
	it("is admin-only all the way down, and every reply is private", () => {
		const { group } = setup();
		expect(group.name).toBe("announcements");
		expect(group.access.minTier).toBe("admin");
		expect(group.subcommands.map((s) => [s.name, s.access.minTier, s.private])).toEqual([
			["set", "admin", true],
			["remove", "admin", true],
			["set-release", "admin", true],
			["remove-release", "admin", true],
			["set-notification", "admin", true],
			["list", "admin", true],
		]);
	});

	it("offers exactly the three styles, and a channel", () => {
		const { sub } = setup();
		expect(sub("set").options).toEqual([
			expect.objectContaining({
				name: "style",
				choices: ["live", "timeline", "single"],
				required: true,
			}),
			expect.objectContaining({ name: "channel", type: "channel", required: true }),
		]);
		expect(sub("remove").options).toEqual([
			expect.objectContaining({ name: "channel", type: "channel", required: true }),
		]);
	});

	describe("set", () => {
		const run = (
			sub: ReturnType<typeof setup>["sub"],
			args: Record<string, string>,
			ch = channel(),
		) => sub("set").handler(context({ principal: admin(), args, channels: { channel: ch } }));

		it("sets the style for the channel and says what it does", async () => {
			const { fake, sub } = setup();
			const reply = await run(sub, { style: "single" });
			expect(fake.set).toHaveBeenCalledWith("single", GENERAL);
			expect(reply.private).toBe(true);
			expect(reply.text).toContain(`<#${GENERAL}>`);
			expect(reply.text).toContain("**single** style");
			expect(reply.text).toContain("deletes the old");
			expect(reply.text).toContain("next time the space opens or closes");
		});

		it("says when the style changed, and that old posts stay", async () => {
			const { fake, sub } = setup();
			fake.set.mockResolvedValueOnce({ result: "changed", previous: "live", saved: true } as never);
			const reply = await run(sub, { style: "single" });
			expect(reply.text).toContain("now uses the **single** style (it was **live**)");
			expect(reply.text).toContain("stay as they are");
		});

		it("says when nothing changed", async () => {
			const { fake, sub } = setup();
			fake.set.mockResolvedValueOnce({ result: "unchanged", saved: true } as never);
			expect((await run(sub, { style: "live" })).text).toContain(
				"already announces in the **live** style",
			);
		});

		it("warns when it couldn't be saved", async () => {
			const { fake, sub } = setup();
			fake.set.mockResolvedValueOnce({ result: "added", saved: false } as never);
			expect((await run(sub, { style: "live" })).text).toContain("only holds until Pixel restarts");
		});

		it("refuses a channel the admin couldn't post in themselves, without changing anything", async () => {
			const { fake, sub } = setup();
			await expect(run(sub, { style: "live" }, channel({ canPost: false }))).rejects.toThrow(
				"where you can post yourself",
			);
			expect(fake.set).not.toHaveBeenCalled();
		});

		it("refuses a style that isn't one of the three, even though the platform offered choices", async () => {
			const { fake, sub } = setup();
			await expect(run(sub, { style: "everything" })).rejects.toBeInstanceOf(UserFacingError);
			await expect(
				sub("set").handler(context({ principal: admin(), args: { style: "live" }, channels: {} })),
			).rejects.toBeInstanceOf(UserFacingError);
			expect(fake.set).not.toHaveBeenCalled();
		});

		it("passes on why a channel can't be used", async () => {
			const { fake, sub } = setup();
			fake.set.mockRejectedValueOnce(
				new UserFacingError("I can't announce in that channel: nope."),
			);
			await expect(run(sub, { style: "live" })).rejects.toThrow(
				"I can't announce in that channel: nope.",
			);
		});
	});

	describe("remove", () => {
		const run = (sub: ReturnType<typeof setup>["sub"], channels: Record<string, ResolvedChannel>) =>
			sub("remove").handler(context({ principal: admin(), channels }));

		it("stops announcing in the channel and says old posts stay", async () => {
			const { fake, sub } = setup();
			const reply = await run(sub, { channel: channel() });
			expect(fake.remove).toHaveBeenCalledWith(GENERAL);
			expect(reply.text).toContain(`Stopped announcing in <#${GENERAL}>`);
			expect(reply.text).toContain("stay as they are");
		});

		it("says when the channel wasn't set up", async () => {
			const { fake, sub } = setup();
			fake.remove.mockResolvedValueOnce({ removed: false, saved: true } as never);
			expect((await run(sub, { channel: channel() })).text).toBe(
				`<#${GENERAL}> wasn't set up for announcements.`,
			);
		});

		it("warns when it couldn't be saved", async () => {
			const { fake, sub } = setup();
			fake.remove.mockResolvedValueOnce({ removed: true, previous: "live", saved: false } as never);
			expect((await run(sub, { channel: channel() })).text).toContain(
				"only holds until Pixel restarts",
			);
		});

		it("needs a channel", async () => {
			const { sub } = setup();
			await expect(run(sub, {})).rejects.toBeInstanceOf(UserFacingError);
		});
	});

	describe("set-release", () => {
		const run = (sub: ReturnType<typeof setup>["sub"], ch = channel()) =>
			sub("set-release").handler(
				context({ principal: admin(), args: {}, channels: { channel: ch } }),
			);

		it("sets the release channel and says what it does", async () => {
			const { fake, sub } = setup();
			const reply = await run(sub);
			expect(fake.addRelease).toHaveBeenCalledWith(GENERAL);
			expect(reply.private).toBe(true);
			expect(reply.text).toContain(`<#${GENERAL}>`);
			expect(reply.text).toContain("release notes");
		});

		it("says when nothing changed", async () => {
			const { fake, sub } = setup();
			fake.addRelease.mockResolvedValueOnce({ result: "unchanged", saved: true } as never);
			expect((await run(sub)).text).toContain("already gets Pixel release notes");
		});

		it("refuses a channel the admin couldn't post in themselves", async () => {
			const { fake, sub } = setup();
			await expect(run(sub, channel({ canPost: false }))).rejects.toThrow(
				"where you can post yourself",
			);
			expect(fake.addRelease).not.toHaveBeenCalled();
		});
	});

	describe("remove-release", () => {
		const run = (sub: ReturnType<typeof setup>["sub"], channels: Record<string, ResolvedChannel>) =>
			sub("remove-release").handler(context({ principal: admin(), channels }));

		it("stops posting releases and says old posts stay", async () => {
			const { fake, sub } = setup();
			const reply = await run(sub, { channel: channel() });
			expect(fake.removeRelease).toHaveBeenCalledWith(GENERAL);
			expect(reply.text).toContain(`Stopped posting release notes in <#${GENERAL}>`);
			expect(reply.text).toContain("stay as they are");
		});

		it("says when the channel wasn't set up", async () => {
			const { fake, sub } = setup();
			fake.removeRelease.mockResolvedValueOnce({ removed: false, saved: true } as never);
			expect((await run(sub, { channel: channel() })).text).toBe(
				`<#${GENERAL}> wasn't set up for release announcements.`,
			);
		});
	});

	describe("list", () => {
		it("says how to start when nothing is set", async () => {
			const { sub } = setup();
			const reply = await sub("list").handler(context({ principal: admin() }));
			expect(reply.text).toContain("`/admin` → Announcements");
			expect(reply.text).toContain("No channels get open/closed or release announcements");
		});

		it("lists every channel with its style, marks problems, and explains the styles", async () => {
			const { sub } = setup(
				[
					{ style: "timeline", channelId: "222222222222222222" },
					{ style: "single", channelId: GENERAL, problem: "the bot can't see it" },
				],
				[{ channelId: "333333333333333333", problem: "missing permissions" }],
			);
			const text = (await sub("list").handler(context({ principal: admin() }))).text ?? "";
			expect(text).toContain("<#222222222222222222>: **timeline**");
			expect(text).toContain(`<#${GENERAL}>: **single** ⚠️ not posting: the bot can't see it`);
			expect(text).toContain(
				"<#333333333333333333>: **release** ⚠️ not posting: missing permissions",
			);
			expect(text).toContain("**single**: only the latest status");
			expect(text).toContain("**release**: when a new Pixel version goes live");
		});

		it("describes one route", () => {
			expect(describeRoute({ style: "live", channelId: GENERAL })).toBe(`<#${GENERAL}>: **live**`);
		});
	});
});
