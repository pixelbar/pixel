import { describe, expect, it, vi } from "vitest";
import { silentLogger } from "./logger.ts";
import type { AccessChange, AccessView, MemberRecord, MemberTier } from "./ports/access-store.ts";
import { nullErrorReporter } from "./ports/error-reporter.ts";
import type { HolderList, MirroredTier, RoleHolder } from "./role-mirror.ts";
import { MAX_DEMOTIONS, planSync, RoleSync } from "./role-sync.ts";

const ADA = "100000000000000001";
const BOB = "100000000000000002";
const CY = "100000000000000003";
const DEE = "100000000000000004";
const ALT = "100000000000000005";
const BOT = "100000000000000010";
const BOTH: MirroredTier[] = ["member", "friend"];

type Entry = { ids: string[]; tier: MemberTier; note?: string; admin?: boolean };

/** An access view like the store builds: admins override their entry's tier. */
function viewOf(entries: Entry[]): AccessView {
	const records = new Map<string, MemberRecord>();
	const discord = new Map<string, "admin" | "member" | "friend">();
	for (const entry of entries) {
		const record: MemberRecord = {
			ids: entry.ids.map((id) => `discord:${id}`),
			tier: entry.tier,
			capabilities: [],
			revoked: [],

			...(entry.note ? { note: entry.note } : {}),
		};
		for (const id of entry.ids) {
			records.set(id, record);
			if (entry.admin) discord.set(id, "admin");
			else if (entry.tier !== "guest") discord.set(id, entry.tier);
		}
	}
	return {
		discord,
		records,
		tierCapabilities: { member: [], friend: [] },
		counts: { admins: 0, members: 0, friends: 0 },
		warnings: [],
	};
}

const holder = (userId: string, ...tiers: MirroredTier[]): RoleHolder => ({
	userId,
	username: `user${userId.slice(-1)}`,
	tiers,
});

describe("planSync", () => {
	it("adds role holders who aren't in the file, with their username for the note", () => {
		const plan = planSync(viewOf([]), BOTH, [holder(ADA, "member"), holder(BOB, "friend")]);
		expect(plan).toEqual({
			changes: [
				{ userId: ADA, from: "none", to: "member", username: "user1" },
				{ userId: BOB, from: "none", to: "friend", username: "user2" },
			],
			heldBack: 0,
		});
	});

	it("uses the highest role someone holds", () => {
		const plan = planSync(viewOf([{ ids: [ADA], tier: "friend" }]), BOTH, [
			holder(ADA, "friend", "member"),
		]);
		expect(plan.changes).toEqual([{ userId: ADA, from: "friend", to: "member" }]);
	});

	it("brings an existing entry up or down to the role they hold, guests included", () => {
		const view = viewOf([
			{ ids: [ADA], tier: "member" },
			{ ids: [BOB], tier: "guest" },
			{ ids: [CY], tier: "friend" },
		]);
		const plan = planSync(view, BOTH, [
			holder(ADA, "friend"),
			holder(BOB, "member"),
			holder(CY, "friend"),
		]);
		expect(plan.changes).toEqual([
			{ userId: ADA, from: "member", to: "friend" },
			{ userId: BOB, from: "guest", to: "member" },
		]);
	});

	it("makes someone a guest when they no longer hold their level's role", () => {
		const view = viewOf([
			{ ids: [ADA], tier: "member" },
			{ ids: [BOB], tier: "friend" },
			{ ids: [CY], tier: "guest" },
		]);
		expect(planSync(view, BOTH, []).changes).toEqual([
			{ userId: ADA, from: "member", to: "guest" },
			{ userId: BOB, from: "friend", to: "guest" },
		]);
	});

	it("never touches an admin", () => {
		const view = viewOf([{ ids: [ADA], tier: "member", admin: true }]);
		expect(planSync(view, BOTH, []).changes).toEqual([]);
		expect(planSync(view, BOTH, [holder(ADA, "friend")]).changes).toEqual([]);
		expect(
			planSync(viewOf([{ ids: [BOB], tier: "guest", admin: true }]), BOTH, [holder(BOB, "member")])
				.changes,
		).toEqual([]);
	});

	it("leaves a level whose role isn't mapped alone", () => {
		const view = viewOf([
			{ ids: [ADA], tier: "member" },
			{ ids: [BOB], tier: "friend" },
		]);
		// Only friend is mapped: a member without the friend role keeps their level.
		expect(planSync(view, ["friend"], []).changes).toEqual([
			{ userId: BOB, from: "friend", to: "guest" },
		]);
		// A member holding the friend role isn't brought down to friend.
		expect(
			planSync(view, ["friend"], [holder(ADA, "friend"), holder(BOB, "friend")]).changes,
		).toEqual([]);
		// Only member is mapped: a friend holding it goes up.
		expect(planSync(view, ["member"], [holder(BOB, "member")]).changes).toEqual([
			{ userId: BOB, from: "friend", to: "member" },
			{ userId: ADA, from: "member", to: "guest" },
		]);
		// A role held for an unmapped tier counts for nothing.
		expect(planSync(viewOf([]), ["member"], [holder(CY, "friend")]).changes).toEqual([]);
	});

	it("treats a person with several IDs as one, holding a role on any of them", () => {
		const view = viewOf([{ ids: [ADA, ALT], tier: "friend" }]);
		expect(planSync(view, BOTH, [holder(ALT, "member")]).changes).toEqual([
			{ userId: ADA, from: "friend", to: "member" },
		]);
		expect(planSync(view, BOTH, [holder(ALT, "friend")]).changes).toEqual([]);
		expect(planSync(view, BOTH, []).changes).toEqual([
			{ userId: ADA, from: "friend", to: "guest" },
		]);
	});

	it("holds back every removal when there are too many at once, but still adds", () => {
		const many = Array.from({ length: MAX_DEMOTIONS + 1 }, (_, i) => ({
			ids: [String(100000000000000100n + BigInt(i))],
			tier: "member" as const,
		}));
		const plan = planSync(viewOf(many), BOTH, [holder(DEE, "friend")]);
		expect(plan.heldBack).toBe(MAX_DEMOTIONS + 1);
		expect(plan.changes).toEqual([{ userId: DEE, from: "none", to: "friend", username: "user4" }]);
		expect(planSync(viewOf(many.slice(1)), BOTH, []).changes).toHaveLength(MAX_DEMOTIONS);
	});
});

/** An access store in memory that applies set-tier like the real one (minus the file). */
function fakeAccess(entries: Entry[]) {
	let entriesNow = entries;
	const access = {
		get view() {
			return viewOf(entriesNow);
		},
		apply: vi.fn(async (change: AccessChange) => {
			if (change.kind !== "set-tier") throw new Error("unexpected");
			const existing = entriesNow.find((entry) => entry.ids.includes(change.id));
			entriesNow = existing
				? entriesNow.map((entry) => (entry === existing ? { ...entry, tier: change.tier } : entry))
				: [...entriesNow, { ids: [change.id], tier: change.tier }];
			const after = viewOf(entriesNow).records.get(change.id) as MemberRecord;
			return { before: null, after };
		}),
		set(next: Entry[]) {
			entriesNow = next;
		},
	};
	return access;
}

function setup(
	entries: Entry[],
	list: HolderList | (() => Promise<HolderList>),
	options: {
		applied?: (id: string, since: number) => boolean;
		pushFailed?: (id: string) => boolean;
	} = {},
) {
	const access = fakeAccess(entries);
	const logger = { ...silentLogger, info: vi.fn(), warn: vi.fn(), error: vi.fn() };
	logger.child = () => logger;
	const reporter = { ...nullErrorReporter, captureBackground: vi.fn() };
	const roles = {
		holders: vi.fn(typeof list === "function" ? list : async () => list),
		appliedSince: vi.fn(options.applied ?? (() => false)),
		pushFailed: vi.fn(options.pushFailed ?? (() => false)),
	};
	const sync = new RoleSync({
		access,
		roles,
		logger,
		reporter,
		everyMs: 60_000,
		now: () => 1_000_000,
	});
	return { sync, access, roles, logger, reporter };
}

const ok = (...people: RoleHolder[]): HolderList => ({
	kind: "ok",
	managed: BOTH,
	people,
	self: BOT,
});

describe("RoleSync", () => {
	it("applies the plan through the store, as the bot, with a reason and the username note", async () => {
		const { sync, access } = setup([{ ids: [BOB], tier: "member" }], ok(holder(ADA, "member")));
		expect(await sync.run()).toEqual({ kind: "done", applied: 2, skipped: 0, heldBack: 0 });
		const by = {
			platform: "discord",
			userId: BOT,
			displayName: "Pixel (Discord role sync)",
			chat: "group",
		};
		expect(access.apply).toHaveBeenCalledWith(
			{ kind: "set-tier", id: BOB, tier: "guest", reason: "Discord role removed" },
			by,
		);
		expect(access.apply).toHaveBeenCalledWith(
			{
				kind: "set-tier",
				id: ADA,
				tier: "member",
				defaultNote: "user1",
				reason: "Has the member role",
			},
			by,
		);
	});

	it("does nothing when roles aren't mapped", async () => {
		const { sync, access, reporter } = setup([], { kind: "unconfigured" });
		expect(await sync.run()).toEqual({ kind: "unconfigured" });
		expect(access.apply).not.toHaveBeenCalled();
		expect(reporter.captureBackground).not.toHaveBeenCalled();
	});

	it("pauses when roles can't be read, reporting once until it works again", async () => {
		let list: HolderList = { kind: "failed", reason: "no intent" };
		const { sync, access, reporter, logger } = setup(
			[{ ids: [ADA], tier: "member" }],
			async () => list,
		);
		expect(await sync.run()).toEqual({ kind: "failed", reason: "no intent" });
		await sync.run();
		expect(access.apply).not.toHaveBeenCalled();
		expect(reporter.captureBackground).toHaveBeenCalledOnce();
		list = ok(holder(ADA, "member"));
		await sync.run();
		expect(logger.info).toHaveBeenCalledWith(
			{ event: "role_sync.ok" },
			"role sync is working again",
		);
	});

	it("skips someone whose roles Pixel just pushed, so it can't undo an admin's change", async () => {
		const { sync, access, roles } = setup([{ ids: [ADA], tier: "member" }], ok(), {
			applied: (id) => id === ADA,
		});
		expect(await sync.run()).toMatchObject({ applied: 0, skipped: 1 });
		expect(access.apply).not.toHaveBeenCalled();
		// Within two runs of now.
		expect(roles.appliedSince).toHaveBeenCalledWith(ADA, 1_000_000 - 120_000);
	});

	it("skips someone whose last push Discord didn't take, however long ago", async () => {
		const { sync, access } = setup(
			[
				{ ids: [ADA], tier: "member" },
				{ ids: [BOB], tier: "member" },
			],
			ok(),
			{ pushFailed: (id) => id === ADA },
		);
		expect(await sync.run()).toMatchObject({ applied: 1, skipped: 1 });
		expect(access.apply).toHaveBeenCalledOnce();
		expect(access.apply).toHaveBeenCalledWith(
			expect.objectContaining({ id: BOB }),
			expect.anything(),
		);
	});

	it("skips someone whose level changed after the roles were read", async () => {
		const { sync, access } = setup([{ ids: [ADA], tier: "member" }], async () => {
			return ok();
		});
		const run = sync.run();
		access.set([{ ids: [ADA], tier: "friend" }]);
		// The plan is made after the read, so this change is seen; a change during apply is too.
		expect(await run).toMatchObject({ applied: 1 });
		const second = setup(
			[
				{ ids: [ADA], tier: "member" },
				{ ids: [BOB], tier: "member" },
			],
			ok(),
		);
		second.access.apply.mockImplementationOnce(async (change) => {
			second.access.set([
				{ ids: [ADA], tier: "guest" },
				{ ids: [BOB], tier: "friend" },
			]);
			return { before: null, after: second.access.view.records.get(change.id) as MemberRecord };
		});
		expect(await second.sync.run()).toMatchObject({ applied: 1, skipped: 1 });
	});

	it("carries on past a change the store refuses, and logs it without the note", async () => {
		const { sync, access, logger } = setup([], ok(holder(ADA, "member"), holder(BOB, "friend")));
		access.apply.mockRejectedValueOnce(new Error("invalid file"));
		expect(await sync.run()).toMatchObject({ applied: 1, skipped: 1 });
		expect(logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({ event: "role_sync.change_failed", target: `discord:${ADA}` }),
			expect.any(String),
		);
	});

	it("reports held-back removals once", async () => {
		const many = Array.from({ length: MAX_DEMOTIONS + 1 }, (_, i) => ({
			ids: [String(100000000000000100n + BigInt(i))],
			tier: "member" as const,
		}));
		const { sync, access, reporter } = setup(many, ok());
		expect(await sync.run()).toMatchObject({ applied: 0, heldBack: MAX_DEMOTIONS + 1 });
		await sync.run();
		expect(access.apply).not.toHaveBeenCalled();
		expect(reporter.captureBackground).toHaveBeenCalledOnce();
	});

	it("doesn't overlap runs", async () => {
		let release: (list: HolderList) => void = () => {};
		const { sync, roles } = setup([], () => new Promise((resolve) => (release = resolve)));
		const first = sync.run();
		expect(await sync.run()).toEqual({ kind: "done", applied: 0, skipped: 0, heldBack: 0 });
		release(ok());
		await first;
		expect(roles.holders).toHaveBeenCalledOnce();
	});

	it("runs at start and on a timer until stopped, catching its own failures", async () => {
		vi.useFakeTimers();
		try {
			const { sync, roles, reporter } = setup([], async () => {
				throw new Error("boom");
			});
			const stop = sync.start();
			await vi.advanceTimersByTimeAsync(60_000);
			expect(roles.holders).toHaveBeenCalledTimes(2);
			expect(reporter.captureBackground).toHaveBeenCalledTimes(2);
			stop();
			await vi.advanceTimersByTimeAsync(120_000);
			expect(roles.holders).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});
});
