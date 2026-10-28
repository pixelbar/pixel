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
	});

	describe("list", () => {
		it("shows every channel with its style", async () => {
			const { routes } = setup();
			await routes.set("single", GENERAL);
			expect(routes.list()).toEqual([{ style: "single", channelId: GENERAL }]);
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

		describe("retry", () => {
			const HIDDEN = "the bot lacks these permissions there: ViewChannel";

			it("starts a broken route once its channel works, without setting it again", async () => {
				saved([
					{ style: "timeline", channelId: ANNOUNCEMENTS },
					{ style: "single", channelId: GENERAL },
				]);
				const { routes, registered, problems, opened } = setup();
				problems.set(GENERAL, HIDDEN);
				await routes.start();
				expect(routes.hasProblems()).toBe(true);
				problems.delete(GENERAL);
				opened.length = 0;
				await routes.retry();
				// Only the broken one is opened again.
				expect(opened).toEqual([{ channelId: GENERAL, required: LIVE_PERMISSIONS }]);
				expect(registered.has(routePublisherId("single", GENERAL))).toBe(true);
				expect(routes.hasProblems()).toBe(false);
				expect(routes.list().find((r) => r.channelId === GENERAL)?.problem).toBeUndefined();
			});

			it("stays quiet while the problem is the same, and reports a new one", async () => {
				saved([{ style: "single", channelId: GENERAL }]);
				const { routes, problems, reportError } = setup();
				problems.set(GENERAL, HIDDEN);
				await routes.start();
				await routes.retry();
				expect(reportError).toHaveBeenCalledOnce();
				problems.set(GENERAL, "there's no channel with that ID");
				await routes.retry();
				expect(reportError).toHaveBeenCalledTimes(2);
				expect(routes.list()[0]?.problem).toBe(
					"I can't announce in that channel: there's no channel with that ID.",
				);
			});

			it("leaves a route alone that an admin changed or removed while it was opening", async () => {
				saved([
					{ style: "single", channelId: GENERAL },
					{ style: "live", channelId: ANNOUNCEMENTS },
				]);
				let whileOpening: ((channelId: string) => void) | undefined;
				const { routes, store, registered } = setup({
					openChannel: async (channelId): Promise<OpenedChannel> => {
						if (!whileOpening) return { ok: false, problem: HIDDEN };
						whileOpening(channelId);
						return { ok: true, channel: fakeChannel().channel };
					},
				});
				await routes.start();
				// While each opens, an admin removes one and moves the other to another style.
				whileOpening = (channelId) => {
					if (channelId === GENERAL) store.remove(GENERAL);
					else store.set({ style: "timeline", channelId });
				};
				await routes.retry();
				expect(registered.size).toBe(0);
			});

			it("does nothing when every route is posting", async () => {
				saved([{ style: "single", channelId: GENERAL }]);
				const { routes, opened } = setup();
				await routes.start();
				opened.length = 0;
				await routes.retry();
				expect(opened).toEqual([]);
			});
		});

		it("writes its post memory under the given directory", async () => {
			const { routes, registered } = setup();
			await routes.set("live", GENERAL);
			await registered.get(routePublisherId("live", GENERAL))?.publish(open);
			expect(readFileSync(join(dir, "posts", `live-${GENERAL}.state`), "utf8")).toContain(GENERAL);
		});
	});

	describe("several channels at once", () => {
		const THIRD = "444444444444444444";

		/**
		 * A channel that keeps what the bot posted, with ids unique to the channel so a
		 * mixed-up memory would point at the wrong message. History is hidden, so the
		 * only way to find the previous post is the remembered message ID.
		 */
		/** A Discord-shaped message ID, unique to the channel: its first digit says which. */
		const messageId = (prefix: string, n: number) => `${prefix}${String(n).padStart(17, "0")}`;

		function rememberingChannel(prefix: string) {
			const posts = new Map<string, AnnouncementPost>();
			const deleted: string[] = [];
			let next = 1;
			const channel: AnnouncementChannel = {
				send: async (post) => {
					const id = messageId(prefix, next++);
					posts.set(id, post);
					return { id };
				},
				edit: async (id, post) => {
					posts.set(id, post);
				},
				delete: async (id) => {
					if (!posts.delete(id)) throw new Error(`Unknown Message ${id}`);
					deleted.push(id);
				},
				recentOwnPosts: async () => [],
				findOwnPost: async (id) => {
					const embed = posts.get(id)?.embeds[0];
					if (!embed) return undefined;
					return {
						id,
						title: embed.title,
						footer: embed.footer?.text,
						timestamp: embed.timestamp ? new Date(embed.timestamp) : null,
					};
				},
			};
			return { channel, posts, deleted };
		}

		it("keeps each single channel to exactly its own one post, across changes and a restart", async () => {
			const channels = new Map([
				[GENERAL, rememberingChannel("7")],
				[ANNOUNCEMENTS, rememberingChannel("8")],
				[THIRD, rememberingChannel("9")],
			]);
			const openChannel = async (channelId: string): Promise<OpenedChannel> => {
				const found = channels.get(channelId);
				return found ? { ok: true, channel: found.channel } : { ok: false, problem: "unknown" };
			};

			// Two single channels and a timeline, set by an admin.
			const first = setup({ openChannel });
			await first.routes.set("single", GENERAL);
			await first.routes.set("single", ANNOUNCEMENTS);
			await first.routes.set("timeline", THIRD);
			expect(first.store.list()).toHaveLength(3);
			expect(first.registered.size).toBe(3);

			const announce = async (
				registered: Map<string, Publisher>,
				a: typeof open | typeof closed,
			) => {
				for (const publisher of registered.values()) await publisher.publish(a);
			};
			await announce(first.registered, open);
			await announce(first.registered, closed);

			const general = channels.get(GENERAL);
			const announcements = channels.get(ANNOUNCEMENTS);
			// Each single channel replaced only its own post.
			expect([...(general?.posts.keys() ?? [])]).toEqual(["700000000000000002"]);
			expect(general?.deleted).toEqual(["700000000000000001"]);
			expect([...(announcements?.posts.keys() ?? [])]).toEqual(["800000000000000002"]);
			expect(announcements?.deleted).toEqual(["800000000000000001"]);
			// The timeline keeps every post.
			expect(channels.get(THIRD)?.posts.size).toBe(2);

			// Each single channel remembers its own post in its own file.
			const memory = (channelId: string) =>
				readFileSync(join(dir, "posts", `single-${channelId}.state`), "utf8");
			expect(memory(GENERAL)).toContain("700000000000000002");
			expect(memory(GENERAL)).not.toContain(messageId("8", 2));
			expect(memory(ANNOUNCEMENTS)).toContain("800000000000000002");
			expect(memory(ANNOUNCEMENTS)).not.toContain(messageId("7", 2));

			// After a restart, the saved routes come back and each finds its own post again.
			const second = setup({ openChannel });
			await second.routes.start();
			expect(second.registered.size).toBe(3);
			await announce(second.registered, open);
			expect([...(general?.posts.keys() ?? [])]).toEqual(["700000000000000003"]);
			expect([...(announcements?.posts.keys() ?? [])]).toEqual(["800000000000000003"]);
			expect(general?.deleted).toEqual(["700000000000000001", "700000000000000002"]);
			expect(announcements?.deleted).toEqual(["800000000000000001", "800000000000000002"]);
		});

		it("removing one channel leaves the others announcing", async () => {
			const { routes, registered } = setup();
			await routes.set("single", GENERAL);
			await routes.set("single", ANNOUNCEMENTS);
			await routes.remove(GENERAL);
			expect([...registered.keys()]).toEqual([routePublisherId("single", ANNOUNCEMENTS)]);
			expect(routes.list()).toEqual([{ style: "single", channelId: ANNOUNCEMENTS }]);
		});
	});
});
