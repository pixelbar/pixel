import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnnouncementRoutes } from "../../core/announcement-routes.ts";
import { CapabilityRegistry } from "../../core/capabilities.ts";
import type { ResolvedChannel, ResolvedUser } from "../../core/command.ts";
import { type ActionOutcome, Dispatcher, MESSAGES } from "../../core/dispatcher.ts";
import { Home } from "../../core/home.ts";
import { IdentityService } from "../../core/identity.ts";
import { silentLogger } from "../../core/logger.ts";
import type { DoorSystem } from "../../core/ports/door-system.ts";
import { nullErrorReporter } from "../../core/ports/error-reporter.ts";
import { RateLimiter } from "../../core/rate-limit.ts";
import { CommandRegistry } from "../../core/registry.ts";
import type { Reply } from "../../core/reply.ts";
import { RoleMirror } from "../../core/role-mirror.ts";
import { type Control, type Form, UI_LIMITS } from "../../core/ui.ts";
import { ConfigTierSource } from "../../services/access-config.ts";
import { FileAccessStore } from "../../services/access-store.ts";
import { HomeDeviceStore } from "../../services/home-devices.ts";
import { KindSwitch } from "../../services/kind-switch.ts";
import { actor, IDS } from "../../testing/fixtures.ts";
import { inMemoryParking } from "../../testing/parking.ts";
import { createAdminFeature } from "./index.ts";
import { ADMIN_ACTIONS } from "./panel.ts";

const NOW = new Date("2030-01-01T10:00:00Z");
const ADMINS = `admins:\n  - ids: ["discord:${IDS.admin}"]\n`;
const MEMBERS = `members:
  - ids: ["discord:${IDS.member}"]
    tier: member
    capabilities:
      - front-door
  - ids: ["discord:${IDS.friend}"]
    tier: friend
  - ids: ["discord:${IDS.admin}"]
    tier: member
`;
const CAPABILITIES = new CapabilityRegistry([
	{ name: "front-door", description: "Open the front door" },
	{ name: "workshop", description: "Use the workshop" },
]);
const CHANNEL = "100000000000000050";
const GRACE: ResolvedUser = { id: IDS.member, displayName: "Grace", handle: "grace", isBot: false };

let dir: string;
let membersFile: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pixel-admin-panel-"));
	membersFile = join(dir, "members.yaml");
	writeFileSync(join(dir, "admins.yaml"), ADMINS);
	writeFileSync(membersFile, MEMBERS);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fakeOpenr() {
	return {
		status: vi.fn<DoorSystem["status"]>(() => ({ state: "logged-out" })),
		startLogin: vi.fn<DoorSystem["startLogin"]>(async () => ({
			step: "code-sent",
			codeUntil: new Date(NOW.getTime() + 600_000),
		})),
		completeLogin: vi.fn<DoorSystem["completeLogin"]>(async () => ({
			step: "logged-in",
			sessionUntil: new Date(NOW.getTime() + 86_400_000),
		})),
		logout: vi.fn<DoorSystem["logout"]>(async () => {}),
		open: vi.fn<DoorSystem["open"]>(async () => ({ opened: true })),
		doorStatus: vi.fn<DoorSystem["doorStatus"]>(async () => ({
			kind: "ok",
			online: true,
			errors: [],
		})),
	};
}

function setup(options: { openr?: ReturnType<typeof fakeOpenr> } = {}) {
	const store = FileAccessStore.open({
		paths: { adminsFile: join(dir, "admins.yaml"), membersFile },
		logger: silentLogger,
		reporter: nullErrorReporter,
	});
	const switches = new KindSwitch({ logger: silentLogger, switchable: ["door"] });
	const routes = new AnnouncementRoutes();
	const closingTimeFile = join(dir, "closing-time.md");
	const registry = new CommandRegistry({ capabilities: CAPABILITIES });
	registry.register(
		createAdminFeature({
			version: "1",
			startedAt: NOW,
			access: store,
			capabilities: CAPABILITIES,
			roles: new RoleMirror({ logger: silentLogger, reporter: nullErrorReporter }),
			home: new Home({ logger: silentLogger, reporter: nullErrorReporter }),
			homeDevices: HomeDeviceStore.empty(),
			announcementRoutes: routes,
			switches,
			reporter: nullErrorReporter,
			closingTimeFile,
			parking: inMemoryParking(),
			openr: { system: options.openr, doors: [], gateDoor: undefined },
			now: () => NOW,
		}),
	);
	const dispatcher = new Dispatcher({
		registry,
		identity: new IdentityService([new ConfigTierSource(store)]),
		rateLimiter: new RateLimiter({ capacity: 1000, refillPerSecond: 0, now: () => 0 }),
		logger: silentLogger,
		reporter: nullErrorReporter,
	});
	const open = async (userId: string = IDS.admin) => {
		const { reply } = await dispatcher.dispatch({
			actor: actor({ userId }),
			command: "admin",
			args: {},
		});
		fits(reply);
		return reply;
	};
	const act = async (
		action: string,
		args: Record<string, string | boolean> = {},
		extra: {
			users?: Record<string, ResolvedUser>;
			channels?: Record<string, ResolvedChannel>;
			userId?: string;
		} = {},
	) => {
		const outcome = await dispatcher.act({
			actor: actor({ userId: extra.userId ?? IDS.admin }),
			action,
			args,
			...(extra.users ? { users: extra.users } : {}),
			...(extra.channels ? { channels: extra.channels } : {}),
		});
		if (outcome.kind === "update") fits(outcome.reply);
		return outcome;
	};
	const click = (reply: Reply, label: string, values: string[] = []) => {
		const control = controlsOf(reply).find((c) =>
			c.kind === "select" ? c.placeholder === label : c.label === label,
		);
		if (!control || control.kind === "link") throw new Error(`no control "${label}"`);
		const args = { ...control.call.args } as Record<string, string | boolean>;
		if (control.kind === "select") args[control.arg] = values.join(", ");
		return act(control.call.action, args);
	};
	const submit = (
		form: Form,
		fields: Record<string, string>,
		extra: Parameters<typeof act>[2] = {},
	) =>
		act(form.submit.action, { ...(form.submit.args as Record<string, string>), ...fields }, extra);
	/** Looks someone up, as the People form does. */
	const person = (user: ResolvedUser) =>
		act(ADMIN_ACTIONS.person, { user: user.id }, { users: { user } });
	return { store, switches, routes, closingTimeFile, registry, open, act, click, submit, person };
}

function fits(reply: Reply) {
	const rows = reply.controls ?? [];
	expect(rows.length).toBeLessThanOrEqual(UI_LIMITS.rows);
	for (const row of rows) {
		expect(row.length).toBeLessThanOrEqual(UI_LIMITS.buttonsPerRow);
		if (row.some((c) => c.kind === "select")) expect(row).toHaveLength(1);
	}
}
const controlsOf = (reply: Reply): Control[] => (reply.controls ?? []).flat();
const labels = (reply: Reply) =>
	controlsOf(reply).map((c) => (c.kind === "select" ? `[${c.placeholder}]` : c.label));
const replyOf = (outcome: ActionOutcome): Reply => {
	if (outcome.kind !== "update")
		throw new Error(`expected an update, got ${JSON.stringify(outcome)}`);
	return outcome.reply;
};
const formOf = (outcome: ActionOutcome): Form => {
	if (outcome.kind !== "form") throw new Error(`expected a form, got ${JSON.stringify(outcome)}`);
	return outcome.form;
};
const said = (reply: Reply) =>
	[
		reply.text,
		...(reply.embeds ?? []).flatMap((e) => [
			e.title,
			e.description,
			...(e.fields ?? []).map((f) => `${f.name}: ${f.value}`),
		]),
	]
		.filter(Boolean)
		.join("\n");
const section = (t: ReturnType<typeof setup>, name: string) =>
	t.act(ADMIN_ACTIONS.section, { section: name }).then(replyOf);

describe("/admin", () => {
	it("is one admin-only command that opens Pixel's status, with a menu of sections", async () => {
		const t = setup();
		expect((await t.open(IDS.member)).text).toBe(MESSAGES.deniedTier);
		const home = await t.open();
		expect(home.embeds?.[0]?.title).toBe("Pixel status");
		expect(labels(home)).toEqual(["[Go to…]", "Reload the access lists", "Refresh"]);
		const menu = controlsOf(home)[0];
		expect(menu?.kind === "select" && menu.options.map((o) => o.value)).toEqual([
			"people",
			"capabilities",
			"roles",
			"announcements",
			"closing-time",
			"doors",
			"parking",
		]);
		const withOpenr = await setup({ openr: fakeOpenr() }).open();
		const full = controlsOf(withOpenr)[0];
		expect(full?.kind === "select" && full.options.map((o) => o.value)).toContain("openr");
	});

	it("has only admin-only actions, every one of them reachable by name", async () => {
		const t = setup();
		for (const name of Object.values(ADMIN_ACTIONS)) {
			expect(t.registry.action(name)?.definition.access).toEqual({ minTier: "admin" });
		}
		expect(await t.act(ADMIN_ACTIONS.home, {}, { userId: IDS.member })).toEqual({
			kind: "refused",
			reply: { text: MESSAGES.deniedTier, private: true },
		});
	});

	it("reloads the access lists, saying before and after above the status", async () => {
		const t = setup();
		const reply = replyOf(await t.click(await t.open(), "Reload the access lists"));
		expect(reply.text).toContain("Reloaded the access lists.");
		expect(reply.embeds?.[0]?.title).toBe("Pixel status");
	});

	it("opens the parking panel from the menu, with a way back", async () => {
		const t = setup();
		const parking = replyOf(await t.click(await t.open(), "Go to…", ["parking"]));
		expect(parking.embeds?.[0]?.title).toBe("🅿️ Parking spots");
		expect(labels(parking)).toContain("← Admin");
	});
});

describe("people", () => {
	it("looks someone up on a form with a person picker", async () => {
		const t = setup();
		const people = await section(t, "people");
		expect(labels(people)).toEqual(["Look someone up…", "← Admin"]);
		const form = formOf(await t.click(people, "Look someone up…"));
		expect(form.fields).toEqual([expect.objectContaining({ kind: "user", name: "user" })]);
		const panel = replyOf(await t.submit(form, { user: GRACE.id }, { users: { user: GRACE } }));
		expect(panel.embeds?.[0]?.title).toBe("Grace");
		expect(labels(panel)).toEqual([
			"Change level…",
			"Grant every capability…",
			"Sync their Discord roles",
			"Capabilities in detail",
			"[Grant capabilities…]",
			"[Revoke capabilities…]",
			"← People",
			"Refresh",
		]);
	});

	it("offers an admin no level change, and a bot nothing at all", async () => {
		const t = setup();
		const admin = replyOf(await t.person({ id: IDS.admin, displayName: "Ada", isBot: false }));
		expect(labels(admin)).not.toContain("Change level…");
		const bot = replyOf(
			await t.person({ id: "100000000000000099", displayName: "Bot", isBot: true }),
		);
		expect(labels(bot)).toEqual(["← People"]);
	});

	it("offers a guest no way to grant capabilities, since they'd do nothing", async () => {
		const t = setup();
		const guest = replyOf(
			await t.person({ id: "100000000000000098", displayName: "Gus", isBot: false }),
		);
		expect(labels(guest)).toEqual([
			"Change level…",
			"Sync their Discord roles",
			"Capabilities in detail",
			"← People",
			"Refresh",
		]);
	});

	it("changes a level on a form filled in with the current one, with a reason", async () => {
		const t = setup();
		const panel = replyOf(await t.person(GRACE));
		const form = formOf(await t.click(panel, "Change level…"));
		const level = form.fields[0];
		expect(level?.kind === "radio" && level.options.find((o) => o.selected)?.value).toBe("member");
		const done = replyOf(await t.submit(form, { level: "friend", reason: "moved away" }));
		expect(done.embeds?.[0]?.title).toBe("Access level changed");
		expect(done.embeds?.[1]?.title).toBe("Grace");
		expect(t.store.view.discord.get(IDS.member)).toBe("friend");
		expect(readFileSync(membersFile, "utf8")).toContain("tier: friend");
	});

	it("grants and revokes the capabilities picked, after asking for a reason", async () => {
		const t = setup();
		const panel = replyOf(await t.person(GRACE));
		const grant = formOf(await t.click(panel, "Grant capabilities…", ["workshop"]));
		expect(grant.title).toBe("Grant workshop");
		expect(grant.fields).toEqual([expect.objectContaining({ name: "reason", required: false })]);
		const granted = replyOf(await t.submit(grant, { reason: "tool induction" }));
		expect(granted.embeds?.[0]?.title).toBe("Capability granted");
		expect(t.store.view.records.get(IDS.member)?.capabilities).toEqual(["front-door", "workshop"]);
		const revoke = formOf(
			await t.click(granted, "Revoke capabilities…", ["front-door", "workshop"]),
		);
		const revoked = replyOf(await t.submit(revoke, {}));
		expect(revoked.embeds?.filter((e) => e.title === "Capability revoked")).toHaveLength(2);
		expect(t.store.view.records.get(IDS.member)?.capabilities).toEqual([]);
	});

	it("grants everything, syncs roles and shows where each capability comes from", async () => {
		const t = setup();
		const panel = replyOf(await t.person(GRACE));
		const everything = formOf(await t.click(panel, "Grant every capability…"));
		await t.submit(everything, {});
		expect(t.store.view.records.get(IDS.member)?.capabilities).toEqual(["front-door", "workshop"]);
		expect(said(replyOf(await t.click(panel, "Sync their Discord roles")))).toContain(
			"Role mirroring isn't configured",
		);
		const detail = replyOf(await t.click(panel, "Capabilities in detail"));
		expect(detail.embeds?.[0]?.fields?.find((f) => f.name === "Capabilities")?.value).toContain(
			"front-door",
		);
		expect(replyOf(await t.click(panel, "Refresh")).embeds?.[0]?.title).toBe("Grace");
	});

	it("shows a refusal privately and leaves the panel alone", async () => {
		const t = setup();
		const outcome = await t.act(ADMIN_ACTIONS.grant, {
			"user-id": "100000000000000077",
			"user-name": "Nobody",
			capability: "workshop",
		});
		expect(outcome).toMatchObject({
			kind: "refused",
			reply: { text: expect.stringContaining("is a guest") },
		});
	});
});

describe("capabilities and levels", () => {
	it("lists every capability, and grants and revokes one for a whole level", async () => {
		const t = setup();
		const caps = await section(t, "capabilities");
		expect(said(caps)).toContain("front-door");
		expect(labels(caps)).toEqual(["What friends get", "What members get", "← Admin"]);
		const friends = replyOf(await t.click(caps, "What friends get"));
		expect(said(friends)).toContain("No capabilities are granted to the friend level.");
		const form = formOf(await t.click(friends, "Grant to every friend and member…", ["workshop"]));
		const granted = replyOf(await t.submit(form, { reason: "open day" }));
		expect(granted.embeds?.[0]?.title).toBe("Capability granted to a level");
		expect(t.store.view.tierCapabilities.friend).toEqual(["workshop"]);
		const members = replyOf(await t.act(ADMIN_ACTIONS.levelCapabilities, { level: "member" }));
		expect(said(members)).toContain("Members also get what friends get: **workshop**.");
		const revoke = formOf(
			await t.click(granted, "Revoke from every friend and member…", ["workshop"]),
		);
		await t.submit(revoke, {});
		expect(t.store.view.tierCapabilities.friend).toEqual([]);
	});
});

describe("roles", () => {
	it("syncs everyone, saying when nothing is mapped", async () => {
		const t = setup();
		const roles = await section(t, "roles");
		expect(labels(roles)).toEqual(["Sync everyone", "← Admin"]);
		expect(said(replyOf(await t.click(roles, "Sync everyone")))).toContain(
			"Role mirroring isn't configured",
		);
	});
});

describe("announcements", () => {
	const general: ResolvedChannel = {
		id: CHANNEL,
		name: "general",
		caller: { canPost: true, canMentionEveryone: false, canCreatePolls: false },
	};

	it("adds a channel on a form, and stops announcing there from a menu", async () => {
		const t = setup();
		t.routes.use({
			list: () => [],
			set: async () => ({ result: "added", saved: true }),
			remove: async () => ({ removed: true, previous: "live", saved: true }),
		} as never);
		const announcements = await section(t, "announcements");
		const form = formOf(await t.click(announcements, "Add a channel…"));
		expect(form.fields.map((f) => [f.kind, f.name])).toEqual([
			["channel", "channel"],
			["radio", "style"],
		]);
		const added = replyOf(
			await t.submit(form, { channel: CHANNEL, style: "live" }, { channels: { channel: general } }),
		);
		expect(added.text).toContain("Open/closed announcements will go to");
		expect(await t.act(ADMIN_ACTIONS.announceRemove, { "channel-id": CHANNEL })).toMatchObject({
			kind: "refused",
		});
		t.routes.use({
			list: () => [{ style: "live", channelId: CHANNEL }],
			set: async () => ({ result: "added", saved: true }),
			remove: async () => ({ removed: true, previous: "live", saved: true }),
		} as never);
		const listed = await section(t, "announcements");
		const removed = replyOf(await t.click(listed, "Stop announcing in…", [CHANNEL]));
		expect(removed.text).toContain("Stopped announcing in");
	});
});

describe("closing time, doors and OpenR", () => {
	it("changes the closing-time message on a form filled in with the saved one", async () => {
		const t = setup();
		const closing = await section(t, "closing-time");
		expect(said(closing)).toContain("No message is set");
		const form = formOf(await t.click(closing, "Change the message…"));
		const saved = replyOf(await t.submit(form, { message: "Last out locks up." }));
		expect(saved.text).toBe("Saved the closing-time message.");
		expect(said(saved)).toContain("Last out locks up.");
		expect(formOf(await t.click(saved, "Change the message…")).fields[0]).toMatchObject({
			value: "Last out locks up.",
		});
	});

	it("asks before switching door control off, and switches it back on", async () => {
		const t = setup();
		const doors = await section(t, "doors");
		const ask = replyOf(await t.click(doors, "Switch door control off…"));
		expect(labels(ask)).toEqual(["Switch it off", "Cancel"]);
		expect(t.switches.isOn("door")).toBe(true);
		const off = replyOf(await t.click(ask, "Switch it off"));
		expect(off.text).toContain("Door control from Pixel is now **off**.");
		expect(t.switches.isOn("door")).toBe(false);
		const on = replyOf(await t.click(off, "Switch door control on"));
		expect(on.text).toContain("now **on**");
		expect(t.switches.isOn("door")).toBe(true);
	});

	it("logs Pixel in to OpenR, takes the code on a form, and asks before logging out", async () => {
		const openr = fakeOpenr();
		const t = setup({ openr });
		const panel = await section(t, "openr");
		expect(labels(panel)).toEqual(["Log in", "Enter the code…", "Log out…", "← Admin", "Refresh"]);
		expect(replyOf(await t.click(panel, "Log in")).text).toContain("OpenR has emailed a code");
		const form = formOf(await t.click(panel, "Enter the code…"));
		expect(replyOf(await t.submit(form, { code: "123456" })).text).toContain("logged in");
		expect(openr.completeLogin).toHaveBeenCalledWith("123456");
		const ask = replyOf(await t.click(panel, "Log out…"));
		expect(labels(ask)).toEqual(["Log out", "Cancel"]);
		await t.click(ask, "Log out");
		expect(openr.logout).toHaveBeenCalledOnce();
	});

	it("shows OpenR as not set up, with nothing to press", async () => {
		const t = setup();
		const panel = await section(t, "openr");
		expect(said(panel)).toContain("OpenR isn't configured here");
		expect(labels(panel)).toEqual(["← Admin", "Refresh"]);
	});
});
