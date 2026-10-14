import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { silentLogger } from "../core/logger.ts";
import { AnnouncementRouteStore, MAX_ROUTES } from "./announcement-routes.ts";

const A = "111111111111111111";
const B = "222222222222222222";

describe("AnnouncementRouteStore", () => {
	let dir: string;
	let file: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pixel-routes-"));
		file = join(dir, "data", "announcement-routes.yaml");
	});
	afterEach(() => {
		chmodSync(dir, 0o700);
		rmSync(dir, { recursive: true, force: true });
	});

	const open = () => new AnnouncementRouteStore({ file, logger: silentLogger });

	it("starts empty when there is no file", () => {
		expect(open().list()).toEqual([]);
	});

	it("keeps routes across a restart, as strings", () => {
		const store = open();
		expect(store.set({ style: "timeline", channelId: A })).toEqual({ saved: true });
		store.set({ style: "single", channelId: B });
		expect(open().list()).toEqual([
			{ style: "timeline", channelId: A },
			{ style: "single", channelId: B },
		]);
		// IDs stay quoted strings in the file, so they can't lose precision.
		expect(parse(readFileSync(file, "utf8")).routes[0].channelId).toBe(A);
	});

	it("gives a channel one style: setting it again replaces the old one", () => {
		const store = open();
		store.set({ style: "live", channelId: A });
		store.set({ style: "single", channelId: A });
		expect(store.list()).toEqual([{ style: "single", channelId: A }]);
	});

	it("removes a channel, and does nothing for one it doesn't have", () => {
		const store = open();
		store.set({ style: "live", channelId: A });
		store.set({ style: "timeline", channelId: B });
		expect(store.remove(A)).toEqual({ saved: true });
		store.remove("333333333333333333");
		expect(open().list()).toEqual([{ style: "timeline", channelId: B }]);
	});

	it("limits how many channels there can be, but always lets one be changed", () => {
		const store = open();
		for (let i = 0; i < MAX_ROUTES; i++) {
			store.set({ style: "timeline", channelId: String(100000000000000000n + BigInt(i)) });
		}
		expect(store.canAdd("999999999999999999")).toBe(false);
		expect(store.canAdd(String(100000000000000000n))).toBe(true);
	});

	it("treats a file it can't understand as empty, and says so", () => {
		mkdirSync(join(dir, "data"));
		const logger = { ...silentLogger, error: vi.fn(), child: () => logger };
		for (const bad of [
			"routes: [{style: nope, channelId: '111111111111111111'}]",
			"routes: [{style: live, channelId: 111111111111111111}]",
			"routes: [",
			"other: 1",
		]) {
			writeFileSync(file, bad);
			expect(new AnnouncementRouteStore({ file, logger }).list()).toEqual([]);
		}
		expect(logger.error).toHaveBeenCalledTimes(4);
	});

	it("says so when the file can't be read at all", () => {
		mkdirSync(file, { recursive: true }); // a directory where the file should be
		const logger = { ...silentLogger, error: vi.fn(), child: () => logger };
		expect(new AnnouncementRouteStore({ file, logger }).list()).toEqual([]);
		expect(logger.error).toHaveBeenCalledOnce();
	});

	it("keeps a change in memory when it can't be saved, and reports that", () => {
		const blocked = join(dir, "blocked");
		writeFileSync(blocked, "a file, not a directory");
		const store = new AnnouncementRouteStore({
			file: join(blocked, "routes.yaml"),
			logger: silentLogger,
		});
		expect(store.set({ style: "live", channelId: A })).toEqual({ saved: false });
		expect(store.list()).toEqual([{ style: "live", channelId: A }]);
	});

	it("works without a file (for tests and scripts)", () => {
		const store = new AnnouncementRouteStore({ logger: silentLogger });
		expect(store.set({ style: "live", channelId: A })).toEqual({ saved: true });
		expect(store.list()).toHaveLength(1);
	});
});
