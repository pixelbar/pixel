import { describe, expect, it, vi } from "vitest";
import type { Announcement, BuildInfo } from "../../core/announcement.ts";
import type { HomeStatus } from "../../core/home.ts";
import { silentLogger } from "../../core/logger.ts";
import { checks, createBotStatus } from "./index.ts";

const build: BuildInfo = {
	version: "0.1.0",
	commit: "abc1234",
	branch: "feature/x",
	env: "dev",
	runtime: "cloud",
};
const started = new Date("2026-10-07T10:00:00Z");
const later = new Date("2026-10-07T13:00:00Z");
const space = (state: "open" | "closed" | "unknown") => ({
	checkNow: async () => ({ state, since: null, checkedAt: later }),
});

function setup(home: HomeStatus = { kind: "unconfigured" }, spaceStatus = space("open")) {
	const announced: Announcement[] = [];
	const announce = vi.fn(async (a: Announcement) => {
		announced.push(a);
	});
	const status = createBotStatus({
		announcer: { announce },
		build,
		startedAt: started,
		home: { status: () => home },
		spaceStatus,
		logger: silentLogger,
		now: () => later,
	});
	return { status, announced, announce };
}

describe("bot status", () => {
	it("announces Pixel coming online with its build and how it's doing", async () => {
		const { status, announced } = setup({ kind: "connected", haVersion: "x", adminToken: false });
		await status.up();
		expect(announced).toEqual([
			{
				kind: "bot.status",
				phase: "up",
				build,
				startedAt: started,
				at: later,
				checks: [
					{ name: "Discord", state: "ok", detail: "connected" },
					{ name: "Home Assistant", state: "ok", detail: "connected" },
					{ name: "SpaceAPI", state: "ok", detail: "reachable (Pixelbar is open)" },
				],
				text: "🟢 Pixel 0.1.0 abc1234 is online",
			},
		]);
	});

	it("announces Pixel going offline, with why", async () => {
		const { status, announced } = setup();
		await status.down("restarting or shutting down");
		expect(announced[0]).toMatchObject({
			kind: "bot.status",
			phase: "down",
			reason: "restarting or shutting down",
			startedAt: started,
			at: later,
			checks: [],
			text: "🔴 Pixel 0.1.0 abc1234 is going offline: restarting or shutting down",
		});
	});

	it("never throws, even when announcing fails", async () => {
		const { status, announce } = setup();
		announce.mockRejectedValueOnce(new Error("discord down"));
		await expect(status.up()).resolves.toBeUndefined();
	});

	it("leaves the commit out of the text when it isn't known", async () => {
		const announced: Announcement[] = [];
		await createBotStatus({
			announcer: { announce: async (a) => void announced.push(a) },
			build: { ...build, commit: undefined },
			startedAt: started,
			home: { status: () => ({ kind: "unconfigured" }) },
			spaceStatus: space("open"),
			logger: silentLogger,
		}).up();
		expect(announced[0]?.text).toBe("🟢 Pixel 0.1.0 is online");
	});
});

describe("checks", () => {
	it.each<[HomeStatus, string | undefined, string | undefined]>([
		[{ kind: "unconfigured" }, undefined, undefined],
		[{ kind: "connected", haVersion: undefined, adminToken: undefined }, "ok", "connected"],
		[{ kind: "connecting" }, "warn", "not connected yet"],
		[{ kind: "reconnecting" }, "warn", "not connected yet"],
		[{ kind: "off", reason: "secret detail" }, "warn", "off"],
	])("shows Home Assistant %j briefly, never its details", async (home, state, detail) => {
		const list = await checks({ home: { status: () => home }, spaceStatus: space("closed") });
		const found = list.find((c) => c.name === "Home Assistant");
		expect(found?.state).toBe(state);
		expect(found?.detail).toBe(detail);
		expect(JSON.stringify(list)).not.toContain("secret detail");
	});

	it("says whether SpaceAPI answered, and with what", async () => {
		const home = { status: (): HomeStatus => ({ kind: "unconfigured" }) };
		expect((await checks({ home, spaceStatus: space("closed") })).at(-1)).toEqual({
			name: "SpaceAPI",
			state: "ok",
			detail: "reachable (Pixelbar is closed)",
		});
		expect((await checks({ home, spaceStatus: space("unknown") })).at(-1)?.state).toBe("warn");
		const down = { checkNow: async () => Promise.reject(new Error("down")) };
		expect((await checks({ home, spaceStatus: down })).at(-1)).toEqual({
			name: "SpaceAPI",
			state: "warn",
			detail: "unreachable",
		});
	});

	it("doesn't wait forever for SpaceAPI", async () => {
		vi.useFakeTimers();
		try {
			const home = { status: (): HomeStatus => ({ kind: "unconfigured" }) };
			const hanging = { checkNow: () => new Promise<never>(() => {}) };
			const result = checks({ home, spaceStatus: hanging });
			await vi.advanceTimersByTimeAsync(5000);
			expect((await result).at(-1)?.detail).toBe("unreachable");
		} finally {
			vi.useRealTimers();
		}
	});
});
