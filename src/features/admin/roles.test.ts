import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformActor } from "../../core/access.ts";
import { CapabilityRegistry } from "../../core/capabilities.ts";
import type { ResolvedUser } from "../../core/command.ts";
import { Dispatcher, MESSAGES } from "../../core/dispatcher.ts";
import { Home, type HomeBackend, type HomeStatus } from "../../core/home.ts";
import { IdentityService } from "../../core/identity.ts";
import type { Logger } from "../../core/logger.ts";
import { silentLogger } from "../../core/logger.ts";
import type { ErrorReporter } from "../../core/ports/error-reporter.ts";
import { RateLimiter } from "../../core/rate-limit.ts";
import { CommandRegistry } from "../../core/registry.ts";
import {
	type Inspection,
	type MirrorBackend,
	type MirrorResult,
	RoleMirror,
	type TierMirrorState,
} from "../../core/role-mirror.ts";
import { ConfigTierSource } from "../../services/access-config.ts";
import { FileAccessStore, nodeFileOps } from "../../services/access-store.ts";
import { HomeDeviceStore } from "../../services/home-devices.ts";
import { HomeInventory } from "../../services/home-inventory.ts";
import { KindSwitch } from "../../services/kind-switch.ts";
import { actor, IDS } from "../../testing/fixtures.ts";
import { createAdminFeature } from "./index.ts";

const TARGET = "100000000000000050";
const SECOND = "100000000000000070";
const ADMINS = `admins:\n  - ids: ["discord:${IDS.admin}"]\n`;
const MEMBERS = `members:
  - ids: ["discord:${IDS.admin}"]
    tier: member
  - ids: ["discord:${IDS.member}", "discord:${SECOND}"]
    tier: member
  - ids: ["discord:${IDS.friend}"]
    tier: friend
  - ids: ["discord:${IDS.guest}"]
    tier: guest
`;

const STATES_ON: TierMirrorState[] = [
	{ tier: "member", status: "on", role: "member" },
	{ tier: "friend", status: "on", role: "friend" },
];

let dir: string;
let membersFile: string;
let logs: { level: string; obj: Record<string, unknown> }[];
let reporter: ErrorReporter;

function logger(): Logger {
	const make = (bindings: Record<string, unknown>): Logger => ({
		debug: (obj) => logs.push({ level: "debug", obj: { ...bindings, ...obj } }),
		info: (obj) => logs.push({ level: "info", obj: { ...bindings, ...obj } }),
		warn: (obj) => logs.push({ level: "warn", obj: { ...bindings, ...obj } }),
		error: (obj) => logs.push({ level: "error", obj: { ...bindings, ...obj } }),
		child: (more) => make({ ...bindings, ...more }),
	});
	return make({});
}

type Fake = {
	states: ReturnType<typeof vi.fn<MirrorBackend["states"]>>;
	apply: ReturnType<typeof vi.fn<MirrorBackend["apply"]>>;
	inspect: ReturnType<typeof vi.fn<MirrorBackend["inspect"]>>;
};

function fakeBackend(overrides: Partial<MirrorBackend> = {}): Fake {
	return {
		states: vi.fn<MirrorBackend["states"]>(overrides.states ?? (async () => STATES_ON)),
		apply: vi.fn<MirrorBackend["apply"]>(
			overrides.apply ?? (async () => ({ kind: "in-sync", off: [] })),
		),
		inspect: vi.fn<MirrorBackend["inspect"]>(
			overrides.inspect ?? (async () => ({ kind: "ok", holdings: [] })),
		),
	};
}

function setup(backend?: Fake, homeBackend?: HomeBackend) {
	const store = FileAccessStore.open({
		paths: { adminsFile: join(dir, "admins.yaml"), membersFile },
		logger: logger(),
		reporter,
		ops: nodeFileOps,
	});
	const roles = new RoleMirror({ logger: logger(), reporter });
	const home = new Home({ logger: logger(), reporter });
	if (homeBackend) home.attach(homeBackend);
	if (backend) roles.attach(backend);
	const commands = new CommandRegistry();
	commands.register(
		createAdminFeature({
			version: "1",
			startedAt: new Date(),
			access: store,
			capabilities: new CapabilityRegistry(),
			roles,
			home,
			homeDevices: HomeDeviceStore.empty(),
			homeInventory: HomeInventory.off(),
			switches: new KindSwitch({ logger: silentLogger, switchable: ["door"] }),
			reporter,
		}),
	);
	const dispatcher = new Dispatcher({
		registry: commands,
		identity: new IdentityService([new ConfigTierSource(store)]),
		rateLimiter: new RateLimiter({ capacity: 100, refillPerSecond: 0 }),
		logger: logger(),
		reporter,
	});
	return { store, dispatcher, commands, roles };
}

const human = (id: string, displayName = "Someone"): ResolvedUser => ({
	id,
	displayName,
	handle: "someone_h",
	isBot: false,
});

function run(
	dispatcher: Dispatcher,
	subcommand: "set-level" | "sync" | "whois" | "status" | "reload",
	args: Record<string, string>,
	target?: ResolvedUser,
	as: Partial<PlatformActor> = { userId: IDS.admin, displayName: "Ada", handle: "ada_l" },
) {
	return dispatcher.dispatch({
		actor: actor(as),
		command: "admin",
		// The old names are kept in the tests' vocabulary: set-level is /admin level set, whois is /admin level get.
		...(subcommand === "set-level" || subcommand === "whois"
			? { subgroup: "level", subcommand: subcommand === "set-level" ? "set" : "get" }
			: { subcommand }),
		args: target ? { user: target.id, ...args } : args,
		...(target ? { users: { user: target } } : {}),
	});
}

type Result = Awaited<ReturnType<typeof run>>;
const fieldsOf = (result: Result) =>
	Object.fromEntries(
		(result.reply.embeds?.[0]?.fields ?? []).map((f) => [f.name, f.value] as const),
	);
const read = () => readFileSync(membersFile, "utf8");

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pixel-roles-"));
	membersFile = join(dir, "members.yaml");
	writeFileSync(join(dir, "admins.yaml"), ADMINS);
	writeFileSync(membersFile, MEMBERS);
	logs = [];
	reporter = {
		capture: vi.fn(),
		captureBackground: vi.fn(),
		breadcrumb: vi.fn(),
	};
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("/admin level set mirrors to Discord", () => {
	it("updates Pixel first, then Discord, and passes an audit-log reason naming the admin", async () => {
		let fileWhenMirrored = "";
		const backend = fakeBackend({
			apply: vi.fn<MirrorBackend["apply"]>(async () => {
				fileWhenMirrored = read();
				return { kind: "updated", added: ["member"], removed: [], off: [] };
			}),
		});
		const { dispatcher } = setup(backend);
		const result = await run(dispatcher, "set-level", { level: "member" }, human(TARGET));

		expect(fileWhenMirrored).toContain(`discord:${TARGET}`);
		expect(backend.apply).toHaveBeenCalledWith(
			TARGET,
			"member",
			`Set to member by Ada (${IDS.admin}) via Pixel`,
		);
		expect(fieldsOf(result)["Discord roles"]).toBe("Discord roles: added `member`.");
		expect(result.reply.embeds?.[0]?.title).toBe("Access level changed");
	});

	it.each([
		["guest to friend", TARGET, "friend"],
		["member to guest", IDS.member, "guest"],
		["friend to member", IDS.friend, "member"],
	] as const)("asks Discord for the new level: %s", async (_label, id, level) => {
		const backend = fakeBackend();
		const { dispatcher } = setup(backend);
		await run(dispatcher, "set-level", { level }, human(id));
		expect(backend.apply).toHaveBeenCalledWith(
			id,
			level,
			expect.stringContaining(`Set to ${level}`),
		);
	});

	it("shows removed roles and the tiers that aren't being mirrored", async () => {
		const backend = fakeBackend({
			apply: async () => ({
				kind: "updated",
				added: ["member"],
				removed: ["friend"],
				off: [{ tier: "friend", reason: "that role isn't below the bot's highest role" }],
			}),
		});
		const { dispatcher } = setup(backend);
		const result = await run(dispatcher, "set-level", { level: "member" }, human(IDS.friend));
		expect(fieldsOf(result)["Discord roles"]).toBe(
			"Discord roles: added `member`, removed `friend`. Not mirrored: friend (that role isn't below the bot's highest role).",
		);
	});

	it("shows role names as inert code spans, whatever a moderator called the role", async () => {
		const backend = fakeBackend({
			apply: async () => ({
				kind: "updated",
				added: ["# **@everyone** [x](https://evil.example)`"],
				removed: [],
				off: [],
			}),
		});
		const { dispatcher } = setup(backend);
		const result = await run(dispatcher, "set-level", { level: "member" }, human(TARGET));
		expect(fieldsOf(result)["Discord roles"]).toBe(
			"Discord roles: added `# **@everyone** [x](https://evil.example)'`.",
		);
	});

	it("keeps Pixel's change and says plainly that Discord wasn't changed, and how to fix it", async () => {
		const backend = fakeBackend({
			apply: async () => ({ kind: "failed", reason: "that person isn't in the Discord server" }),
		});
		const { dispatcher, store } = setup(backend);
		const result = await run(dispatcher, "set-level", { level: "member" }, human(TARGET));
		expect(store.view.discord.get(TARGET)).toBe("member");
		expect(read()).toContain(`discord:${TARGET}`);
		expect(fieldsOf(result)["Discord roles"]).toBe(
			"Pixel is updated, but the Discord roles weren't changed: that person isn't in the Discord server. Run /admin sync once that's fixed.",
		);
	});

	it("still puts Discord right when Pixel says nothing changed", async () => {
		const backend = fakeBackend({
			apply: async () => ({ kind: "updated", added: ["member"], removed: [], off: [] }),
		});
		const { dispatcher } = setup(backend);
		const before = read();
		const result = await run(dispatcher, "set-level", { level: "member" }, human(IDS.member));
		expect(read()).toBe(before);
		expect(result.reply.text).toBe(
			"Someone (100000000000000002) is already set to Pixelbar member. Nothing changed in Pixel.\nDiscord roles: added `member`.",
		);
		expect(backend.apply).toHaveBeenCalledWith(
			IDS.member,
			"member",
			`Synced to member by Ada (${IDS.admin}) via Pixel`,
		);
	});

	it("says nothing about Discord when no roles are mapped, so replies are as before", async () => {
		const backend = fakeBackend({ apply: async () => ({ kind: "unconfigured" }) });
		const { dispatcher } = setup(backend);
		const changed = await run(dispatcher, "set-level", { level: "member" }, human(TARGET));
		expect(fieldsOf(changed)).not.toHaveProperty("Discord roles");
		const same = await run(dispatcher, "set-level", { level: "member" }, human(IDS.member));
		expect(same.reply.text).toContain("Nothing changed.");
		expect(same.reply.text).not.toContain("Discord");
	});

	it("works with no backend attached at all", async () => {
		const { dispatcher } = setup();
		const result = await run(dispatcher, "set-level", { level: "member" }, human(TARGET));
		expect(result.reply.embeds?.[0]?.title).toBe("Access level changed");
		expect(fieldsOf(result)).not.toHaveProperty("Discord roles");
	});

	it("doesn't touch Discord for an admin, or for a refusal", async () => {
		const backend = fakeBackend();
		const { dispatcher } = setup(backend);
		await run(dispatcher, "set-level", { level: "guest" }, human(IDS.admin));
		await run(dispatcher, "set-level", { level: "admin" }, human(TARGET));
		await run(dispatcher, "set-level", { level: "member" }, { ...human(TARGET), isBot: true });
		expect(backend.apply).not.toHaveBeenCalled();
	});

	it("doesn't touch Discord when a non-admin tries", async () => {
		const backend = fakeBackend();
		const { dispatcher } = setup(backend);
		const result = await run(dispatcher, "set-level", { level: "member" }, human(TARGET), {
			userId: IDS.member,
		});
		expect(result.reply.text).toBe(MESSAGES.deniedTier);
		expect(backend.apply).not.toHaveBeenCalled();
	});
});

describe("/admin sync", () => {
	it("says there's nothing to sync when no roles are mapped", async () => {
		const backend = fakeBackend({
			states: async () => STATES_ON.map((s) => ({ tier: s.tier, status: "unconfigured" as const })),
		});
		const { dispatcher } = setup(backend);
		const result = await run(dispatcher, "sync", {});
		expect(result.reply.text).toBe("Role mirroring isn't configured, so there is nothing to sync.");
		expect(backend.apply).not.toHaveBeenCalled();
		expect((await run(dispatcher, "sync", {}, human(IDS.member))).reply.text).toContain(
			"nothing to sync",
		);
	});

	it("says so with no backend attached", async () => {
		const { dispatcher } = setup();
		expect((await run(dispatcher, "sync", {})).reply.text).toContain("isn't configured");
	});

	it.each([
		["a member", IDS.member, "member"],
		["a person's second id", SECOND, "member"],
		["a friend", IDS.friend, "friend"],
		["someone set to guest", IDS.guest, "guest"],
		["someone Pixel doesn't list", TARGET, "guest"],
		["an admin, by their members entry", IDS.admin, "member"],
	] as const)("pushes what Pixel's data says for %s", async (_label, id, wanted) => {
		const backend = fakeBackend({
			apply: async () => ({ kind: "updated", added: ["member"], removed: [], off: [] }),
		});
		const { dispatcher } = setup(backend);
		const result = await run(dispatcher, "sync", {}, human(id));
		expect(backend.apply).toHaveBeenCalledWith(
			id,
			wanted,
			`Synced to ${wanted} by Ada (${IDS.admin}) via Pixel`,
		);
		expect(result.reply.embeds?.[0]?.title).toBe("Discord roles synced");
		expect(fieldsOf(result).Result).toBe("Discord roles: added `member`.");
	});

	it("marks a failure as one", async () => {
		const backend = fakeBackend({
			apply: async () => ({ kind: "failed", reason: "that person isn't in the Discord server" }),
		});
		const { dispatcher } = setup(backend);
		const result = await run(dispatcher, "sync", {}, human(IDS.member));
		expect(result.reply.embeds?.[0]?.accent).toBe("negative");
		expect(fieldsOf(result).Result).toBe(
			"The Discord roles weren't changed: that person isn't in the Discord server.",
		);
	});

	it("never changes Pixel's data, whatever Discord says", async () => {
		const backend = fakeBackend({
			inspect: async () => ({
				kind: "ok",
				holdings: [{ tier: "member", role: "member", has: true }],
			}),
		});
		const { dispatcher, store } = setup(backend);
		const before = read();
		await run(dispatcher, "sync", {}, human(IDS.guest));
		await run(dispatcher, "sync", {});
		expect(read()).toBe(before);
		expect(store.view.discord.has(IDS.guest)).toBe(false);
	});

	it("shows a placeholder while it works", () => {
		const { commands } = setup();
		const admin = commands.get("admin")?.definition;
		const sync = admin?.subcommands?.find((s) => s.name === "sync");
		expect(sync).toMatchObject({ placeholder: { text: "Syncing Discord roles…", private: true } });
	});

	describe("for everyone in Pixel's lists", () => {
		it("syncs every id once, counts the outcomes, and lists why some failed", async () => {
			const outcomes = new Map<string, MirrorResult>([
				[IDS.admin, { kind: "in-sync", off: [] }],
				[IDS.member, { kind: "updated", added: ["member"], removed: [], off: [] }],
				[SECOND, { kind: "in-sync", off: [] }],
				[IDS.friend, { kind: "failed", reason: "that person isn't in the Discord server" }],
				[IDS.guest, { kind: "failed", reason: "that person isn't in the Discord server" }],
			]);
			const backend = fakeBackend({
				apply: async (userId) => outcomes.get(userId) ?? { kind: "in-sync", off: [] },
			});
			const { dispatcher } = setup(backend);
			const result = await run(dispatcher, "sync", {});

			expect(backend.apply).toHaveBeenCalledTimes(5);
			expect(backend.apply.mock.calls.map((c) => c[0]).sort()).toEqual(
				[IDS.admin, IDS.member, SECOND, IDS.friend, IDS.guest].sort(),
			);
			expect(result.reply.embeds?.[0]?.accent).toBe("warning");
			expect(fieldsOf(result)).toMatchObject({
				Updated: "1",
				"Already matched": "2",
				Failed: "2",
				Why: "2 × that person isn't in the Discord server",
			});
			expect(result.reply.embeds?.[0]?.description).toContain("5 people in Pixel's lists");
			expect(result.reply.embeds?.[0]?.description).toContain("aren't touched");
			expect(logs.find((l) => l.obj.event === "admin.sync")?.obj).toMatchObject({
				people: 5,
				updated: 1,
				inSync: 2,
				failed: 2,
				user: `discord:${IDS.admin}`,
			});
		});

		it("is positive, and has no 'Why', when nothing failed", async () => {
			const { dispatcher } = setup(fakeBackend());
			const result = await run(dispatcher, "sync", {});
			expect(result.reply.embeds?.[0]?.accent).toBe("positive");
			expect(fieldsOf(result)).not.toHaveProperty("Why");
			expect(fieldsOf(result)).toMatchObject({ Updated: "0", Failed: "0" });
		});

		it("says which tiers aren't being mirrored", async () => {
			const off = [
				{ tier: "friend" as const, reason: "no role matches the configured name or ID" },
			];
			const { dispatcher } = setup(fakeBackend({ apply: async () => ({ kind: "in-sync", off }) }));
			const result = await run(dispatcher, "sync", {});
			expect(result.reply.embeds?.[0]?.description).toContain(
				"Not mirrored: friend (no role matches the configured name or ID).",
			);
		});

		it("says 'person' for a single listed person", async () => {
			writeFileSync(membersFile, `members:\n  - ids: ["discord:${IDS.admin}"]\n    tier: member\n`);
			const { dispatcher } = setup(fakeBackend());
			const result = await run(dispatcher, "sync", {});
			expect(result.reply.embeds?.[0]?.description).toContain("1 person in Pixel's lists");
		});
	});

	it("is for admins only", async () => {
		const backend = fakeBackend();
		const { dispatcher } = setup(backend);
		const result = await run(dispatcher, "sync", {}, undefined, { userId: IDS.member });
		expect(result.reply.text).toBe(MESSAGES.deniedTier);
		expect(backend.apply).not.toHaveBeenCalled();
	});
});

describe("/admin level get shows Discord roles", () => {
	const inspect = (holdings: { tier: "member" | "friend"; role: string; has: boolean }[]) =>
		fakeBackend({ inspect: async () => ({ kind: "ok", holdings }) });

	it("shows the mapped roles someone holds, and that they match", async () => {
		const { dispatcher } = setup(
			inspect([
				{ tier: "member", role: "member", has: true },
				{ tier: "friend", role: "friend", has: false },
			]),
		);
		const result = await run(dispatcher, "whois", {}, human(IDS.member));
		expect(fieldsOf(result)["Discord roles"]).toBe(
			"`member` yes · `friend` no\nMatches their Pixel level.",
		);
	});

	it.each([
		[
			"a role they shouldn't have",
			IDS.member,
			[{ tier: "friend" as const, role: "friend", has: true }],
		],
		["a missing role", IDS.member, [{ tier: "member" as const, role: "member", has: false }]],
		[
			"a guest who holds a role",
			IDS.guest,
			[{ tier: "member" as const, role: "member", has: true }],
		],
		[
			"someone unlisted who holds a role",
			TARGET,
			[{ tier: "friend" as const, role: "friend", has: true }],
		],
	])("flags a mismatch: %s", async (_label, id, holdings) => {
		const { dispatcher } = setup(inspect(holdings));
		const result = await run(dispatcher, "whois", {}, human(id));
		expect(fieldsOf(result)["Discord roles"]).toContain(
			"⚠ Doesn't match their Pixel level. Run /admin sync.",
		);
	});

	it("matches a guest who holds no mapped role", async () => {
		const { dispatcher } = setup(inspect([{ tier: "member", role: "member", has: false }]));
		const result = await run(dispatcher, "whois", {}, human(IDS.guest));
		expect(fieldsOf(result)["Discord roles"]).toContain("Matches their Pixel level.");
	});

	it("compares an admin with their members entry", async () => {
		const { dispatcher } = setup(inspect([{ tier: "member", role: "member", has: true }]));
		const result = await run(dispatcher, "whois", {}, human(IDS.admin));
		expect(fieldsOf(result)["Discord roles"]).toContain("Matches their Pixel level.");
	});

	it("says when they aren't in the server, or the check failed", async () => {
		const gone = setup(fakeBackend({ inspect: async () => ({ kind: "not-in-server" }) }));
		expect(
			fieldsOf(await run(gone.dispatcher, "whois", {}, human(IDS.member)))["Discord roles"],
		).toBe("They aren't in the Discord server.");
		const failed = setup(
			fakeBackend({
				inspect: async () => ({
					kind: "failed",
					reason: "no role matches the configured name or ID",
				}),
			}),
		);
		expect(
			fieldsOf(await run(failed.dispatcher, "whois", {}, human(IDS.member)))["Discord roles"],
		).toBe("Couldn't check: no role matches the configured name or ID.");
	});

	it("leaves the field out when roles aren't mapped, or nothing is attached", async () => {
		const unconfigured = setup(
			fakeBackend({ inspect: async (): Promise<Inspection> => ({ kind: "unconfigured" }) }),
		);
		expect(
			fieldsOf(await run(unconfigured.dispatcher, "whois", {}, human(IDS.member))),
		).not.toHaveProperty("Discord roles");
		const none = setup();
		expect(fieldsOf(await run(none.dispatcher, "whois", {}, human(IDS.member)))).not.toHaveProperty(
			"Discord roles",
		);
	});

	it("shows hostile role names as inert code spans", async () => {
		const { dispatcher } = setup(
			inspect([{ tier: "member", role: "[click](https://evil.example) @everyone", has: true }]),
		);
		const result = await run(dispatcher, "whois", {}, human(IDS.member));
		expect(fieldsOf(result)["Discord roles"]).toContain(
			"`[click](https://evil.example) @everyone` yes",
		);
	});

	it("doesn't look up Discord for a bot", async () => {
		const backend = inspect([]);
		const { dispatcher } = setup(backend);
		await run(dispatcher, "whois", {}, { ...human(TARGET), isBot: true });
		expect(backend.inspect).not.toHaveBeenCalled();
	});

	it("only reads: whois never changes Pixel or Discord", async () => {
		const backend = inspect([{ tier: "member", role: "member", has: true }]);
		const { dispatcher } = setup(backend);
		const before = read();
		await run(dispatcher, "whois", {}, human(IDS.guest));
		expect(read()).toBe(before);
		expect(backend.apply).not.toHaveBeenCalled();
	});
});

describe("/admin status and reload", () => {
	it("shows each tier's state, with reasons", async () => {
		const backend = fakeBackend({
			states: async () => [
				{ tier: "member", status: "on", role: "member" },
				{ tier: "friend", status: "off", reason: "that role isn't below the bot's highest role" },
			],
		});
		const { dispatcher } = setup(backend);
		const result = await run(dispatcher, "status", {});
		expect(fieldsOf(result)["Discord roles"]).toBe(
			"member: on (`member`)\nfriend: off, that role isn't below the bot's highest role",
		);
	});

	it("says a tier isn't mirrored when only the other one is", async () => {
		const backend = fakeBackend({
			states: async () => [
				{ tier: "member", status: "on", role: "member" },
				{ tier: "friend", status: "unconfigured" },
			],
		});
		const { dispatcher } = setup(backend);
		expect(fieldsOf(await run(dispatcher, "status", {}))["Discord roles"]).toBe(
			"member: on (`member`)\nfriend: not mirrored",
		);
	});

	it("says 'Not configured' when nothing is mapped, or nothing is attached", async () => {
		expect(fieldsOf(await run(setup().dispatcher, "status", {}))["Discord roles"]).toBe(
			"Not configured",
		);
	});

	it("re-checks the roles on reload, and reports a tier that is off", async () => {
		const backend = fakeBackend({
			states: async () => [
				{ tier: "member", status: "on", role: "member" },
				{ tier: "friend", status: "off", reason: "no role matches the configured name or ID" },
			],
		});
		const { dispatcher } = setup(backend);
		const result = await run(dispatcher, "reload", {});
		expect(result.reply.text).toContain(
			"Role mirroring for friend is off: no role matches the configured name or ID.",
		);
		expect(backend.states).toHaveBeenCalled();
		expect(reporter.captureBackground).toHaveBeenCalledTimes(1);
	});

	it("says nothing about roles on reload when they're fine, or not configured", async () => {
		const ok = await run(setup(fakeBackend()).dispatcher, "reload", {});
		expect(ok.reply.text).not.toContain("Role mirroring");
		const none = await run(setup().dispatcher, "reload", {});
		expect(none.reply.text).not.toContain("Role mirroring");
	});
});

describe("/admin status and reload show Home Assistant", () => {
	const homeBackend = (status: HomeStatus): HomeBackend & { check: ReturnType<typeof vi.fn> } => ({
		status: () => status,
		check: vi.fn(async () => status),
		getStates: async () => new Map(),
		callService: async () => {},
		listEntities: async () => [],
	});

	it("says it isn't configured when nothing is plugged in", async () => {
		const result = await run(setup().dispatcher, "status", {});
		expect(fieldsOf(result)["Home Assistant"]).toBe("Not configured");
	});

	it("shows a connection, and an admin token as a warning", async () => {
		const ok = setup(
			undefined,
			homeBackend({ kind: "connected", haVersion: "2026.10.0", adminToken: false }),
		);
		expect(fieldsOf(await run(ok.dispatcher, "status", {}))["Home Assistant"]).toBe(
			"Connected (version `2026.10.0`)",
		);
		const admin = setup(
			undefined,
			homeBackend({ kind: "connected", haVersion: "2026.10.0", adminToken: true }),
		);
		expect(fieldsOf(await run(admin.dispatcher, "status", {}))["Home Assistant"]).toContain(
			"⚠ The token belongs to an admin user",
		);
	});

	it("shows a refused token and an unreachable Home Assistant", async () => {
		const off = setup(
			undefined,
			homeBackend({
				kind: "off",
				reason: "Home Assistant refused the token, so it needs replacing",
			}),
		);
		expect(fieldsOf(await run(off.dispatcher, "status", {}))["Home Assistant"]).toBe(
			"Off: Home Assistant refused the token, so it needs replacing",
		);
		const down = setup(undefined, homeBackend({ kind: "reconnecting" }));
		expect(fieldsOf(await run(down.dispatcher, "status", {}))["Home Assistant"]).toBe(
			"Not connected, trying to reconnect",
		);
	});

	it("re-checks the connection on reload, and says what needs attention", async () => {
		const backend = homeBackend({
			kind: "off",
			reason: "Home Assistant refused the token, so it needs replacing",
		});
		const { dispatcher } = setup(undefined, backend);
		const result = await run(dispatcher, "reload", {});
		expect(backend.check).toHaveBeenCalled();
		expect(result.reply.text).toContain(
			"Home Assistant is off: Home Assistant refused the token, so it needs replacing.",
		);
		expect(reporter.captureBackground).toHaveBeenCalledTimes(1);
	});

	it("says nothing about Home Assistant on reload when all is well or it isn't used", async () => {
		const ok = setup(
			undefined,
			homeBackend({ kind: "connected", haVersion: "1", adminToken: false }),
		);
		expect((await run(ok.dispatcher, "reload", {})).reply.text).not.toContain("Home Assistant");
		expect((await run(setup().dispatcher, "reload", {})).reply.text).not.toContain(
			"Home Assistant",
		);
	});
});

describe("Pixel never reads a role to decide a tier", () => {
	it("gives someone who holds the member role in Discord no access in Pixel", async () => {
		const backend = fakeBackend({
			inspect: async () => ({
				kind: "ok",
				holdings: [{ tier: "member", role: "member", has: true }],
			}),
		});
		const { dispatcher, store } = setup(backend);
		expect(store.view.discord.get(TARGET)).toBeUndefined();
		const result = await run(dispatcher, "whois", {}, human(IDS.admin), { userId: TARGET });
		expect(result.reply.text).toBe(MESSAGES.deniedTier);
		expect(store.view.discord.get(TARGET)).toBeUndefined();
		expect(backend.apply).not.toHaveBeenCalled();
	});
});
