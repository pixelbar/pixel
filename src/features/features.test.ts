import { describe, expect, it } from "vitest";
import { Announcer } from "../core/announcer.ts";
import { Calendar } from "../core/calendar.ts";
import type { Feature } from "../core/feature.ts";
import { formatDuration } from "../core/format.ts";
import { silentLogger } from "../core/logger.ts";
import { nullErrorReporter } from "../core/ports/error-reporter.ts";
import { CommandRegistry } from "../core/registry.ts";
import type { SpaceStatus } from "../services/space-status.ts";
import { context, IDS, plain, principal } from "../testing/fixtures.ts";
import { createAdminFeature } from "./admin/index.ts";
import { createHelpFeature } from "./help/index.ts";
import { buildFeatures } from "./index.ts";
import { createPingFeature } from "./ping/index.ts";
import { createWhoamiFeature } from "./whoami/index.ts";

const access = {
	discord: new Map(),
	counts: { admins: 2, members: 10, friends: 3 },
	warnings: [],
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
		).toEqual(["admin", "events", "help", "info", "ping", "status", "whoami"]);
	});

	it("restricts /admin to admins and opens /status, /events and /info to guests", () => {
		const registry = new CommandRegistry();
		for (const f of buildFeatures(deps())) registry.register(f);
		const admin = registry.get("admin")?.definition;
		expect(admin?.access.minTier).toBe("admin");
		expect(admin?.subcommands?.map((s) => [s.name, s.access.minTier])).toEqual([
			["status", "admin"],
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

describe("admin", () => {
	it("shows counts but no IDs", async () => {
		const admin = createAdminFeature({
			version: "1.0.0",
			startedAt: new Date(0),
			accessCounts: access.counts,
			now: () => new Date(90 * 60_000),
		}).commands?.[0];
		const status = admin?.subcommands?.[0];
		if (!status) throw new Error("no /admin status");
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
