import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Publisher } from "../../core/announcement.ts";
import { UserFacingError } from "../../core/errors.ts";
import { silentLogger } from "../../core/logger.ts";
import { AnnouncementRouteStore } from "../../services/announcement-routes.ts";
import type { OpenedChannel } from "./announce-channel.ts";
import { LIVE_PERMISSIONS, TIMELINE_PERMISSIONS } from "./announce-channel.ts";
import type { AnnouncementChannel } from "./announce-publishers.ts";
import { type AnnouncementPost, LIVE_OPEN_FOOTER } from "./announce-render.ts";
import {
	DiscordAnnouncementRoutes,
	type DiscordRoutesOptions,
	requiredPermissions,
	routePublisherId,
} from "./announce-routes.ts";

const GENERAL = "111111111111111111";
const ANNOUNCEMENTS = "222222222222222222";
const ENV_LIVE = "333333333333333333";

/** A channel that records what is sent to it. */
function fakeChannel() {
	const sent: AnnouncementPost[] = [];
	const deleted: string[] = [];
	const channel: AnnouncementChannel = {
		send: async (post) => {
			sent.push(post);
			return { id: `m${sent.length}` };
		},
		edit: async () => {},
		delete: async (id) => {
			deleted.push(id);
		},
		recentOwnPosts: async () => [],
		findOwnPost: async () => undefined,
	};
	return { channel, sent, deleted };
}

describe("DiscordAnnouncementRoutes", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pixel-discord-routes-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	function setup(options: Partial<DiscordRoutesOptions> = {}) {
		const registered = new Map<string, Publisher>();
		const channels = new Map<string, ReturnType<typeof fakeChannel>>();
		const opened: { channelId: string; required: readonly bigint[] }[] = [];
		const problems = new Map<string, string>();
		const reportError = vi.fn();
		const store = new AnnouncementRouteStore({
			file: join(dir, "announcement-routes.yaml"),
			logger: silentLogger,
		});
		const announcer = {
			register: (publisher: Publisher) => {
				if (registered.has(publisher.id)) throw new Error(`Duplicate ${publisher.id}`);
				registered.set(publisher.id, publisher);
			},
			unregister: (id: string) => registered.delete(id),
		};
		const routes = new DiscordAnnouncementRoutes({
			store,
			announcer,
			logger: silentLogger,
			reportError,
			postsDir: join(dir, "posts"),
			configRoutes: [{ style: "live", channelId: ENV_LIVE }],
			openChannel: async (channelId, required): Promise<OpenedChannel> => {
				opened.push({ channelId, required });
				const problem = problems.get(channelId);
				if (problem) return { ok: false, problem };
				const made = channels.get(channelId) ?? fakeChannel();
				channels.set(channelId, made);
				return { ok: true, channel: made.channel };
			},
			...options,
		});
		return { routes, store, registered, channels, opened, problems, reportError };
	}

	const open = {
		kind: "space.status",
		state: "open",
		at: new Date("2026-10-03T14:10:00Z"),
		openedAt: null,
		text: "",
	} as const;
	const closed = {
		...open,
		state: "closed",
		at: new Date("2026-10-03T17:30:00Z"),
		openedAt: open.at,
	} as const;

	it("names each publisher by style and channel, so several can run at once", () => {
		expect(routePublisherId("single", GENERAL)).toBe(`discord:single:${GENERAL}`);
		expect(requiredPermissions("timeline")).toBe(TIMELINE_PERMISSIONS);
		expect(requiredPermissions("live")).toBe(LIVE_PERMISSIONS);
		expect(requiredPermissions("single")).toBe(LIVE_PERMISSIONS);
	});

	describe("set", () => {
		it("starts announcing in the style, and keeps it", async () => {
			const { routes, store, registered, opened } = setup();
			await expect(routes.set("single", GENERAL)).resolves.toEqual({
				result: "added",
				saved: true,
			});
			expect([...registered.keys()]).toEqual([routePublisherId("single", GENERAL)]);
			expect(opened).toEqual([{ channelId: GENERAL, required: LIVE_PERMISSIONS }]);
			expect(store.list()).toEqual([{ style: "single", channelId: GENERAL }]);
		});

		it("allows several channels with different styles", async () => {
			const { routes, registered, channels } = setup();
			await routes.set("timeline", ANNOUNCEMENTS);
			await routes.set("live", GENERAL);
			expect(registered.size).toBe(2);
			// Each channel gets its own style from one announcement.
			await Promise.all([...registered.values()].map((p) => p.publish(open)));
			await Promise.all([...registered.values()].map((p) => p.publish(closed)));
			expect(channels.get(ANNOUNCEMENTS)?.sent).toHaveLength(2); // timeline: two new posts
			// live: the first post is the one that gets edited later, so it carries the live marker.
			expect(channels.get(GENERAL)?.sent[0]?.embeds[0]?.footer?.text).toBe(LIVE_OPEN_FOOTER);
			expect(channels.get(ANNOUNCEMENTS)?.sent[0]?.embeds[0]?.footer).toBeUndefined();
		});

		it("makes a single channel replace its previous post", async () => {
			const { routes, registered, channels } = setup();
			await routes.set("single", GENERAL);
			const publisher = registered.get(routePublisherId("single", GENERAL));
			await publisher?.publish(open);
			expect(channels.get(GENERAL)?.sent).toHaveLength(1);
			expect(channels.get(GENERAL)?.deleted).toEqual([]);
		});

		it("switches a channel's style, stopping the old publisher", async () => {
			const { routes, registered, store } = setup();
			await routes.set("live", GENERAL);
			await expect(routes.set("single", GENERAL)).resolves.toEqual({
				result: "changed",
				previous: "live",
				saved: true,
			});
			expect([...registered.keys()]).toEqual([routePublisherId("single", GENERAL)]);
			expect(store.list()).toEqual([{ style: "single", channelId: GENERAL }]);
		});

		it("says when nothing changed, and still keeps it running", async () => {
			const { routes, registered } = setup();
			await routes.set("timeline", GENERAL);
			await expect(routes.set("timeline", GENERAL)).resolves.toMatchObject({ result: "unchanged" });
			expect(registered.size).toBe(1);
		});

		it("refuses a channel it can't use, and changes nothing", async () => {
			const { routes, store, registered, problems } = setup();
			problems.set(GENERAL, "the bot lacks these permissions there: SendMessages");
			await expect(routes.set("single", GENERAL)).rejects.toThrow(
				"I can't announce in that channel: the bot lacks these permissions there: SendMessages.",
			);
			expect(store.list()).toEqual([]);
			expect(registered.size).toBe(0);
		});

		it("leaves the old style running when the new one can't start", async () => {
			const { routes, registered, problems } = setup();
			await routes.set("timeline", GENERAL);
			problems.set(GENERAL, "the bot can't see it");
			await expect(routes.set("single", GENERAL)).rejects.toBeInstanceOf(UserFacingError);
			expect([...registered.keys()]).toEqual([routePublisherId("timeline", GENERAL)]);
		});

		it("won't touch a channel the configuration already announces in", async () => {
			const { routes, store } = setup();
			await expect(routes.set("single", ENV_LIVE)).rejects.toThrow(
				/come from Pixel's configuration/,
			);
			expect(store.list()).toEqual([]);
		});

		it("refuses once there are too many channels", async () => {
			const { routes } = setup({
				store: {
					list: () => [],
					canAdd: () => false,
					set: () => ({ saved: true }),
					remove: () => ({ saved: true }),
				},
			});
			await expect(routes.set("single", GENERAL)).rejects.toThrow(/too many/);
		});

		it("reports a change it couldn't save", async () => {
			const { routes } = setup({
				store: {
					list: () => [],
					canAdd: () => true,
					set: () => ({ saved: false }),
					remove: () => ({ saved: true }),
				},
			});
			await expect(routes.set("live", GENERAL)).resolves.toMatchObject({ saved: false });
		});
	});

	describe("remove", () => {
		it("stops announcing and forgets the channel", async () => {
			const { routes, store, registered } = setup();
			await routes.set("single", GENERAL);
			await expect(routes.remove(GENERAL)).resolves.toEqual({
				removed: true,
				previous: "single",
				saved: true,
			});
			expect(registered.size).toBe(0);
			expect(store.list()).toEqual([]);
		});

		it("says when the channel wasn't set up", async () => {
			const { routes } = setup();
			await expect(routes.remove(GENERAL)).resolves.toEqual({ removed: false, saved: true });
		});

		it("won't touch a channel the configuration announces in", async () => {
			const { routes } = setup();
			await expect(routes.remove(ENV_LIVE)).rejects.toThrow(/come from Pixel's configuration/);
		});
	});

	describe("list", () => {
		it("shows configuration routes and admin routes together", async () => {
			const { routes } = setup();
			await routes.set("single", GENERAL);
			expect(routes.list()).toEqual([
				{ style: "live", channelId: ENV_LIVE, source: "config" },
				{ style: "single", channelId: GENERAL, source: "admin" },
			]);
		});
	});

	describe("start", () => {
		function saved(routes: { style: "live" | "timeline" | "single"; channelId: string }[]) {
			const file = join(dir, "announcement-routes.yaml");
			const writer = new AnnouncementRouteStore({ file, logger: silentLogger });
			for (const route of routes) writer.set(route);
			return file;
		}

		it("brings every saved route back after a restart", async () => {
			saved([
				{ style: "timeline", channelId: ANNOUNCEMENTS },
				{ style: "single", channelId: GENERAL },
			]);
			const { routes, registered } = setup();
			await routes.start();
			expect([...registered.keys()].sort()).toEqual(
				[routePublisherId("single", GENERAL), routePublisherId("timeline", ANNOUNCEMENTS)].sort(),
			);
		});

		it("keeps a route whose channel is broken on the list with the reason, and reports it", async () => {
			saved([
				{ style: "timeline", channelId: ANNOUNCEMENTS },
				{ style: "single", channelId: GENERAL },
			]);
			const { routes, registered, problems, reportError } = setup();
			problems.set(GENERAL, "the channel doesn't exist or the bot can't see it");
			await routes.start();
			// The other route is unaffected.
			expect([...registered.keys()]).toEqual([routePublisherId("timeline", ANNOUNCEMENTS)]);
			expect(routes.list().find((r) => r.channelId === GENERAL)).toMatchObject({
				style: "single",
				problem:
					"I can't announce in that channel: the channel doesn't exist or the bot can't see it.",
			});
			expect(reportError).toHaveBeenCalledOnce();
		});

		it("describes a failure that isn't a user-facing one generically", async () => {
			saved([{ style: "timeline", channelId: ANNOUNCEMENTS }]);
			const { routes } = setup({
				openChannel: async () => {
					throw new Error("socket hang up with a secret in it");
				},
			});
			await routes.start();
			expect(routes.list().at(-1)?.problem).toBe("it couldn't be set up");
		});

		it("clears the problem once the channel is fixed and set again", async () => {
			saved([{ style: "single", channelId: GENERAL }]);
			const { routes, registered, problems } = setup();
			problems.set(GENERAL, "the bot can't see it");
			await routes.start();
			problems.delete(GENERAL);
			await routes.set("single", GENERAL);
			expect(registered.size).toBe(1);
			expect(routes.list().find((r) => r.channelId === GENERAL)?.problem).toBeUndefined();
		});

		it("doesn't post twice to a channel that has since been put in the configuration", async () => {
			saved([{ style: "timeline", channelId: ENV_LIVE }]);
			const { routes, registered } = setup();
			await routes.start();
			expect(registered.size).toBe(0);
			expect(routes.list().at(-1)?.problem).toMatch(/now set in Pixel's configuration/);
		});

		it("writes its post memory under the given directory", async () => {
			const { routes, registered } = setup();
			await routes.set("live", GENERAL);
			await registered.get(routePublisherId("live", GENERAL))?.publish(open);
			expect(readFileSync(join(dir, "posts", `live-${GENERAL}.state`), "utf8")).toContain(GENERAL);
		});
	});
});
