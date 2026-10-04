import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformActor } from "../../core/access.ts";
import { CapabilityRegistry } from "../../core/capabilities.ts";
import type { ResolvedUser } from "../../core/command.ts";
import { Dispatcher, MESSAGES } from "../../core/dispatcher.ts";
import { IdentityService } from "../../core/identity.ts";
import type { Logger } from "../../core/logger.ts";
import { MAX_REASON_LENGTH } from "../../core/ports/access-store.ts";
import type { ErrorReporter } from "../../core/ports/error-reporter.ts";
import { RateLimiter } from "../../core/rate-limit.ts";
import { CommandRegistry } from "../../core/registry.ts";
import { ConfigTierSource } from "../../services/access-config.ts";
import { FileAccessStore, nodeFileOps } from "../../services/access-store.ts";
import { actor, context, IDS } from "../../testing/fixtures.ts";
import { createAdminFeature } from "./index.ts";
import { createMemberSubcommands } from "./members.ts";

const ADMINS = `admins:\n  - ids: ["discord:${IDS.admin}"]\n`;
const MEMBERS = `members:
  - ids: ["discord:${IDS.member}"]
    tier: member
    note: paid yearly
    capabilities:
      - front-door
  - ids: ["discord:${IDS.friend}"]
    tier: friend
  - ids: ["discord:${IDS.admin}"]
    tier: member
`;
const TARGET = "100000000000000050";
const CAPABILITIES = new CapabilityRegistry([
	{ name: "front-door", description: "Open the front door" },
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

function setup(ops = nodeFileOps) {
	const store = openStore(ops);
	const registry = new CommandRegistry();
	registry.register(
		createAdminFeature({
			version: "1",
			startedAt: new Date(),
			access: store,
			capabilities: CAPABILITIES,
			reporter,
		}),
	);
	const dispatcher = new Dispatcher({
		registry,
		identity: new IdentityService([new ConfigTierSource(store)]),
		rateLimiter: new RateLimiter({ capacity: 100, refillPerSecond: 0 }),
		logger: logger(),
		reporter,
	});
	return { store, dispatcher };
}

const human = (id: string, displayName = "Someone"): ResolvedUser => ({
	id,
	displayName,
	handle: "someone_h",
	isBot: false,
});

function run(
	dispatcher: Dispatcher,
	subcommand: string,
	args: Record<string, string>,
	target: ResolvedUser | undefined,
	as: Partial<PlatformActor> = { userId: IDS.admin, displayName: "Ada", handle: "ada_l" },
) {
	return dispatcher.dispatch({
		actor: actor(as),
		command: "admin",
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
	dir = mkdtempSync(join(tmpdir(), "pixel-members-"));
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

describe("who may run them", () => {
	it.each([
		["a member", IDS.member],
		["a friend", IDS.friend],
		["a guest", IDS.guest],
	])("refuses both commands to %s, and changes nothing", async (_label, userId) => {
		const { dispatcher } = setup();
		const set = await run(dispatcher, "set-level", { level: "member" }, human(TARGET), { userId });
		const whois = await run(dispatcher, "whois", {}, human(IDS.member), { userId });
		expect(set.reply.text).toBe(MESSAGES.deniedTier);
		expect(whois.reply.text).toBe(MESSAGES.deniedTier);
		expect(read()).toBe(MEMBERS);
		expect(events("admin.whois")).toHaveLength(0);
	});

	it("lets an admin run them", async () => {
		const { dispatcher } = setup();
		const result = await run(dispatcher, "whois", {}, human(IDS.member));
		expect(result.reply.embeds).toBeDefined();
		expect(result.private).toBe(true);
	});
});

describe("/admin set-level", () => {
	it("makes a guest a member, persists it, and logs who did what to whom", async () => {
		const { dispatcher, store } = setup();
		const result = await run(
			dispatcher,
			"set-level",
			{ level: "member", reason: "paid at the bar" },
			human(TARGET, "New Person"),
		);

		expect(result.private).toBe(true);
		expect(result.reply.embeds?.[0]?.title).toBe("Access level changed");
		expect(fieldsOf(result)).toMatchObject({
			Person: `New Person (${TARGET})`,
			Before: "Guest",
			Now: "Pixelbar member",
		});
		expect(store.view.discord.get(TARGET)).toBe("member");
		expect(openStore().view.discord.get(TARGET)).toBe("member");

		const [audit] = events("access.changed");
		expect(audit?.obj).toMatchObject({
			user: `discord:${IDS.admin}`,
			userName: "Ada",
			userHandle: "ada_l",
			target: `discord:${TARGET}`,
			before: null,
			after: { tier: "member", capabilities: [] },
			reason: "paid at the bar",
		});
	});

	it("upgrades a friend to a member", async () => {
		const { dispatcher } = setup();
		const result = await run(dispatcher, "set-level", { level: "member" }, human(IDS.friend));
		expect(fieldsOf(result)).toMatchObject({
			Before: "Friend of Pixelbar",
			Now: "Pixelbar member",
		});
		expect(openStore().view.discord.get(IDS.friend)).toBe("member");
	});

	it("downgrades a member to guest, keeping their entry and capabilities, and says so", async () => {
		const { dispatcher, store } = setup();
		const result = await run(dispatcher, "set-level", { level: "guest" }, human(IDS.member));
		expect(fieldsOf(result)).toMatchObject({
			Before: "Pixelbar member",
			Now: "Guest",
			Capabilities: "Kept, but inactive while they're a guest.",
		});
		expect(store.view.discord.has(IDS.member)).toBe(false);
		expect(store.view.records.get(IDS.member)?.capabilities).toEqual(["front-door"]);
		expect(openStore().view.records.get(IDS.member)?.tier).toBe("guest");
		expect(read()).toContain("front-door");
	});

	it("doesn't mention capabilities when there are none to keep", async () => {
		const { dispatcher } = setup();
		const result = await run(dispatcher, "set-level", { level: "guest" }, human(IDS.friend));
		expect(fieldsOf(result)).not.toHaveProperty("Capabilities");
	});

	it("a demoted person is refused by tier-gated commands straight away", async () => {
		const { dispatcher } = setup();
		await run(dispatcher, "set-level", { level: "guest" }, human(IDS.member));
		const result = await run(dispatcher, "whois", {}, human(IDS.friend), { userId: IDS.member });
		expect(result.reply.text).toBe(MESSAGES.deniedTier);
	});

	it.each([
		["a member who is already a member", IDS.member, "member", "already set to Pixelbar member"],
		["a friend who is already a friend", IDS.friend, "friend", "already set to Friend of Pixelbar"],
		["an unlisted person set to guest", TARGET, "guest", "already set to Guest"],
	])("says so and writes nothing for %s", async (_label, id, level, message) => {
		const { dispatcher } = setup();
		const result = await run(dispatcher, "set-level", { level }, human(id));
		expect(result.reply.text).toContain(message);
		expect(result.reply.text).toContain("Nothing changed");
		expect(read()).toBe(MEMBERS);
		expect(existsSync(`${membersFile}.bak`)).toBe(false);
		expect(events("access.changed")).toHaveLength(0);
	});

	it("treats a guest entry set to guest as a no-op too", async () => {
		const { dispatcher } = setup();
		await run(dispatcher, "set-level", { level: "guest" }, human(IDS.friend));
		const again = await run(dispatcher, "set-level", { level: "guest" }, human(IDS.friend));
		expect(again.reply.text).toContain("Nothing changed");
	});

	it("refuses to change an admin, with a clear private message", async () => {
		const { dispatcher } = setup();
		const result = await run(dispatcher, "set-level", { level: "guest" }, human(IDS.admin, "Ada"));
		expect(result.reply.text).toContain("is a Pixel admin");
		expect(result.reply.text).toContain("admins.yaml");
		expect(result.private).toBe(true);
		expect(read()).toBe(MEMBERS);
	});

	it("refuses a bot", async () => {
		const { dispatcher } = setup();
		const result = await run(
			dispatcher,
			"set-level",
			{ level: "member" },
			{
				...human(TARGET),
				isBot: true,
			},
		);
		expect(result.reply.text).toMatch(/can't be a bot/);
		expect(read()).toBe(MEMBERS);
	});

	it("refuses a person Discord didn't resolve", async () => {
		const { dispatcher } = setup();
		const result = await run(dispatcher, "set-level", { level: "member" }, undefined);
		expect(result.reply.text).toMatch(/Missing required option "user"/);
		const unresolved = await dispatcher.dispatch({
			actor: actor({ userId: IDS.admin }),
			command: "admin",
			subcommand: "set-level",
			args: { user: TARGET, level: "member" },
		});
		expect(unresolved.reply.text).toMatch(/Invalid value for option "user"/);
		expect(read()).toBe(MEMBERS);
	});

	it("refuses a level that isn't offered", async () => {
		const { dispatcher } = setup();
		const result = await run(dispatcher, "set-level", { level: "admin" }, human(TARGET));
		expect(result.reply.text).toMatch(/Invalid value for option "level"/);
		expect(read()).toBe(MEMBERS);
	});

	it("refuses a reason that is too long", async () => {
		const { dispatcher } = setup();
		const result = await run(
			dispatcher,
			"set-level",
			{ level: "member", reason: "x".repeat(MAX_REASON_LENGTH + 1) },
			human(TARGET),
		);
		expect(result.reply.text).toMatch(/at most 200 characters/);
		expect(read()).toBe(MEMBERS);
	});

	it("ignores a blank reason", async () => {
		const { dispatcher } = setup();
		await run(dispatcher, "set-level", { level: "member", reason: "   " }, human(TARGET));
		expect(events("access.changed")[0]?.obj).not.toHaveProperty("reason");
	});

	it("reports a failed write clearly, and changes nothing", async () => {
		const { dispatcher, store } = setup({
			...nodeFileOps,
			rename: () => {
				throw new Error("disk full");
			},
		});
		const result = await run(dispatcher, "set-level", { level: "member" }, human(TARGET));
		expect(result.reply.text).toBe("Couldn't save the change, so nothing was changed.");
		expect(result.private).toBe(true);
		expect(store.view.discord.has(TARGET)).toBe(false);
		expect(read()).toBe(MEMBERS);
		expect(reporter.capture).not.toHaveBeenCalled();
	});

	it("escapes the person's name so it can't render as formatting or a mention", async () => {
		const { dispatcher } = setup();
		const result = await run(
			dispatcher,
			"set-level",
			{ level: "member" },
			human(TARGET, "**@everyone** [x](https://evil.example)"),
		);
		expect(fieldsOf(result).Person).toBe(
			`\\*\\*@everyone\\*\\* \\[x\\](https://evil.example) (${TARGET})`,
		);
	});
});

describe("/admin whois", () => {
	it("shows level, source, capabilities and the note for a member", async () => {
		const { dispatcher } = setup();
		const result = await run(dispatcher, "whois", {}, human(IDS.member, "Grace"));
		expect(result.reply.embeds?.[0]?.title).toBe("Grace");
		expect(fieldsOf(result)).toMatchObject({
			"Discord ID": IDS.member,
			Handle: "`someone_h`",
			"Access level": "Pixelbar member",
			"Comes from": "config/members.yaml",
			Capabilities: "front-door",
			Note: "`paid yearly`",
		});
	});

	it("says an admin comes from the admins file", async () => {
		const { dispatcher } = setup();
		const result = await run(dispatcher, "whois", {}, human(IDS.admin));
		expect(fieldsOf(result)).toMatchObject({
			"Access level": "Pixel admin",
			"Comes from": "config/admins.yaml",
			"Also listed as": "Pixelbar member",
			Capabilities: "None",
		});
		expect(fieldsOf(result)).not.toHaveProperty("Note");
	});

	it("says an unlisted person is a guest who isn't stored", async () => {
		const { dispatcher } = setup();
		const result = await run(dispatcher, "whois", {}, human(TARGET));
		expect(fieldsOf(result)).toMatchObject({
			"Access level": "Guest",
			"Comes from": "Not listed",
			Capabilities: "None",
		});
	});

	it("marks capabilities as inactive for someone set to guest", async () => {
		const { dispatcher } = setup();
		await run(dispatcher, "set-level", { level: "guest" }, human(IDS.member));
		const result = await run(dispatcher, "whois", {}, human(IDS.member));
		expect(fieldsOf(result)).toMatchObject({
			"Access level": "Guest",
			"Comes from": "config/members.yaml (set to guest)",
			Capabilities: "front-door (inactive while a guest)",
		});
	});

	it("flags capability names that no longer exist, which are ignored", async () => {
		writeFileSync(
			membersFile,
			`members:\n  - ids: ["discord:${IDS.admin}"]\n    tier: member\n  - ids: ["discord:${IDS.member}"]\n    tier: member\n    capabilities:\n      - front-door\n      - old-thing\n`,
		);
		const { dispatcher } = setup();
		const result = await run(dispatcher, "whois", {}, human(IDS.member));
		expect(fieldsOf(result).Capabilities).toBe("front-door, old-thing (not registered, ignored)");
	});

	it("shows a bot as a bot", async () => {
		const { dispatcher } = setup();
		const result = await run(dispatcher, "whois", {}, { ...human(TARGET), isBot: true });
		expect(fieldsOf(result)["Access level"]).toBe("A bot. Bots have no level.");
	});

	it("omits the handle when there isn't one", async () => {
		const { dispatcher } = setup();
		const { handle: _handle, ...noHandle } = human(IDS.member);
		const result = await run(dispatcher, "whois", {}, noHandle);
		expect(fieldsOf(result)).not.toHaveProperty("Handle");
	});

	it("records who looked up whom", async () => {
		const { dispatcher } = setup();
		await run(dispatcher, "whois", {}, human(IDS.member));
		expect(events("admin.whois")[0]?.obj).toMatchObject({
			target: `discord:${IDS.member}`,
		});
	});

	describe("a hostile note or name", () => {
		const HOSTILE =
			"# HUGE\n@everyone <@123> [click me](https://evil.example) **bold** ```code``` <:wave:1> <t:1:R>\n- list";

		it("is shown as an inert code span", async () => {
			writeFileSync(
				membersFile,
				`members:\n  - ids: ["discord:${IDS.admin}"]\n    tier: member\n  - ids: ["discord:${IDS.member}"]\n    tier: member\n    note: ${JSON.stringify(HOSTILE)}\n`,
			);
			const { dispatcher } = setup();
			const result = await run(dispatcher, "whois", {}, human(IDS.member));
			const note = fieldsOf(result).Note ?? "";
			expect(note.startsWith("`")).toBe(true);
			expect(note.endsWith("`")).toBe(true);
			expect(note.slice(1, -1)).not.toContain("`");
			expect(note).not.toContain("\n");
		});

		it("escapes the name in the title and the handle in its span", async () => {
			const { dispatcher } = setup();
			const result = await run(
				dispatcher,
				"whois",
				{},
				{
					...human(IDS.member, "# **@everyone**"),
					handle: "`x`",
				},
			);
			expect(result.reply.embeds?.[0]?.title).toBe("# \\*\\*@everyone\\*\\*");
			expect(fieldsOf(result).Handle).toBe("`'x'`");
		});
	});
});

describe("handler guard", () => {
	it("fails loudly if a required user wasn't resolved (the dispatcher prevents this)", async () => {
		const sub = createMemberSubcommands(openStore(), new CapabilityRegistry()).find(
			(s) => s.name === "whois",
		);
		await expect(sub?.handler(context())).rejects.toThrow(/missing resolved user/);
	});
});
