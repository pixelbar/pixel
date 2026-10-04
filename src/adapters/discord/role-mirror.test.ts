import { PermissionFlagsBits } from "discord.js";
import { describe, expect, it } from "vitest";
import {
	auditReason,
	botStanding,
	type DiscordRole,
	DiscordRoleMirror,
	describeDiscordError,
	planChanges,
	type ResolvedTier,
	type RoleMapping,
	type RoleRest,
	resolveTiers,
} from "./role-mirror.ts";

const GUILD = "100000000000000020";
const BOT = "100000000000000010";
const PERSON = "100000000000000002";
const MEMBER_ID = "100000000000000101";
const FRIEND_ID = "100000000000000102";
const HACKER_ID = "100000000000000103";
const BOT_ROLE_ID = "100000000000000104";

const role = (
	id: string,
	name: string,
	position: number,
	extra: Partial<DiscordRole> = {},
): DiscordRole => ({ id, name, position, managed: false, permissions: "0", ...extra });

/** The test server: pixel above member, friend and hacker. */
const ROLES: DiscordRole[] = [
	role(GUILD, "@everyone", 0),
	role(HACKER_ID, "hacker", 1),
	role(FRIEND_ID, "friend", 2),
	role(MEMBER_ID, "member", 3),
	role(BOT_ROLE_ID, "pixel", 4, { permissions: String(PermissionFlagsBits.ManageRoles) }),
];
const STANDING = { topPosition: 4, canManageRoles: true };
const BOTH = { member: "member", friend: "friend" } as const;

describe("botStanding", () => {
	it("finds the bot's top role and whether it can manage roles", () => {
		expect(botStanding(ROLES, [BOT_ROLE_ID], GUILD)).toEqual({
			topPosition: 4,
			canManageRoles: true,
		});
	});

	it("counts Administrator as enough", () => {
		const roles = [
			role(BOT_ROLE_ID, "pixel", 4, { permissions: String(PermissionFlagsBits.Administrator) }),
		];
		expect(botStanding(roles, [BOT_ROLE_ID], GUILD).canManageRoles).toBe(true);
	});

	it("counts permissions from @everyone, and says no without any", () => {
		const roles = [
			role(GUILD, "@everyone", 0, { permissions: String(PermissionFlagsBits.ManageRoles) }),
			role(BOT_ROLE_ID, "pixel", 4),
		];
		expect(botStanding(roles, [BOT_ROLE_ID], GUILD).canManageRoles).toBe(true);
		expect(botStanding(ROLES.slice(0, 2), [], GUILD)).toEqual({
			topPosition: 0,
			canManageRoles: false,
		});
	});
});

describe("resolveTiers", () => {
	it("maps names and IDs to roles that sit below the bot", () => {
		expect(resolveTiers(BOTH, ROLES, STANDING, GUILD)).toEqual([
			{ tier: "member", status: "on", roleId: MEMBER_ID, roleName: "member" },
			{ tier: "friend", status: "on", roleId: FRIEND_ID, roleName: "friend" },
		]);
		expect(resolveTiers({ member: MEMBER_ID, friend: undefined }, ROLES, STANDING, GUILD)).toEqual([
			{ tier: "member", status: "on", roleId: MEMBER_ID, roleName: "member" },
			{ tier: "friend", status: "unconfigured" },
		]);
	});

	it("leaves a tier alone when it has no role configured", () => {
		const states = resolveTiers({ member: undefined, friend: undefined }, ROLES, STANDING, GUILD);
		expect(states.every((s) => s.status === "unconfigured")).toBe(true);
	});

	it.each([
		["a role that doesn't exist", "nobody", ROLES, STANDING, /no role matches/],
		["an ID that doesn't exist", "100000000000000999", ROLES, STANDING, /no role matches/],
		[
			"a name two roles share",
			"member",
			[...ROLES, role("100000000000000200", "member", 1)],
			STANDING,
			/more than one role has the configured name/,
		],
		[
			"a role managed by an integration",
			"member",
			ROLES.map((r) => (r.id === MEMBER_ID ? { ...r, managed: true } : r)),
			STANDING,
			/managed by an integration/,
		],
		[
			"a role above the bot",
			"member",
			ROLES,
			{ topPosition: 3, canManageRoles: true },
			/isn't below/,
		],
		[
			"a role level with the bot",
			"member",
			ROLES,
			{ topPosition: 2, canManageRoles: true },
			/isn't below/,
		],
		[
			"a bot without Manage Roles",
			"member",
			ROLES,
			{ topPosition: 4, canManageRoles: false },
			/Manage Roles/,
		],
		["@everyone", "@everyone", ROLES, { topPosition: 4, canManageRoles: true }, /@everyone/],
	])(
		"turns the tier off for %s, without repeating the configured name",
		(_label, ref, roles, standing, message) => {
			const [member] = resolveTiers({ member: ref, friend: undefined }, roles, standing, GUILD);
			expect(member).toMatchObject({ tier: "member", status: "off" });
			expect((member as { reason: string }).reason).toMatch(message);
			if (ref !== "@everyone") expect((member as { reason: string }).reason).not.toContain(ref);
		},
	);

	it("turns off a tier that maps to the same role as another, and keeps the first", () => {
		const [member, friend] = resolveTiers(
			{ member: "member", friend: MEMBER_ID },
			ROLES,
			STANDING,
			GUILD,
		);
		expect(member?.status).toBe("on");
		expect(friend).toMatchObject({ status: "off", reason: expect.stringMatching(/same role/) });
	});

	it("turns off only the tier with the problem", () => {
		const states = resolveTiers({ member: "nobody", friend: "friend" }, ROLES, STANDING, GUILD);
		expect(states.map((s) => s.status)).toEqual(["off", "on"]);
	});

	it("tells a numeric-looking name from an ID only by its length", () => {
		const roles = [...ROLES, role("100000000000000300", "2024", 1)];
		const [member] = resolveTiers({ member: "2024", friend: undefined }, roles, STANDING, GUILD);
		expect(member).toMatchObject({ status: "on", roleName: "2024" });
	});
});

describe("planChanges", () => {
	const on: ResolvedTier[] = resolveTiers(BOTH, ROLES, STANDING, GUILD);
	const ids = (list: { roleId: string }[]) => list.map((r) => r.roleId);

	it.each([
		["guest to member", "member", [], [MEMBER_ID], []],
		["guest to friend", "friend", [], [FRIEND_ID], []],
		["friend to member", "member", [FRIEND_ID], [MEMBER_ID], [FRIEND_ID]],
		["member to friend", "friend", [MEMBER_ID], [FRIEND_ID], [MEMBER_ID]],
		["member to guest", "guest", [MEMBER_ID], [], [MEMBER_ID]],
		["friend to guest", "guest", [FRIEND_ID], [], [FRIEND_ID]],
		["already member", "member", [MEMBER_ID], [], []],
		["already guest", "guest", [], [], []],
		["both roles held, wanting member", "member", [MEMBER_ID, FRIEND_ID], [], [FRIEND_ID]],
	] as const)("%s", (_label, wanted, held, add, remove) => {
		const plan = planChanges(wanted, on, new Set(held));
		expect(ids(plan.add)).toEqual(add);
		expect(ids(plan.remove)).toEqual(remove);
	});

	it("never touches roles that aren't mapped, such as hacker", () => {
		const plan = planChanges("guest", on, new Set([HACKER_ID, MEMBER_ID]));
		expect(ids(plan.remove)).toEqual([MEMBER_ID]);
		expect(ids(plan.add)).toEqual([]);
	});

	it("leaves a tier that is off, or not configured, completely alone", () => {
		const half = resolveTiers({ member: "nobody", friend: "friend" }, ROLES, STANDING, GUILD);
		const plan = planChanges("member", half, new Set([MEMBER_ID, FRIEND_ID]));
		expect(ids(plan.add)).toEqual([]);
		expect(ids(plan.remove)).toEqual([FRIEND_ID]);
	});
});

describe("auditReason", () => {
	it("keeps one line and at most 512 characters", () => {
		expect(auditReason("Set to member\nby Ada\u0000 (1)\tvia Pixel")).toBe(
			"Set to member by Ada (1) via Pixel",
		);
		expect([...auditReason("é".repeat(600))]).toHaveLength(512);
	});
});

describe("describeDiscordError", () => {
	it.each([
		[10007, /isn't in the Discord server/],
		[10013, /isn't in the Discord server/],
		[50013, /isn't allowed to change that role/],
		[50001, /can't access the server/],
	])("explains Discord error %i", (code, message) => {
		expect(describeDiscordError({ code })).toMatch(message);
	});

	it("doesn't explain what it doesn't know", () => {
		expect(describeDiscordError({ code: 99999 })).toBeUndefined();
		expect(describeDiscordError(new Error("x"))).toBeUndefined();
		expect(describeDiscordError(null)).toBeUndefined();
		expect(describeDiscordError("text")).toBeUndefined();
	});
});

/** A server in memory: roles, the bot's roles and what each person holds. */
function fakeDiscord(
	options: {
		roles?: DiscordRole[];
		botRoles?: string[];
		members?: Record<string, string[]>;
		failOn?: { method: "put" | "delete"; code: number };
		failGet?: unknown;
	} = {},
) {
	const members: Record<string, string[]> = { [PERSON]: [], ...options.members };
	const calls: { method: string; route: string; reason?: string | undefined }[] = [];
	const rest: RoleRest = {
		async get(route) {
			calls.push({ method: "get", route });
			if (options.failGet) throw options.failGet;
			if (route === `/guilds/${GUILD}/roles`) return options.roles ?? ROLES;
			const member = /\/members\/(\d+)$/.exec(route)?.[1];
			if (member === BOT) return { roles: options.botRoles ?? [BOT_ROLE_ID] };
			if (member && members[member]) return { roles: members[member] };
			throw { code: 10007 };
		},
		async put(route, opts) {
			calls.push({ method: "put", route, reason: opts?.reason });
			if (options.failOn?.method === "put") throw { code: options.failOn.code };
			const [, user, roleId] = /\/members\/(\d+)\/roles\/(\d+)$/.exec(route) ?? [];
			members[user as string]?.push(roleId as string);
		},
		async delete(route, opts) {
			calls.push({ method: "delete", route, reason: opts?.reason });
			if (options.failOn?.method === "delete") throw { code: options.failOn.code };
			const [, user, roleId] = /\/members\/(\d+)\/roles\/(\d+)$/.exec(route) ?? [];
			members[user as string] = (members[user as string] ?? []).filter((r) => r !== roleId);
		},
	};
	return { rest, calls, members };
}

const mirrorFor = (rest: RoleRest, mapping: RoleMapping = BOTH) =>
	new DiscordRoleMirror({ rest, guildId: GUILD, botId: BOT, mapping });

describe("DiscordRoleMirror", () => {
	it("reports each tier's state, checked fresh", async () => {
		const { rest, calls } = fakeDiscord();
		const mirror = mirrorFor(rest);
		expect(await mirror.states()).toEqual([
			{ tier: "member", status: "on", role: "member" },
			{ tier: "friend", status: "on", role: "friend" },
		]);
		await mirror.states();
		expect(calls.filter((c) => c.route.endsWith("/roles")).length).toBe(2);
	});

	it("doesn't call Discord at all when nothing is mapped", async () => {
		const { rest, calls } = fakeDiscord();
		const mirror = mirrorFor(rest, { member: undefined, friend: undefined });
		expect(await mirror.apply(PERSON, "member", "why")).toEqual({ kind: "unconfigured" });
		expect(await mirror.inspect(PERSON)).toEqual({ kind: "unconfigured" });
		expect((await mirror.states()).every((s) => s.status === "unconfigured")).toBe(true);
		expect(calls).toEqual([]);
	});

	it("grants the role, with the audit-log reason, and says what it did", async () => {
		const { rest, calls, members } = fakeDiscord();
		const result = await mirrorFor(rest).apply(
			PERSON,
			"member",
			"Set to member by Ada (1) via Pixel",
		);
		expect(result).toEqual({ kind: "updated", added: ["member"], removed: [], off: [] });
		expect(members[PERSON]).toEqual([MEMBER_ID]);
		expect(calls.find((c) => c.method === "put")).toMatchObject({
			route: `/guilds/${GUILD}/members/${PERSON}/roles/${MEMBER_ID}`,
			reason: "Set to member by Ada (1) via Pixel",
		});
	});

	it("swaps one tier's role for the other, taking the old one away first", async () => {
		const { rest, calls, members } = fakeDiscord({ members: { [PERSON]: [FRIEND_ID, HACKER_ID] } });
		const result = await mirrorFor(rest).apply(PERSON, "member", "why");
		expect(result).toEqual({ kind: "updated", added: ["member"], removed: ["friend"], off: [] });
		expect(members[PERSON]).toEqual([HACKER_ID, MEMBER_ID]);
		expect(calls.filter((c) => c.method !== "get").map((c) => c.method)).toEqual(["delete", "put"]);
	});

	it("takes both away for a guest and leaves other roles alone", async () => {
		const { rest, members } = fakeDiscord({ members: { [PERSON]: [MEMBER_ID, HACKER_ID] } });
		await mirrorFor(rest).apply(PERSON, "guest", "why");
		expect(members[PERSON]).toEqual([HACKER_ID]);
	});

	it("changes nothing, and writes nothing, when the roles already match", async () => {
		const { rest, calls } = fakeDiscord({ members: { [PERSON]: [MEMBER_ID] } });
		const result = await mirrorFor(rest).apply(PERSON, "member", "why");
		expect(result).toEqual({ kind: "in-sync", off: [] });
		expect(calls.some((c) => c.method !== "get")).toBe(false);
	});

	it("mirrors the tiers that work and lists the ones that don't", async () => {
		const { rest, members } = fakeDiscord();
		const result = await mirrorFor(rest, { member: "member", friend: "nobody" }).apply(
			PERSON,
			"member",
			"why",
		);
		expect(result).toMatchObject({ kind: "updated", added: ["member"] });
		expect((result as { off: unknown[] }).off).toEqual([
			{ tier: "friend", reason: expect.stringMatching(/no role matches/) },
		]);
		expect(members[PERSON]).toEqual([MEMBER_ID]);
	});

	it("fails plainly, without changing anything, when every configured tier is off", async () => {
		const { rest, calls } = fakeDiscord({ botRoles: [] });
		const result = await mirrorFor(rest).apply(PERSON, "member", "why");
		expect(result).toMatchObject({ kind: "failed", reason: expect.stringMatching(/Manage Roles/) });
		expect(calls.some((c) => c.method !== "get")).toBe(false);
	});

	it("says so when the person isn't in the server", async () => {
		const { rest } = fakeDiscord();
		expect(await mirrorFor(rest).apply("100000000000000999", "member", "why")).toEqual({
			kind: "failed",
			reason: "that person isn't in the Discord server",
		});
	});

	it.each([
		["put", "member"],
		["delete", "guest"],
	] as const)("explains a Discord refusal on %s", async (method, wanted) => {
		const { rest } = fakeDiscord({
			members: { [PERSON]: wanted === "guest" ? [MEMBER_ID] : [] },
			failOn: { method, code: 50013 },
		});
		expect(await mirrorFor(rest).apply(PERSON, wanted, "why")).toEqual({
			kind: "failed",
			reason: "Discord says the bot isn't allowed to change that role",
		});
	});

	it("lets an error it can't explain through, for the caller to report", async () => {
		const boom = new Error("unexpected");
		const { rest } = fakeDiscord({ failOn: { method: "put", code: 99999 } });
		await expect(mirrorFor(rest).apply(PERSON, "member", "why")).rejects.toEqual({ code: 99999 });
		const failing = fakeDiscord({ failGet: boom });
		await expect(mirrorFor(failing.rest).inspect(PERSON)).rejects.toBe(boom);
	});

	describe("inspect", () => {
		it("shows which mapped roles someone holds, and nothing else", async () => {
			const { rest } = fakeDiscord({ members: { [PERSON]: [MEMBER_ID, HACKER_ID] } });
			expect(await mirrorFor(rest).inspect(PERSON)).toEqual({
				kind: "ok",
				holdings: [
					{ tier: "member", role: "member", has: true },
					{ tier: "friend", role: "friend", has: false },
				],
			});
		});

		it("only lists the tiers that work", async () => {
			const { rest } = fakeDiscord();
			const inspection = await mirrorFor(rest, { member: "member", friend: "nobody" }).inspect(
				PERSON,
			);
			expect(inspection).toEqual({
				kind: "ok",
				holdings: [{ tier: "member", role: "member", has: false }],
			});
		});

		it("says when they aren't in the server, or nothing can be checked", async () => {
			const { rest } = fakeDiscord();
			expect(await mirrorFor(rest).inspect("100000000000000999")).toEqual({
				kind: "not-in-server",
			});
			const broken = fakeDiscord({ botRoles: [] });
			expect(await mirrorFor(broken.rest).inspect(PERSON)).toMatchObject({ kind: "failed" });
		});

		it("never writes", async () => {
			const { rest, calls } = fakeDiscord({ members: { [PERSON]: [FRIEND_ID] } });
			await mirrorFor(rest).inspect(PERSON);
			expect(calls.some((c) => c.method !== "get")).toBe(false);
		});
	});
});
