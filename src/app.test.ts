import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCore } from "./app.ts";
import type { Config } from "./config.ts";
import { MESSAGES } from "./core/dispatcher.ts";
import { silentLogger } from "./core/logger.ts";
import { nullErrorReporter } from "./core/ports/error-reporter.ts";
import { actor, IDS } from "./testing/fixtures.ts";

/** End-to-end through the real wiring: access files → identity → dispatcher → features. */
describe("buildCore", () => {
	let dir: string;
	let config: Config;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pixel-app-"));
		const adminsFile = join(dir, "admins.yaml");
		const membersFile = join(dir, "members.yaml");
		writeFileSync(adminsFile, `admins:\n  - name: Ada\n    discordId: "${IDS.admin}"\n`);
		writeFileSync(membersFile, `members:\n  - discordId: "${IDS.member}"\n    tier: member\n`);
		config = {
			env: "local",
			version: "test",
			logLevel: "info",
			access: { adminsFile, membersFile },
			dataDir: join(dir, "data"),
			healthPort: 0,
			sentryDsn: undefined,
			spaceApiUrl: "https://spaceapi.example/",
			discord: {
				token: "x",
				appId: "100000000000000010",
				guildId: "100000000000000020",
				announce: { liveChannelId: undefined, timelineChannelId: undefined },
			},
		};
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it.each([
		[IDS.admin, true],
		[IDS.member, false],
		[IDS.guest, false],
	])("/admin for %s → allowed=%s", async (userId, allowed) => {
		const { dispatcher } = buildCore(config, silentLogger, nullErrorReporter);
		const result = await dispatcher.dispatch({
			actor: actor({ userId }),
			command: "admin",
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

	it("refuses to build with an invalid access file", () => {
		writeFileSync(config.access.adminsFile, "admins: []\n");
		expect(() => buildCore(config, silentLogger, nullErrorReporter)).toThrow(/at least one admin/);
	});
});
