import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformActor } from "../../core/access.ts";
import { CapabilityRegistry } from "../../core/capabilities.ts";
import type { ResolvedUser } from "../../core/command.ts";
import { Dispatcher, MESSAGES } from "../../core/dispatcher.ts";
import { Home } from "../../core/home.ts";
import { IdentityService } from "../../core/identity.ts";
import type { Logger } from "../../core/logger.ts";
import { silentLogger } from "../../core/logger.ts";
import { MAX_REASON_LENGTH } from "../../core/ports/access-store.ts";
import type { ErrorReporter } from "../../core/ports/error-reporter.ts";
import { RateLimiter } from "../../core/rate-limit.ts";
import { CommandRegistry } from "../../core/registry.ts";
import { RoleMirror } from "../../core/role-mirror.ts";
import { ConfigTierSource, StoreCapabilitySource } from "../../services/access-config.ts";
import { FileAccessStore, nodeFileOps } from "../../services/access-store.ts";
import { HomeDeviceStore } from "../../services/home-devices.ts";
import { HomeInventory } from "../../services/home-inventory.ts";
import { KindSwitch } from "../../services/kind-switch.ts";
import { actor, IDS } from "../../testing/fixtures.ts";
import { createAdminFeature } from "./index.ts";

const ADMINS = `admins:\n  - ids: ["discord:${IDS.admin}"]\n`;
const MEMBERS = `members:
  - ids: ["discord:${IDS.admin}"]
    tier: member
  - ids: ["discord:${IDS.member}"]
    tier: member
  - ids: ["discord:${IDS.friend}"]
    tier: friend
    capabilities:
      - workshop
`;
/** Someone demoted to guest who still has a capability in the file. */
const DEMOTED = "100000000000000060";
const UNLISTED = "100000000000000061";

const REGISTRY = new CapabilityRegistry([
	{ name: "front-door", description: "Open the front door" },
	{ name: "workshop", description: "Use the workshop" },
]);

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

function openStore(ops = nodeFileOps) {
	return FileAccessStore.open({
		paths: { adminsFile: join(dir, "admins.yaml"), membersFile },
		logger: logger(),
		reporter,
		ops,
	});
}

function setup(registry = REGISTRY, ops = nodeFileOps) {
	const notified: { userId: string; before: readonly string[]; after: readonly string[] }[] = [];
	const store = FileAccessStore.open({
		paths: { adminsFile: join(dir, "admins.yaml"), membersFile },
		logger: logger(),
		reporter,
		ops,
		notify: {
			notify: async (userId, before, after) => {
				notified.push({ userId, before, after });
			},
		},
	});
	const commands = new CommandRegistry();
	commands.register(
		createAdminFeature({
			version: "1",
			startedAt: new Date(),
			access: store,
			capabilities: registry,
			roles: new RoleMirror({ logger: silentLogger, reporter }),
			home: new Home({ logger: silentLogger, reporter }),
			homeDevices: HomeDeviceStore.empty(),
			homeInventory: HomeInventory.off(),
			switches: new KindSwitch({ logger: silentLogger, switchable: ["door"] }),
			reporter,
		}),
	);
	const dispatcher = new Dispatcher({
		registry: commands,
		identity: new IdentityService(
			[new ConfigTierSource(store)],
			[new StoreCapabilitySource(store)],
		),
		rateLimiter: new RateLimiter({ capacity: 100, refillPerSecond: 0 }),
		logger: logger(),
		reporter,
	});
	return { store, dispatcher, commands, notified };
}

const human = (id: string, displayName = "Someone"): ResolvedUser => ({
	id,
	displayName,
	handle: "someone_h",
	isBot: false,
});

function run(
	dispatcher: Dispatcher,
	subcommand: "grant" | "revoke" | "list",
	args: Record<string, string>,
	target?: ResolvedUser,
	as: Partial<PlatformActor> = { userId: IDS.admin, displayName: "Ada", handle: "ada_l" },
) {
	return dispatcher.dispatch({
		actor: actor(as),
		command: "admin",
		subgroup: "capabilities",
		subcommand,
		args: target ? { user: target.id, ...args } : args,
		...(target ? { users: { user: target } } : {}),
	});
}

const fieldsOf = (result: Awaited<ReturnType<typeof run>>) =>
	Object.fromEntries(
		(result.reply.embeds?.[0]?.fields ?? []).map((f) => [f.name, f.value] as const),
	);
const read = () => readFileSync(membersFile, "utf8");
const events = (name: string) => logs.filter((l) => l.obj.event === name);

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pixel-caps-"));
	membersFile = join(dir, "members.yaml");
	writeFileSync(join(dir, "admins.yaml"), ADMINS);
	writeFileSync(
		membersFile,
		`${MEMBERS}  - ids: ["discord:${DEMOTED}"]\n    tier: guest\n    capabilities:\n      - front-door\n`,
	);
	logs = [];
	reporter = { capture: vi.fn(), captureBackground: vi.fn(), breadcrumb: vi.fn() };
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));
const BEFORE = () => readFileSync(membersFile, "utf8");

describe("who may run them", () => {
	it.each([
		["a member", IDS.member],
		["a friend", IDS.friend],
		["a guest", IDS.guest],
	])("refuses grant, revoke and list to %s, and changes nothing", async (_label, userId) => {
		const { dispatcher } = setup();
		const before = BEFORE();
		for (const sub of ["grant", "revoke", "list"] as const) {
			const result = await run(dispatcher, sub, { capability: "front-door" }, human(IDS.member), {
				userId,
			});
			expect(result.reply.text).toBe(MESSAGES.deniedTier);
		}
		expect(read()).toBe(before);
	});

	it("lists them as /admin capabilities grant, revoke and list for /help", async () => {
		const { commands } = setup();
		const admin = commands.get("admin")?.definition;
		expect(admin?.subcommands?.map((s) => s.name)).toContain("capabilities");
	});
});

describe("grant", () => {
	it("gives a member a capability, persists it, and audits it", async () => {
		const { dispatcher, store, notified } = setup();
		const result = await run(
			dispatcher,
			"grant",
			{ capability: "front-door", reason: "key holder" },
			human(IDS.member, "Grace"),
		);

		expect(result.private).toBe(true);
		expect(result.reply.embeds?.[0]?.title).toBe("Capability granted");
		expect(fieldsOf(result)).toMatchObject({
			Person: `Grace (${IDS.member})`,
			Capability: "front-door: Open the front door",
		});
		expect(store.view.records.get(IDS.member)?.capabilities).toEqual(["front-door"]);
		expect(openStore().view.records.get(IDS.member)?.capabilities).toEqual(["front-door"]);

		expect(events("access.changed")[0]?.obj).toMatchObject({
			kind: "set-capabilities",
			user: `discord:${IDS.admin}`,
			userName: "Ada",
			target: `discord:${IDS.member}`,
			before: { tier: "member", capabilities: [] },
			after: { tier: "member", capabilities: ["front-door"] },
			reason: "key holder",
		});
		expect(notified).toEqual([{ userId: IDS.member, before: [], after: ["front-door"] }]);
	});

	it("adds to what someone already has", async () => {
		const { dispatcher } = setup();
		await run(dispatcher, "grant", { capability: "front-door" }, human(IDS.friend));
		expect(openStore().view.records.get(IDS.friend)?.capabilities).toEqual([
			"workshop",
			"front-door",
		]);
	});

	it("lets an admin grant themselves a capability, audited like any other", async () => {
		const { dispatcher, store } = setup();
		const result = await run(dispatcher, "grant", { capability: "front-door" }, human(IDS.admin));
		expect(result.reply.embeds?.[0]?.title).toBe("Capability granted");
		expect(store.view.records.get(IDS.admin)?.capabilities).toEqual(["front-door"]);
		expect(store.view.discord.get(IDS.admin)).toBe("admin");
		expect(events("access.changed")[0]?.obj).toMatchObject({
			user: `discord:${IDS.admin}`,
			target: `discord:${IDS.admin}`,
		});
	});

	it("says so and writes nothing when they already have it", async () => {
		const { dispatcher, notified } = setup();
		const before = BEFORE();
		const result = await run(dispatcher, "grant", { capability: "workshop" }, human(IDS.friend));
		expect(result.reply.text).toContain("already has workshop. Nothing changed.");
		expect(read()).toBe(before);
		expect(existsSync(`${membersFile}.bak`)).toBe(false);
		expect(events("access.changed")).toHaveLength(0);
		expect(notified).toEqual([]);
	});

	it.each([
		["a guest who isn't listed", UNLISTED],
		["someone set to guest", DEMOTED],
	])("refuses %s, since it would do nothing", async (_label, id) => {
		const { dispatcher } = setup();
		const before = BEFORE();
		const result = await run(dispatcher, "grant", { capability: "workshop" }, human(id));
		expect(result.reply.text).toMatch(/is a guest, so a capability would do nothing/);
		expect(read()).toBe(before);
	});

	it("refuses a bot", async () => {
		const { dispatcher } = setup();
		const result = await run(
			dispatcher,
			"grant",
			{ capability: "workshop" },
			{
				...human(IDS.member),
				isBot: true,
			},
		);
		expect(result.reply.text).toMatch(/can't be a bot/);
	});

	it("refuses a capability that isn't in the registry", async () => {
		const { dispatcher } = setup();
		const result = await run(dispatcher, "grant", { capability: "front-dor" }, human(IDS.member));
		expect(result.reply.text).toMatch(/Invalid value for option "capability"/);
		expect(openStore().view.records.get(IDS.member)?.capabilities).toEqual([]);
	});

	it("refuses a reason that is too long", async () => {
		const { dispatcher } = setup();
		const result = await run(
			dispatcher,
			"grant",
			{ capability: "workshop", reason: "x".repeat(MAX_REASON_LENGTH + 1) },
			human(IDS.member),
		);
		expect(result.reply.text).toMatch(/at most 200 characters/);
	});

	it("reports a failed write clearly, and changes nothing", async () => {
		const { dispatcher, store } = setup(REGISTRY, {
			...nodeFileOps,
			rename: () => {
				throw new Error("disk full");
			},
		});
		const before = BEFORE();
		const result = await run(dispatcher, "grant", { capability: "workshop" }, human(IDS.member));
		expect(result.reply.text).toBe("Couldn't save the change, so nothing was changed.");
		expect(store.view.records.get(IDS.member)?.capabilities).toEqual([]);
		expect(read()).toBe(before);
	});

	it("says so, with no picker, when no capabilities are registered", async () => {
		const empty = new CapabilityRegistry();
		const { dispatcher, commands } = setup(empty);
		const grant = commands
			.get("admin")
			?.definition.subcommands?.flatMap((s) =>
				"subcommands" in s && s.subcommands ? s.subcommands : [],
			)
			.find((s) => s.name === "grant");
		const option = grant?.options?.find((o) => o.name === "capability");
		expect(option).toMatchObject({ type: "string" });
		expect(option).not.toHaveProperty("choices");

		for (const sub of ["grant", "revoke"] as const) {
			const result = await run(dispatcher, sub, { capability: "anything" }, human(IDS.member));
			expect(result.reply.text).toBe("No capabilities are registered yet.");
		}
		const list = await run(dispatcher, "list", {});
		expect(list.reply.text).toBe("No capabilities are registered yet.");
	});

	it("offers the registered names as choices", () => {
		const { commands } = setup();
		const grant = commands
			.get("admin")
			?.definition.subcommands?.flatMap((s) =>
				"subcommands" in s && s.subcommands ? s.subcommands : [],
			)
			.find((s) => s.name === "grant");
		expect(grant?.options?.find((o) => o.name === "capability")).toMatchObject({
			choices: ["front-door", "workshop"],
		});
	});
});

describe("revoke", () => {
	it("takes a capability away, persists it, and audits it", async () => {
		const { dispatcher, store, notified } = setup();
		const result = await run(
			dispatcher,
			"revoke",
			{ capability: "workshop", reason: "left" },
			human(IDS.friend),
		);
		expect(result.reply.embeds?.[0]?.title).toBe("Capability revoked");
		expect(store.view.records.get(IDS.friend)?.capabilities).toEqual([]);
		expect(openStore().view.records.get(IDS.friend)?.capabilities).toEqual([]);
		expect(events("access.changed")[0]?.obj).toMatchObject({
			kind: "set-capabilities",
			before: { tier: "friend", capabilities: ["workshop"] },
			after: { tier: "friend", capabilities: [] },
			reason: "left",
		});
		expect(notified).toEqual([{ userId: IDS.friend, before: ["workshop"], after: [] }]);
	});

	it("keeps their other capabilities", async () => {
		const { dispatcher } = setup();
		await run(dispatcher, "grant", { capability: "front-door" }, human(IDS.friend));
		await run(dispatcher, "revoke", { capability: "workshop" }, human(IDS.friend));
		expect(openStore().view.records.get(IDS.friend)?.capabilities).toEqual(["front-door"]);
	});

	it("also works for someone set to guest", async () => {
		const { dispatcher } = setup();
		await run(dispatcher, "revoke", { capability: "front-door" }, human(DEMOTED));
		expect(openStore().view.records.get(DEMOTED)?.capabilities).toEqual([]);
	});

	it.each([
		["someone who doesn't have it", IDS.member],
		["someone who isn't listed", UNLISTED],
	])("says so and writes nothing for %s", async (_label, id) => {
		const { dispatcher, notified } = setup();
		const before = BEFORE();
		const result = await run(dispatcher, "revoke", { capability: "workshop" }, human(id));
		expect(result.reply.text).toContain("doesn't have workshop. Nothing changed.");
		expect(read()).toBe(before);
		expect(notified).toEqual([]);
	});
});

describe("list", () => {
	it("lists every capability with how many people hold it, not counting guests", async () => {
		const { dispatcher } = setup();
		const result = await run(dispatcher, "list", {});
		expect(result.reply.embeds?.[0]?.title).toBe("Capabilities");
		expect(result.reply.embeds?.[0]?.description).toBe(
			"**front-door**: Open the front door (0 people)\n**workshop**: Use the workshop (1 person)",
		);
	});

	it("shows what one person has, with descriptions", async () => {
		const { dispatcher } = setup();
		const result = await run(dispatcher, "list", {}, human(IDS.friend, "Grace"));
		expect(result.reply.embeds?.[0]?.title).toBe("Grace");
		expect(fieldsOf(result)).toMatchObject({
			"Access level": "Friend of Pixelbar",
			Capabilities: "workshop: Use the workshop",
		});
		expect(events("admin.capabilities_lookup")[0]?.obj).toMatchObject({
			target: `discord:${IDS.friend}`,
		});
	});

	it("says none, and marks a guest's as inactive", async () => {
		const { dispatcher } = setup();
		expect(fieldsOf(await run(dispatcher, "list", {}, human(IDS.member))).Capabilities).toBe(
			"None",
		);
		expect(fieldsOf(await run(dispatcher, "list", {}, human(DEMOTED))).Capabilities).toBe(
			"front-door: Open the front door\n(inactive while a guest)",
		);
	});

	it("flags names that no longer exist", async () => {
		writeFileSync(
			membersFile,
			`members:\n  - ids: ["discord:${IDS.admin}"]\n    tier: member\n  - ids: ["discord:${IDS.member}"]\n    tier: member\n    capabilities:\n      - old-thing\n`,
		);
		const { dispatcher } = setup();
		const result = await run(dispatcher, "list", {}, human(IDS.member));
		expect(fieldsOf(result).Capabilities).toBe("old-thing (not registered, ignored)");
	});

	it("escapes the person's name", async () => {
		const { dispatcher } = setup();
		const result = await run(dispatcher, "list", {}, human(IDS.member, "**@everyone**"));
		expect(result.reply.embeds?.[0]?.title).toBe("\\*\\*@everyone\\*\\*");
	});
});
