import { describe, expect, it } from "vitest";
import type { SpaceStatusAnnouncement } from "../../core/announcement.ts";
import { silentLogger } from "../../core/logger.ts";
import {
	type AnnouncementChannel,
	createLivePublisher,
	createSinglePublisher,
	createTimelinePublisher,
	LIVE_PUBLISHER_ID,
	type OwnPost,
	TIMELINE_PUBLISHER_ID,
} from "./announce-publishers.ts";
import type { AnnouncementPost } from "./announce-render.ts";
import {
	LIVE_CLOSED_TITLE,
	LIVE_OPEN_FOOTER,
	LIVE_OPEN_TITLE,
	liveClosedPost,
	liveOpenPost,
	liveStandaloneClosedPost,
	SINGLE_FOOTER,
	singlePost,
	timelinePost,
} from "./announce-render.ts";
import type { LivePostStore } from "./announce-state.ts";

/** An in-memory channel that records what was sent and edited. */
class FakeChannel implements AnnouncementChannel {
	/** The bot's recent messages, newest first: what `recentOwnPosts` returns. */
	posts: OwnPost[] = [];
	/** Messages that exist but are too far back to show up in recent history. */
	buried: OwnPost[] = [];
	sent: AnnouncementPost[] = [];
	edits: { id: string; post: AnnouncementPost }[] = [];
	deleted: string[] = [];
	/** Ids whose delete fails. */
	failDeletes = new Set<string>();
	historyReads = 0;
	historyError: Error | undefined;
	lookupError: Error | undefined;
	sendError: Error | undefined;
	/** Ids whose edit fails (e.g. the message was deleted). */
	failEdits = new Set<string>();

	async send(post: AnnouncementPost): Promise<{ id: string }> {
		if (this.sendError) throw this.sendError;
		this.sent.push(post);
		return { id: `sent-${this.sent.length}` };
	}

	async edit(id: string, post: AnnouncementPost): Promise<void> {
		if (this.failEdits.has(id)) throw new Error("Unknown Message");
		this.edits.push({ id, post });
	}

	async delete(id: string): Promise<void> {
		if (this.failDeletes.has(id)) throw new Error("Unknown Message");
		this.deleted.push(id);
	}

	async recentOwnPosts(): Promise<OwnPost[]> {
		this.historyReads++;
		if (this.historyError) throw this.historyError;
		return this.posts;
	}

	async findOwnPost(id: string): Promise<OwnPost | undefined> {
		if (this.lookupError) throw this.lookupError;
		return [...this.posts, ...this.buried].find((post) => post.id === id);
	}
}

/** An in-memory store for the remembered open post. */
class FakeStore implements LivePostStore {
	remembered: string | undefined;
	saves: (string | undefined)[] = [];
	loadError: Error | undefined;
	saveError: Error | undefined;

	constructor(remembered?: string) {
		this.remembered = remembered;
	}

	load(): string | undefined {
		if (this.loadError) throw this.loadError;
		return this.remembered;
	}

	save(messageId: string | undefined): void {
		if (this.saveError) throw this.saveError;
		this.remembered = messageId;
		this.saves.push(messageId);
	}
}

const T = (hhmm: string) => new Date(`2026-10-03T${hhmm}:00Z`);

const openPost = (id: string, at: Date): OwnPost => ({
	id,
	title: LIVE_OPEN_TITLE,
	footer: LIVE_OPEN_FOOTER,
	timestamp: at,
});

const announcement = (
	state: "open" | "closed",
	at: Date,
	openedAt: Date | null = null,
): SpaceStatusAnnouncement => ({ kind: "space.status", state, at, openedAt, text: "" });

describe("timeline publisher", () => {
	it("sends every opening and closing as a new post, and never edits", async () => {
		const channel = new FakeChannel();
		const publisher = createTimelinePublisher(channel);
		expect(publisher.id).toBe(TIMELINE_PUBLISHER_ID);

		const opened = announcement("open", T("14:10"));
		const closed = announcement("closed", T("17:30"), T("14:10"));
		await publisher.publish(opened);
		await publisher.publish(closed);

		expect(channel.sent).toEqual([timelinePost(opened), timelinePost(closed)]);
		expect(channel.edits).toEqual([]);
		expect(channel.historyReads).toBe(0);
	});

	it("has nothing to reconcile, since it never edits", () => {
		expect(createTimelinePublisher(new FakeChannel()).reconcile).toBeUndefined();
	});

	it("lets a failed send surface so it gets reported", async () => {
		const channel = new FakeChannel();
		channel.sendError = new Error("Missing Permissions");
		await expect(
			createTimelinePublisher(channel).publish(announcement("open", T("14:10"))),
		).rejects.toThrow("Missing Permissions");
	});
});

describe("live publisher", () => {
	const live = (channel: FakeChannel) => createLivePublisher(channel, silentLogger);

	it("has its own id", () => {
		expect(live(new FakeChannel()).id).toBe(LIVE_PUBLISHER_ID);
	});

	describe("when the space opens", () => {
		it("posts a new open post", async () => {
			const channel = new FakeChannel();
			await live(channel).publish(announcement("open", T("14:10")));
			expect(channel.sent).toEqual([liveOpenPost(T("14:10"))]);
			expect(channel.edits).toEqual([]);
		});

		it("closes out any stale open posts first, so only the newest says open", async () => {
			const channel = new FakeChannel();
			channel.posts = [openPost("newer", T("10:00")), openPost("older", T("08:00"))];
			await live(channel).publish(announcement("open", T("14:10")));
			expect(channel.edits).toEqual([
				{ id: "newer", post: liveClosedPost(T("10:00"), null) },
				{ id: "older", post: liveClosedPost(T("08:00"), null) },
			]);
			expect(channel.sent).toEqual([liveOpenPost(T("14:10"))]);
		});

		it("still posts if the history can't be read or a stale post can't be edited", async () => {
			const unreadable = new FakeChannel();
			unreadable.historyError = new Error("Missing Access");
			await live(unreadable).publish(announcement("open", T("14:10")));
			expect(unreadable.sent).toEqual([liveOpenPost(T("14:10"))]);

			const stuck = new FakeChannel();
			stuck.posts = [openPost("stale", T("08:00"))];
			stuck.failEdits.add("stale");
			await live(stuck).publish(announcement("open", T("14:10")));
			expect(stuck.sent).toEqual([liveOpenPost(T("14:10"))]);
		});

		it("lets a failed send surface so it gets reported", async () => {
			const channel = new FakeChannel();
			channel.sendError = new Error("Missing Permissions");
			await expect(live(channel).publish(announcement("open", T("14:10")))).rejects.toThrow(
				"Missing Permissions",
			);
		});
	});

	describe("when the space closes", () => {
		it("edits the open post into a closed one, and posts nothing new", async () => {
			const channel = new FakeChannel();
			channel.posts = [openPost("current", T("14:10"))];
			await live(channel).publish(announcement("closed", T("17:30"), T("14:10")));
			expect(channel.edits).toEqual([
				{ id: "current", post: liveClosedPost(T("14:10"), T("17:30")) },
			]);
			expect(channel.sent).toEqual([]);
		});

		it("uses the open post's own time, not the announcement's", async () => {
			const channel = new FakeChannel();
			channel.posts = [openPost("current", T("14:10"))];
			await live(channel).publish(announcement("closed", T("17:30"), T("15:00")));
			expect(channel.edits[0]?.post).toEqual(liveClosedPost(T("14:10"), T("17:30")));
		});

		it("closes older stale open posts too, without an end time", async () => {
			const channel = new FakeChannel();
			channel.posts = [openPost("current", T("14:10")), openPost("stale", T("08:00"))];
			await live(channel).publish(announcement("closed", T("17:30")));
			expect(channel.edits).toEqual([
				{ id: "current", post: liveClosedPost(T("14:10"), T("17:30")) },
				{ id: "stale", post: liveClosedPost(T("08:00"), null) },
			]);
			expect(channel.sent).toEqual([]);
		});

		it("posts a closed post of its own when there was no open post to update", async () => {
			const channel = new FakeChannel();
			const closed = announcement("closed", T("17:30"), T("14:10"));
			await live(channel).publish(closed);
			expect(channel.sent).toEqual([liveStandaloneClosedPost(closed)]);
			expect(channel.edits).toEqual([]);
		});

		it("falls back to its own post if the open post can't be edited (e.g. deleted)", async () => {
			const channel = new FakeChannel();
			channel.posts = [openPost("gone", T("14:10"))];
			channel.failEdits.add("gone");
			const closed = announcement("closed", T("17:30"));
			await live(channel).publish(closed);
			expect(channel.sent).toEqual([liveStandaloneClosedPost(closed)]);
		});

		it("falls back to its own post if the history can't be read", async () => {
			const channel = new FakeChannel();
			channel.historyError = new Error("Missing Access");
			const closed = announcement("closed", T("17:30"));
			await live(channel).publish(closed);
			expect(channel.sent).toEqual([liveStandaloneClosedPost(closed)]);
		});
	});

	describe("finding its open post", () => {
		it("ignores posts that merely look similar", async () => {
			const channel = new FakeChannel();
			channel.posts = [
				// A /status reply: same title, but never has the live footer.
				{ id: "status-reply", title: LIVE_OPEN_TITLE, footer: undefined, timestamp: T("16:00") },
				// An already-closed live post, and unrelated posts.
				{ id: "closed", title: LIVE_CLOSED_TITLE, footer: undefined, timestamp: T("12:00") },
				{ id: "other", title: "Something else", footer: LIVE_OPEN_FOOTER, timestamp: T("11:00") },
				{ id: "plain", title: undefined, footer: undefined, timestamp: null },
			];
			const closed = announcement("closed", T("17:30"));
			await live(channel).publish(closed);
			expect(channel.edits).toEqual([]);
			expect(channel.sent).toEqual([liveStandaloneClosedPost(closed)]);
		});
	});

	describe("reconciling at startup", () => {
		it("closes every open post if the space is closed now, without posting anything", async () => {
			const channel = new FakeChannel();
			channel.posts = [openPost("a", T("14:10")), openPost("b", T("08:00"))];
			await live(channel).reconcile?.({ state: "closed", since: null });
			expect(channel.edits).toEqual([
				{ id: "a", post: liveClosedPost(T("14:10"), null) },
				{ id: "b", post: liveClosedPost(T("08:00"), null) },
			]);
			expect(channel.sent).toEqual([]);
		});

		it("keeps the newest open post if the space is open now, and closes older ones", async () => {
			const channel = new FakeChannel();
			channel.posts = [openPost("current", T("14:10")), openPost("stale", T("08:00"))];
			await live(channel).reconcile?.({ state: "open", since: T("14:10") });
			expect(channel.edits).toEqual([{ id: "stale", post: liveClosedPost(T("08:00"), null) }]);
			expect(channel.sent).toEqual([]);
		});

		it("does nothing when there's nothing stale", async () => {
			const channel = new FakeChannel();
			await live(channel).reconcile?.({ state: "closed", since: null });
			channel.posts = [openPost("current", T("14:10"))];
			await live(channel).reconcile?.({ state: "open", since: null });
			expect(channel.edits).toEqual([]);
			expect(channel.sent).toEqual([]);
		});

		it("doesn't fail when the history can't be read", async () => {
			const channel = new FakeChannel();
			channel.historyError = new Error("Missing Access");
			await expect(
				live(channel).reconcile?.({ state: "closed", since: null }),
			).resolves.toBeUndefined();
		});
	});

	describe("remembering the open post", () => {
		const liveWith = (channel: FakeChannel, store: FakeStore) =>
			createLivePublisher(channel, silentLogger, store);

		it("remembers the post it makes when the space opens, and forgets it when it closes", async () => {
			const channel = new FakeChannel();
			const store = new FakeStore();
			const publisher = liveWith(channel, store);

			await publisher.publish(announcement("open", T("14:10")));
			expect(store.saves).toEqual(["sent-1"]);

			// The new post shows up in history, as it would on Discord.
			channel.posts = [openPost("sent-1", T("14:10"))];
			await publisher.publish(announcement("closed", T("17:30")));
			expect(store.saves).toEqual(["sent-1", undefined]);
			expect(store.remembered).toBeUndefined();
		});

		it("finds a post that's buried too deep in a busy channel to appear in history", async () => {
			const channel = new FakeChannel();
			channel.buried = [openPost("buried", T("14:10"))];
			const store = new FakeStore("buried");

			await liveWith(channel, store).publish(announcement("closed", T("17:30"), T("14:10")));

			expect(channel.edits).toEqual([
				{ id: "buried", post: liveClosedPost(T("14:10"), T("17:30")) },
			]);
			expect(channel.sent).toEqual([]);
		});

		it("edits a post once even when it's both remembered and in history", async () => {
			const channel = new FakeChannel();
			channel.posts = [openPost("current", T("14:10"))];
			await liveWith(channel, new FakeStore("current")).publish(announcement("closed", T("17:30")));
			expect(channel.edits).toHaveLength(1);
		});

		it("treats the newest of the remembered and found posts as the current one", async () => {
			const channel = new FakeChannel();
			channel.posts = [openPost("newer", T("16:00"))];
			channel.buried = [openPost("older", T("08:00"))];
			await liveWith(channel, new FakeStore("older")).publish(announcement("closed", T("17:30")));
			expect(channel.edits).toEqual([
				{ id: "newer", post: liveClosedPost(T("16:00"), T("17:30")) },
				{ id: "older", post: liveClosedPost(T("08:00"), null) },
			]);
		});

		it("ignores a remembered post that is gone, closed, or not an open post", async () => {
			for (const channel of [
				new FakeChannel(), // deleted
				Object.assign(new FakeChannel(), {
					buried: [{ id: "x", title: LIVE_CLOSED_TITLE, footer: undefined, timestamp: T("14:10") }],
				}),
				Object.assign(new FakeChannel(), {
					buried: [{ id: "x", title: LIVE_OPEN_TITLE, footer: undefined, timestamp: T("14:10") }],
				}),
			]) {
				const closed = announcement("closed", T("17:30"));
				await liveWith(channel, new FakeStore("x")).publish(closed);
				expect(channel.edits).toEqual([]);
				expect(channel.sent).toEqual([liveStandaloneClosedPost(closed)]);
			}
		});

		it("falls back to history if the remembered post can't be looked up", async () => {
			const channel = new FakeChannel();
			channel.lookupError = new Error("Discord is having a bad day");
			channel.posts = [openPost("current", T("14:10"))];
			await liveWith(channel, new FakeStore("current")).publish(announcement("closed", T("17:30")));
			expect(channel.edits.map((edit) => edit.id)).toEqual(["current"]);
		});

		it("carries on if the store can't be read or written", async () => {
			const channel = new FakeChannel();
			channel.posts = [openPost("current", T("14:10"))];
			const store = new FakeStore("current");
			store.loadError = new Error("EACCES");
			store.saveError = new Error("EROFS");
			const publisher = liveWith(channel, store);

			await expect(publisher.publish(announcement("closed", T("17:30")))).resolves.toBeUndefined();
			expect(channel.edits.map((edit) => edit.id)).toEqual(["current"]);
			await expect(publisher.publish(announcement("open", T("18:00")))).resolves.toBeUndefined();
			expect(channel.sent).toHaveLength(1);
		});

		it("on startup, keeps hold of the current open post, or forgets it once closed", async () => {
			const channel = new FakeChannel();
			channel.posts = [openPost("current", T("14:10")), openPost("stale", T("08:00"))];
			const store = new FakeStore();
			const publisher = liveWith(channel, store);

			await publisher.reconcile?.({ state: "open", since: null });
			expect(store.remembered).toBe("current");

			await publisher.reconcile?.({ state: "closed", since: null });
			expect(store.remembered).toBeUndefined();
		});

		it("on startup, forgets a remembered post if there's no open post at all", async () => {
			const store = new FakeStore("gone");
			await liveWith(new FakeChannel(), store).reconcile?.({ state: "open", since: null });
			expect(store.remembered).toBeUndefined();
		});
	});
});

describe("single publisher", () => {
	const ID = "discord:single:111";
	const single = (channel: FakeChannel, store?: FakeStore) =>
		createSinglePublisher(channel, silentLogger, store, ID);
	const statusPost = (id: string, state: "open" | "closed"): OwnPost => ({
		id,
		title: state === "open" ? LIVE_OPEN_TITLE : LIVE_CLOSED_TITLE,
		footer: SINGLE_FOOTER,
		timestamp: T("14:10"),
	});

	it("has the id it was given", () => {
		expect(single(new FakeChannel()).id).toBe(ID);
	});

	it("posts the status, with nothing to remove the first time", async () => {
		const channel = new FakeChannel();
		await single(channel).publish(announcement("open", T("14:10")));
		expect(channel.sent).toEqual([singlePost("open", T("14:10"), null)]);
		expect(channel.deleted).toEqual([]);
	});

	it("posts the new status and deletes the previous post, so only one is left", async () => {
		const channel = new FakeChannel();
		channel.posts = [statusPost("old", "open")];
		await single(channel).publish(announcement("closed", T("17:30"), T("14:10")));
		expect(channel.sent).toEqual([singlePost("closed", T("17:30"), T("14:10"))]);
		expect(channel.deleted).toEqual(["old"]);
		expect(channel.edits).toEqual([]);
	});

	it("deletes every older status post, not only the newest", async () => {
		const channel = new FakeChannel();
		channel.posts = [statusPost("new", "closed"), statusPost("older", "open")];
		await single(channel).publish(announcement("open", T("18:00")));
		expect(channel.deleted).toEqual(["new", "older"]);
	});

	it("sends before it deletes, so a failed delete never leaves the channel empty", async () => {
		const channel = new FakeChannel();
		channel.posts = [statusPost("old", "open")];
		channel.failDeletes.add("old");
		await expect(
			single(channel).publish(announcement("closed", T("17:30"))),
		).resolves.toBeUndefined();
		expect(channel.sent).toHaveLength(1);
		// The next change finds the leftover and removes it too.
		await single(channel).publish(announcement("open", T("18:00")));
		expect(channel.deleted).toEqual([]);
		channel.failDeletes.clear();
		await single(channel).publish(announcement("closed", T("19:00")));
		expect(channel.deleted).toEqual(["old"]);
	});

	it("leaves live posts and other messages alone", async () => {
		const channel = new FakeChannel();
		channel.posts = [
			openPost("live", T("14:10")),
			{ id: "chat", title: "Something else", footer: undefined, timestamp: null },
		];
		await single(channel).publish(announcement("closed", T("17:30")));
		expect(channel.deleted).toEqual([]);
	});

	it("only announces the space", async () => {
		const channel = new FakeChannel();
		await single(channel).publish({
			kind: "closing.time",
			text: "",
			body: "x",
			at: T("17:30"),
		});
		expect(channel.sent).toEqual([]);
	});

	it("lets a failed send surface so it gets reported, and deletes nothing", async () => {
		const channel = new FakeChannel();
		channel.posts = [statusPost("old", "open")];
		channel.sendError = new Error("Missing Permissions");
		await expect(single(channel).publish(announcement("closed", T("17:30")))).rejects.toThrow(
			"Missing Permissions",
		);
		expect(channel.deleted).toEqual([]);
	});

	describe("remembering the post", () => {
		it("finds a post it remembered that is buried deep in the channel", async () => {
			const channel = new FakeChannel();
			channel.buried = [statusPost("buried", "open")];
			const store = new FakeStore("buried");
			await single(channel, store).publish(announcement("closed", T("17:30")));
			expect(channel.deleted).toEqual(["buried"]);
			expect(store.remembered).toBe("sent-1");
		});

		it("carries on when it can't load or save the hint", async () => {
			const channel = new FakeChannel();
			const store = new FakeStore("x");
			store.loadError = new Error("corrupt");
			store.saveError = new Error("disk full");
			await expect(
				single(channel, store).publish(announcement("open", T("14:10"))),
			).resolves.toBeUndefined();
			expect(channel.sent).toHaveLength(1);
		});
	});

	describe("reconciling at startup", () => {
		it("does nothing when there's no status post, and never posts", async () => {
			const channel = new FakeChannel();
			await single(channel).reconcile?.({ state: "open", since: T("14:10") });
			expect(channel.sent).toEqual([]);
			expect(channel.edits).toEqual([]);
		});

		it("leaves a post that is already right", async () => {
			const channel = new FakeChannel();
			channel.posts = [statusPost("a", "open")];
			const store = new FakeStore();
			await single(channel, store).reconcile?.({ state: "open", since: T("14:10") });
			expect(channel.edits).toEqual([]);
			expect(channel.deleted).toEqual([]);
			expect(store.remembered).toBe("a");
		});

		it("corrects a post that went out of date while Pixel was down, by editing it", async () => {
			const channel = new FakeChannel();
			channel.posts = [statusPost("a", "open")];
			await single(channel).reconcile?.({ state: "closed", since: T("17:30") });
			expect(channel.edits).toEqual([{ id: "a", post: singlePost("closed", T("17:30"), null) }]);
			expect(channel.sent).toEqual([]);
		});

		it("removes extras and keeps the newest", async () => {
			const channel = new FakeChannel();
			channel.posts = [statusPost("new", "closed"), statusPost("older", "open")];
			await single(channel).reconcile?.({ state: "closed", since: null });
			expect(channel.deleted).toEqual(["older"]);
			expect(channel.edits).toEqual([]);
		});

		it("doesn't fail when the edit does", async () => {
			const channel = new FakeChannel();
			channel.posts = [statusPost("a", "open")];
			channel.failEdits.add("a");
			await expect(
				single(channel).reconcile?.({ state: "closed", since: null }),
			).resolves.toBeUndefined();
		});
	});
});
