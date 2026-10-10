import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCore } from "./app.ts";
import type { Config } from "./config.ts";
import { CapabilityError } from "./core/capabilities.ts";
import { MESSAGES } from "./core/dispatcher.ts";
import { silentLogger } from "./core/logger.ts";
import { nullErrorReporter } from "./core/ports/error-reporter.ts";
import { SCHEDULE_CAPABILITY } from "./features/schedules/index.ts";
import { actor, IDS } from "./testing/fixtures.ts";

/** End-to-end through the real wiring: access files → identity → dispatcher → features. */
describe("buildCore", () => {
	let dir: string;
	let config: Config;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pixel-app-"));
		const adminsFile = join(dir, "admins.yaml");
		const membersFile = join(dir, "members.yaml");
		writeFileSync(adminsFile, `admins:\n  - ids: ["discord:${IDS.admin}"]\n`);
		writeFileSync(
			membersFile,
			`members:\n  - ids: ["discord:${IDS.admin}"]\n    tier: member\n  - ids: ["discord:${IDS.member}"]\n    tier: member\n`,
		);
		mkdirSync(join(dir, "content", "info"), { recursive: true });
		writeFileSync(
			join(dir, "content", "info", "membership.md"),
			"---\ntitle: Becoming a member\nsummary: How to join\n---\nEmail the board.\n",
		);
		config = {
			env: "local",
			runtime: "local",
			version: "test",
			gitSha: undefined,
			gitBranch: undefined,
			logLevel: "info",
			access: { adminsFile, membersFile },
			dataDir: join(dir, "data"),
			contentDir: join(dir, "content"),
			homeAssistantDir: "config/home-assistant",
			homeSyncMinutes: 60,
			heartbeatMinutes: 0,
			logDir: undefined,
			timezone: "Europe/Amsterdam",
			healthPort: 0,
			sentryDsn: undefined,
			sentryTracesSampleRate: 1,
			sentryProfileSessionSampleRate: 1,
			spaceApiUrl: "https://spaceapi.example/",
			discord: {
				token: "x",
				appId: "100000000000000010",
				guildId: "100000000000000020",
				announcementsChannelId: undefined,
				announce: {
					liveChannelId: undefined,
					timelineChannelId: undefined,
					botChannelId: undefined,
				},
				roles: { member: undefined, friend: undefined },
			},
			homeAssistant: undefined,
		};
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it.each([
		[IDS.admin, true],
		[IDS.member, false],
		[IDS.guest, false],
	])("/admin status for %s → allowed=%s", async (userId, allowed) => {
		const { dispatcher } = buildCore(config, silentLogger, nullErrorReporter);
		const result = await dispatcher.dispatch({
			actor: actor({ userId }),
			command: "admin",
			subcommand: "status",
			args: {},
		});
		if (allowed) expect(result.reply.embeds?.[0]?.title).toBe("Pixel status");
		else expect(result.reply.text).toBe(MESSAGES.deniedTier);
		expect(result.private).toBe(true);
	});

	it("/whoami resolves tiers from the access files", async () => {
		const { dispatcher } = buildCore(config, silentLogger, nullErrorReporter);
		const result = await dispatcher.dispatch({
			actor: actor({ userId: IDS.member }),
			command: "whoami",
			args: {},
		});
		expect(result.reply.embeds?.[0]?.fields?.[0]?.value).toBe("Pixelbar member");
	});

	it("/status shows a placeholder, then the live SpaceAPI state, for guests", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () => new Response(JSON.stringify({ state: { open: true } })),
		);
		const { dispatcher } = buildCore(config, silentLogger, nullErrorReporter, { fetch });
		const onPending = vi.fn(async () => {});
		const result = await dispatcher.dispatch(
			{ actor: actor({ userId: IDS.guest }), command: "status", args: {} },
			{ onPending },
		);
		expect(onPending).toHaveBeenCalledWith(
			expect.objectContaining({
				reply: { embeds: [expect.objectContaining({ title: "Checking…" })] },
				private: false,
			}),
		);
		expect(fetch).toHaveBeenCalledWith("https://spaceapi.example/", expect.anything());
		expect(result).toMatchObject({
			reply: { embeds: [expect.objectContaining({ title: "🟢 Pixelbar is open" })] },
			private: false,
		});
	});

	it("remembers when the space last changed across restarts, in data/space.state", async () => {
		const spaceApi = (...states: boolean[]) => {
			const queue = [...states];
			return vi.fn<typeof globalThis.fetch>(
				async () => new Response(JSON.stringify({ state: { open: queue.shift() } })),
			);
		};
		const status = (core: ReturnType<typeof buildCore>) =>
			core.dispatcher.dispatch({
				actor: actor({ userId: IDS.guest }),
				command: "status",
				args: {},
			});

		// First run: Pixel sees the space open, then close.
		const first = buildCore(config, silentLogger, nullErrorReporter, {
			fetch: spaceApi(true, false),
		});
		await status(first);
		await status(first);
		expect(readFileSync(join(config.dataDir, "space.state"), "utf8")).toMatch(
			/state: closed\nsince: \d{4}-\d\d-\d\dT[\d:.]+Z\n/,
		);

		// After a restart it still knows when that happened, without having seen it itself.
		const second = buildCore(config, silentLogger, nullErrorReporter, {
			fetch: spaceApi(false),
		});
		const result = await status(second);
		expect(result.reply.embeds?.[0]).toMatchObject({
			title: "🔴 Pixelbar is closed",
			description: "Closed for 0m.",
		});
	});

	it("/events shows the calendar once an adapter plugs its source in, and says so before that", async () => {
		const core = buildCore(config, silentLogger, nullErrorReporter);
		const events = () =>
			core.dispatcher.dispatch({
				actor: actor({ userId: IDS.guest }),
				command: "events",
				args: {},
			});

		// No adapter has connected yet.
		expect((await events()).reply.embeds?.[0]?.title).toBe("⚠️ Couldn't load the calendar");

		const startsAt = new Date(Date.now() + 2 * 86_400_000);
		core.calendar.use({
			upcoming: async () => [
				{
					id: "1",
					title: "Soldering workshop",
					startsAt,
					endsAt: null,
					location: "Pixelbar",
					url: "https://discord.com/events/1/2",
					repeats: "weekly",
				},
			],
		});
		const result = await events();
		expect(result.private).toBe(false);
		expect(result.reply.embeds?.[0]?.description).toContain(
			"[Soldering workshop](https://discord.com/events/1/2)",
		);
		expect(result.reply.embeds?.[0]?.description).toContain("🔁 weekly");
	});

	it("/info answers from the content folder, for guests, in public", async () => {
		const { dispatcher } = buildCore(config, silentLogger, nullErrorReporter);
		const info = (args: Record<string, string>) =>
			dispatcher.dispatch({ actor: actor({ userId: IDS.guest }), command: "info", args });

		const topic = await info({ topic: "membership" });
		expect(topic.private).toBe(false);
		expect(topic.reply.embeds?.[0]).toMatchObject({
			title: "Becoming a member",
			description: "Email the board.",
		});

		const list = await info({});
		expect(list.reply.embeds?.[0]?.description).toContain("**membership**: How to join");
	});

	it("/info points at this server's announcements channel, or says so in words if there isn't one", async () => {
		writeFileSync(
			join(dir, "content", "info", "visiting.md"),
			"---\ntitle: Visiting\nsummary: Dropping by\n---\nCheck {{announcements-channel}} for the poll.\n",
		);
		const visiting = async (announcementsChannelId?: string) => {
			const { dispatcher } = buildCore(
				{ ...config, discord: { ...config.discord, announcementsChannelId } },
				silentLogger,
				nullErrorReporter,
			);
			const result = await dispatcher.dispatch({
				actor: actor({ userId: IDS.guest }),
				command: "info",
				args: { topic: "visiting" },
			});
			return result.reply.embeds?.[0]?.description;
		};

		expect(await visiting("100000000000000031")).toBe("Check <#100000000000000031> for the poll.");
		expect(await visiting()).toBe("Check the announcements channel for the poll.");
	});

	it("refuses to build when /info content uses a placeholder that doesn't exist", () => {
		writeFileSync(
			join(dir, "content", "info", "oops.md"),
			"---\ntitle: Oops\nsummary: Typo\n---\nSee {{announcement-channel}}.\n",
		);
		expect(() => buildCore(config, silentLogger, nullErrorReporter)).toThrow(
			/oops\.md: \{\{announcement-channel\}\} isn't a known placeholder/,
		);
	});

	it("rejects a topic that isn't in the content folder", async () => {
		const { dispatcher } = buildCore(config, silentLogger, nullErrorReporter);
		const result = await dispatcher.dispatch({
			actor: actor({ userId: IDS.guest }),
			command: "info",
			args: { topic: "wifi-password" },
		});
		expect(result.reply.text).toMatch(/Invalid value for option "topic"/);
	});

	it("refuses to build with invalid /info content", () => {
		writeFileSync(join(dir, "content", "info", "broken.md"), "no front matter here");
		expect(() => buildCore(config, silentLogger, nullErrorReporter)).toThrow(
			/broken\.md: must start with a --- block/,
		);
	});

	it("refuses to build when there is no content folder", () => {
		rmSync(join(dir, "content"), { recursive: true });
		expect(() => buildCore(config, silentLogger, nullErrorReporter)).toThrow(
			/Invalid info content/,
		);
	});

	it("refuses to build with an invalid access file", () => {
		writeFileSync(config.access.adminsFile, "admins: []\n");
		expect(() => buildCore(config, silentLogger, nullErrorReporter)).toThrow(/at least one admin/);
	});

	describe("capabilities", () => {
		// Every command's capability must be registered, so the tests add theirs to the ones features need.
		const DOOR = [{ name: "door", description: "Open the door" }, SCHEDULE_CAPABILITY];
		const person = { id: IDS.member, displayName: "Grace", handle: "grace", isBot: false };

		it("refuses to build when a command needs a capability that isn't registered", () => {
			expect(() =>
				buildCore(config, silentLogger, nullErrorReporter, { capabilities: [] }),
			).toThrow(/Unknown capability required by command "schedule"/);
		});

		it("registers the Home Assistant capabilities, so admins can grant them", async () => {
			const core = buildCore(config, silentLogger, nullErrorReporter);
			expect(core.capabilities.all().map((c) => c.name)).toEqual([
				"ha-admin",
				"ha-lights",
				"ha-switches",
				"ha-doors",
				"schedule-posts",
			]);
			const listed = await core.dispatcher.dispatch({
				actor: actor({ userId: IDS.admin }),
				command: "admin",
				subgroup: "capabilities",
				subcommand: "list",
				args: {},
			});
			const text = JSON.stringify(listed.reply);
			for (const name of ["ha-admin", "ha-lights", "ha-switches", "ha-doors"]) {
				expect(text).toContain(name);
			}
			const grant = await core.dispatcher.dispatch({
				actor: actor({ userId: IDS.admin }),
				command: "admin",
				subgroup: "capabilities",
				subcommand: "grant",
				args: { user: IDS.member, capability: "ha-lights" },
				users: { user: person },
			});
			expect(grant.reply.embeds?.[0]?.title).toBe("Capability granted");
			expect(core.access.view.records.get(IDS.member)?.capabilities).toEqual(["ha-lights"]);
		});

		it("DMs the person on grant and revoke, and not when nothing changes", async () => {
			const sent: { userId: string; text: string }[] = [];
			const core = buildCore(config, silentLogger, nullErrorReporter);
			core.capabilityNotify.attach({
				send: async (userId, text) => {
					sent.push({ userId, text });
				},
			});
			const grant = {
				actor: actor({ userId: IDS.admin }),
				command: "admin" as const,
				subgroup: "capabilities",
				subcommand: "grant" as const,
				args: { user: IDS.member, capability: "ha-lights" },
				users: { user: person },
			};
			await core.dispatcher.dispatch(grant);
			await core.dispatcher.dispatch(grant);
			const revoke = { ...grant, subcommand: "revoke" as const };
			await core.dispatcher.dispatch(revoke);
			await core.dispatcher.dispatch(revoke);

			expect(sent).toHaveLength(2);
			expect(sent[0]).toMatchObject({ userId: IDS.member });
			expect(sent[0]?.text).toContain("**ha-lights**");
			expect(sent[0]?.text).toMatch(/granted/i);
			expect(sent[1]?.text).toMatch(/revoked/i);
			expect(core.access.view.records.get(IDS.member)?.capabilities).toEqual([]);
		});

		it("still grants when the DM cannot be sent", async () => {
			const core = buildCore(config, silentLogger, nullErrorReporter);
			core.capabilityNotify.attach({
				send: async () => {
					throw new Error("they have DMs from server members closed");
				},
			});
			const result = await core.dispatcher.dispatch({
				actor: actor({ userId: IDS.admin }),
				command: "admin",
				subgroup: "capabilities",
				subcommand: "grant",
				args: { user: IDS.member, capability: "ha-lights" },
				users: { user: person },
			});
			expect(result.reply.embeds?.[0]?.title).toBe("Capability granted");
			expect(result.reply.text ?? "").not.toMatch(/DM|closed/i);
			expect(core.access.view.records.get(IDS.member)?.capabilities).toEqual(["ha-lights"]);
		});

		it("lets an admin grant one, which then shows in the member's principal and the file", async () => {
			const core = buildCore(config, silentLogger, nullErrorReporter, { capabilities: DOOR });
			const grant = await core.dispatcher.dispatch({
				actor: actor({ userId: IDS.admin }),
				command: "admin",
				subgroup: "capabilities",
				subcommand: "grant",
				args: { user: IDS.member, capability: "door" },
				users: { user: person },
			});
			expect(grant.reply.embeds?.[0]?.title).toBe("Capability granted");
			expect(readFileSync(config.access.membersFile, "utf8")).toContain("door");
			expect(core.access.view.records.get(IDS.member)?.capabilities).toEqual(["door"]);

			// A restart sees it too.
			const restarted = buildCore(config, silentLogger, nullErrorReporter, { capabilities: DOOR });
			expect(restarted.access.view.records.get(IDS.member)?.capabilities).toEqual(["door"]);
		});

		it("refuses a member, a friend and a guest the admin commands", async () => {
			const core = buildCore(config, silentLogger, nullErrorReporter, { capabilities: DOOR });
			for (const userId of [IDS.member, IDS.friend, IDS.guest]) {
				const result = await core.dispatcher.dispatch({
					actor: actor({ userId }),
					command: "admin",
					subgroup: "capabilities",
					subcommand: "list",
					args: {},
				});
				expect(result.reply.text).toBe(MESSAGES.deniedTier);
			}
		});

		it("ignores capability names in the file that don't exist, and reports them without failing", () => {
			writeFileSync(
				config.access.membersFile,
				`members:\n  - ids: ["discord:${IDS.admin}"]\n    tier: member\n  - ids: ["discord:${IDS.member}"]\n    tier: member\n    capabilities:\n      - gone\n`,
			);
			const captureBackground = vi.fn();
			const core = buildCore(config, silentLogger, { ...nullErrorReporter, captureBackground });
			expect(core.access.view.records.get(IDS.member)?.capabilities).toEqual(["gone"]);
			expect(captureBackground).toHaveBeenCalledTimes(1);
			const [error, source] = captureBackground.mock.calls[0] ?? [];
			expect(error).toBeInstanceOf(CapabilityError);
			expect(source).toBe("access-config");
		});

		it("stays quiet when every name in the file exists", () => {
			writeFileSync(
				config.access.membersFile,
				`members:\n  - ids: ["discord:${IDS.admin}"]\n    tier: member\n  - ids: ["discord:${IDS.member}"]\n    tier: member\n    capabilities:\n      - door\n`,
			);
			const captureBackground = vi.fn();
			buildCore(
				config,
				silentLogger,
				{ ...nullErrorReporter, captureBackground },
				{ capabilities: DOOR },
			);
			expect(captureBackground).not.toHaveBeenCalled();
		});
	});

	describe("feedback", () => {
		const ask = (core: ReturnType<typeof buildCore>, userId: string) =>
			core.dispatcher.dispatch({
				actor: actor({ userId, displayName: "Someone" }),
				command: "feedback",
				args: { message: "The quiz night is missing from /events" },
			});

		it("says it isn't set up when nothing is plugged in, and nothing is sent", async () => {
			const result = await ask(buildCore(config, silentLogger, nullErrorReporter), IDS.guest);
			expect(result.reply.text).toBe("Feedback isn't set up right now, sorry.");
			expect(result.private).toBe(true);
		});

		it("sends it, for a guest too, with who it's from", async () => {
			const send = vi.fn(() => true);
			const core = buildCore(config, silentLogger, nullErrorReporter, { feedback: { send } });
			const result = await ask(core, IDS.guest);
			expect(result.reply.text).toContain("Thank you");
			expect(send).toHaveBeenCalledWith({
				message: "The quiz night is missing from /events",
				from: expect.objectContaining({ userId: IDS.guest, tier: "guest", displayName: "Someone" }),
			});
		});
	});

	describe("Home Assistant devices", () => {
		const haConfig = (haDir: string): Config => ({
			...config,
			homeAssistantDir: haDir,
			homeAssistant: { url: "https://ha.example", token: "not-a-real-token" },
		});

		it("doesn't look for a devices file when Home Assistant isn't configured", () => {
			const core = buildCore(
				{ ...config, homeAssistantDir: join(dir, "nowhere") },
				silentLogger,
				nullErrorReporter,
			);
			expect(core.homeDevices.configured).toBe(false);
			expect(core.homeDevices.view.devices).toEqual([]);
		});

		it("refuses to build when Home Assistant is configured but the devices file is missing", () => {
			expect(() =>
				buildCore(haConfig(join(dir, "nowhere")), silentLogger, nullErrorReporter),
			).toThrow(/cannot read file/);
		});

		it("refuses to build with an invalid devices file", () => {
			const haDir = join(dir, "ha");
			mkdirSync(haDir);
			writeFileSync(join(haDir, "devices.yaml"), "devices:\n  - name: BAD\n");
			expect(() => buildCore(haConfig(haDir), silentLogger, nullErrorReporter)).toThrow(
				/invalid devices file/,
			);
		});

		it("has a working inventory, with the interval from the config, only when Home Assistant is set up", () => {
			const haDir = join(dir, "ha");
			mkdirSync(haDir);
			writeFileSync(join(haDir, "devices.yaml"), "devices: []\n");
			const on = buildCore(
				{ ...haConfig(haDir), homeSyncMinutes: 15 },
				silentLogger,
				nullErrorReporter,
			);
			expect(on.homeInventory.configured).toBe(true);
			expect(on.homeInventory.intervalMs).toBe(15 * 60_000);
			const off = buildCore(config, silentLogger, nullErrorReporter);
			expect(off.homeInventory.configured).toBe(false);
		});

		it("never lets the inventory into the devices people can use", async () => {
			const haDir = join(dir, "ha");
			mkdirSync(haDir);
			writeFileSync(join(haDir, "devices.yaml"), "devices: []\n");
			writeFileSync(
				join(haDir, "inventory.yaml"),
				"inventory:\n  - name: lamp\n    entity: light.lamp\n    kind: light\n",
			);
			const core = buildCore(haConfig(haDir), silentLogger, nullErrorReporter);
			expect(core.homeDevices.view.devices).toEqual([]);
			expect(core.homeDevices.view.byName.has("lamp")).toBe(false);
		});

		it("loads the devices when the file is valid", () => {
			const haDir = join(dir, "ha");
			mkdirSync(haDir);
			writeFileSync(
				join(haDir, "devices.yaml"),
				"devices:\n  - name: lamp\n    entity: light.lamp\n    kind: light\n    actions: [on]\n",
			);
			const core = buildCore(haConfig(haDir), silentLogger, nullErrorReporter);
			expect(core.homeDevices.configured).toBe(true);
			expect(core.homeDevices.view.byName.get("lamp")?.entityId).toBe("light.lamp");
		});
	});
});
