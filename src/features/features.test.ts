import { describe, expect, it, vi } from "vitest";
import { Announcer } from "../core/announcer.ts";
import { Calendar } from "../core/calendar.ts";
import { CapabilityRegistry } from "../core/capabilities.ts";
import { isSubgroup, type SubcommandDefinition } from "../core/command.ts";
import { UserFacingError } from "../core/errors.ts";
import type { Feature } from "../core/feature.ts";
import { formatDuration } from "../core/format.ts";
import { Home } from "../core/home.ts";
import { silentLogger } from "../core/logger.ts";
import type { AccessStore } from "../core/ports/access-store.ts";
import { nullErrorReporter } from "../core/ports/error-reporter.ts";
import { nullFeedbackSink } from "../core/ports/feedback.ts";
import { CommandRegistry } from "../core/registry.ts";
import { RoleMirror } from "../core/role-mirror.ts";
import { HomeDeviceStore } from "../services/home-devices.ts";
import { HomeInventory } from "../services/home-inventory.ts";
import { KindSwitch } from "../services/kind-switch.ts";
import type { SpaceStatus } from "../services/space-status.ts";
import { context, IDS, plain, principal } from "../testing/fixtures.ts";
import { createAdminFeature } from "./admin/index.ts";
import { createHelpFeature } from "./help/index.ts";
import { buildFeatures } from "./index.ts";
import { createPingFeature } from "./ping/index.ts";
import { createWhoamiFeature } from "./whoami/index.ts";

const counts = { admins: 2, members: 10, friends: 3 };
const access: AccessStore = {
	view: { discord: new Map(), records: new Map(), counts, warnings: [] },
	apply: async () => {
		throw new Error("unused");
	},
	reload: async () => ({ before: counts, after: counts }),
};

const spaceStatus: SpaceStatus = {
	pollIntervalMs: 30_000,
	checkNow: async () => ({ state: "open", since: null, checkedAt: new Date() }),
	start() {},
	stop() {},
	onChange: () => () => {},
};

const deps = () => ({
	version: "1.0.0",
	startedAt: new Date(),
	access,
	capabilities: new CapabilityRegistry(),
	roles: new RoleMirror({ logger: silentLogger, reporter: nullErrorReporter }),
	home: new Home({ logger: silentLogger, reporter: nullErrorReporter }),
	homeDevices: HomeDeviceStore.empty(),
	homeInventory: HomeInventory.off(),
	switches: new KindSwitch({ logger: silentLogger, switchable: ["door"] }),
	feedback: nullFeedbackSink,
	reporter: nullErrorReporter,
	spaceStatus,
	announcer: new Announcer({ logger: silentLogger, reporter: nullErrorReporter }),
	calendar: new Calendar({ logger: silentLogger, reporter: nullErrorReporter }),
	infoTopics: [
		{ id: "membership", title: "Becoming a member", summary: "How to join", body: "Email us." },
	],
	timezone: "Europe/Amsterdam",
	logger: silentLogger,
});

function onlyCommand(feature: Feature) {
	return plain(feature.commands?.[0]);
}

describe("buildFeatures", () => {
	it("registers cleanly (every command declares access)", () => {
		const registry = new CommandRegistry();
		for (const f of buildFeatures(deps())) registry.register(f);
		expect(
			registry
				.all()
				.map((c) => c.definition.name)
				.sort(),
		).toEqual(["admin", "events", "feedback", "ha", "help", "info", "ping", "status", "whoami"]);
	});

	it("restricts /admin to admins and opens /status, /events and /info to guests", () => {
		const registry = new CommandRegistry();
		for (const f of buildFeatures(deps())) registry.register(f);
		const admin = registry.get("admin")?.definition;
		expect(admin?.access.minTier).toBe("admin");
		expect(admin?.subcommands?.map((s) => [s.name, s.access.minTier])).toEqual([
			["status", "admin"],
			["reload", "admin"],
			["level", "admin"],
			["sync", "admin"],
			["capabilities", "admin"],
			["doors", "admin"],
		]);
		expect(registry.get("status")?.definition.access.minTier).toBe("guest");
		expect(registry.get("events")?.definition.access.minTier).toBe("guest");
		expect(registry.get("info")?.definition.access.minTier).toBe("guest");
	});
});

describe("ping", () => {
	it("replies with the version", async () => {
		const reply = await onlyCommand(createPingFeature({ version: "1.2.3" })).handler(context());
		expect(reply.text).toContain("1.2.3");
	});
});

describe("whoami", () => {
	it("privately shows the caller's tier and ID", async () => {
		const cmd = onlyCommand(createWhoamiFeature());
		expect(cmd.private).toBe(true);
		const reply = await cmd.handler(
			context({ principal: principal("friend", { userId: IDS.friend }) }),
		);
		const values = reply.embeds?.[0]?.fields?.map((f) => f.value);
		expect(values).toEqual(["Friend of Pixelbar", IDS.friend]);
	});
});

describe("help", () => {
	it("lists available commands alphabetically", async () => {
		const reply = await onlyCommand(createHelpFeature()).handler(
			context({
				availableCommands: [
					{ name: "whoami", description: "Who" },
					{ name: "help", description: "Help" },
				],
			}),
		);
		expect(reply.embeds?.[0]?.description).toBe("**/help** — Help\n**/whoami** — Who");
	});
});

function adminSubcommand(
	name: string,
	store: Pick<AccessStore, "view" | "apply" | "reload"> = access,
) {
	const admin = createAdminFeature({
		version: "1.0.0",
		startedAt: new Date(0),
		access: store,
		capabilities: new CapabilityRegistry(),
		roles: new RoleMirror({ logger: silentLogger, reporter: nullErrorReporter }),
		home: new Home({ logger: silentLogger, reporter: nullErrorReporter }),
		homeDevices: HomeDeviceStore.empty(),
		homeInventory: HomeInventory.off(),
		switches: new KindSwitch({ logger: silentLogger, switchable: ["door"] }),
		reporter: nullErrorReporter,
		now: () => new Date(90 * 60_000),
	}).commands?.[0];
	const sub = admin?.subcommands?.find(
		(s): s is SubcommandDefinition => !isSubgroup(s) && s.name === name,
	);
	if (!sub) throw new Error(`no /admin ${name}`);
	return sub;
}

describe("admin", () => {
	it("reloads the access lists as the caller, and reports before and after", async () => {
		const after = { admins: 2, members: 11, friends: 3 };
		const reload = vi.fn(async () => ({ before: counts, after }));
		const caller = principal("admin", { userId: IDS.admin });
		const reply = await adminSubcommand("reload", {
			view: { ...access.view, warnings: ["x", "y"] },
			apply: access.apply,
			reload,
		}).handler(context({ principal: caller }));
		expect(reload).toHaveBeenCalledWith(caller);
		expect(reply.text).toContain("Before: 2 admins · 10 members · 3 friends");
		expect(reply.text).toContain("Now: 2 admins · 11 members · 3 friends");
		expect(reply.text).toContain("2 warning(s)");
	});

	it("doesn't mention warnings when there are none", async () => {
		const reply = await adminSubcommand("reload").handler(
			context({ principal: principal("admin") }),
		);
		expect(reply.text).not.toContain("warning");
	});

	it("reports capabilities that no longer exist, by name, and says they're ignored", async () => {
		const captureBackground = vi.fn();
		const record = (capabilities: string[]) => ({
			ids: [`discord:${IDS.member}`],
			tier: "member" as const,
			capabilities,
		});
		const store = {
			view: {
				...access.view,
				records: new Map([[IDS.member, record(["gone", "old"])]]),
			},
			apply: access.apply,
			reload: access.reload,
		};
		const admin = createAdminFeature({
			version: "1.0.0",
			startedAt: new Date(0),
			access: store,
			capabilities: new CapabilityRegistry(),
			roles: new RoleMirror({ logger: silentLogger, reporter: nullErrorReporter }),
			home: new Home({ logger: silentLogger, reporter: nullErrorReporter }),
			homeDevices: HomeDeviceStore.empty(),
			homeInventory: HomeInventory.off(),
			switches: new KindSwitch({ logger: silentLogger, switchable: ["door"] }),
			reporter: { ...nullErrorReporter, captureBackground },
		}).commands?.[0];
		const reload = admin?.subcommands?.find((s) => s.name === "reload");
		if (!reload || isSubgroup(reload)) throw new Error("no /admin reload");
		const reply = await reload.handler(context({ principal: principal("admin") }));
		expect(reply.text).toContain("don't exist and are ignored: gone, old.");
		expect(captureBackground).toHaveBeenCalledTimes(1);
	});

	it("lets a failed reload's message through", async () => {
		const failing = {
			view: access.view,
			apply: access.apply,
			reload: async () => {
				throw new UserFacingError("Reload failed");
			},
		};
		await expect(
			adminSubcommand("reload", failing).handler(context({ principal: principal("admin") })),
		).rejects.toThrow("Reload failed");
	});

	it("shows counts but no IDs", async () => {
		const status = adminSubcommand("status");
		expect(status.private).toBe(true);
		const reply = await status.handler(context({ principal: principal("admin") }));
		const fields = reply.embeds?.[0]?.fields ?? [];
		expect(fields.find((f) => f.name === "Uptime")?.value).toBe("1h 30m");
		expect(fields.find((f) => f.name === "Access lists")?.value).toBe(
			"2 admins · 10 members · 3 friends",
		);
	});
});

describe("formatDuration", () => {
	it.each([
		[0, "0m"],
		[-5_000, "0m"],
		[59 * 60_000, "59m"],
		[25 * 3_600_000 + 60_000, "1d 1h 1m"],
	])("formatDuration(%i) = %s", (ms, expected) => {
		expect(formatDuration(ms)).toBe(expected);
	});
});
