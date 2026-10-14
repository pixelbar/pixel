import type { Publisher } from "../../core/announcement.ts";
import type { Logger } from "../../core/logger.ts";
import {
	type AnnouncementPost,
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

export const TIMELINE_PUBLISHER_ID = "discord:timeline";
export const LIVE_PUBLISHER_ID = "discord:live";

/** One of the bot's own messages in the announcement channel. */
export type OwnPost = {
	id: string;
	title: string | undefined;
	footer: string | undefined;
	timestamp: Date | null;
};

/** The few things the publishers need from a Discord channel, so they're testable without discord.js. */
export type AnnouncementChannel = {
	/** Sends a new post and returns its message ID. */
	send(post: AnnouncementPost): Promise<{ id: string }>;
	edit(id: string, post: AnnouncementPost): Promise<void>;
	/** Deletes one of the bot's own messages. */
	delete(id: string): Promise<void>;
	/** The bot's own most recent messages in the channel, newest first. */
	recentOwnPosts(limit: number): Promise<OwnPost[]>;
	/** One of the bot's own messages by ID; undefined if it doesn't exist or isn't the bot's. */
	findOwnPost(id: string): Promise<OwnPost | undefined>;
};

/** How far back to look for open posts. Plenty for a status channel. */
const RECENT_POSTS = 50;

/**
 * Timeline style: every open and every close is a new post, never edited, so a
 * status-only channel reads as a log of exactly when the space opened and closed.
 */
export function createTimelinePublisher(
	channel: AnnouncementChannel,
	id: string = TIMELINE_PUBLISHER_ID,
): Publisher {
	return {
		id,
		async publish(announcement) {
			// Only the space's own changes belong in a timeline channel.
			if (announcement.kind !== "space.status") return;
			await channel.send(timelinePost(announcement));
		},
	};
}

const newestFirst = (a: OwnPost, b: OwnPost): number =>
	(b.timestamp?.getTime() ?? 0) - (a.timestamp?.getTime() ?? 0);

const isOpenPost = (post: OwnPost): boolean =>
	post.title === LIVE_OPEN_TITLE && post.footer === LIVE_OPEN_FOOTER;

/**
 * Finds the bot's own posts of one kind again: by the message ID it remembered (so
 * it works even if the post has been buried in a busy channel), and by looking
 * through its recent messages (so it still works after a deploy that lost the
 * remembered ID, and a deleted post simply isn't found).
 */
function createPostTracker(
	channel: AnnouncementChannel,
	log: Logger,
	store: LivePostStore | undefined,
	isMine: (post: OwnPost) => boolean,
) {
	/** The post the store remembers, if it still exists and is one of ours. */
	async function rememberedPost(): Promise<OwnPost | undefined> {
		try {
			const id = store?.load();
			if (!id) return undefined;
			const post = await channel.findOwnPost(id);
			return post && isMine(post) ? post : undefined;
		} catch (error) {
			log.warn(
				{ event: "announcer.live_hint_failed", err: error },
				"couldn't use the remembered post",
			);
			return undefined;
		}
	}

	/** Matching posts among the channel's recent messages. Best effort: unreadable history means none. */
	async function recentPosts(): Promise<OwnPost[]> {
		try {
			return (await channel.recentOwnPosts(RECENT_POSTS)).filter(isMine);
		} catch (error) {
			log.warn(
				{ event: "announcer.live_history_failed", err: error },
				"couldn't read recent posts",
			);
			return [];
		}
	}

	return {
		/** Pixel's matching posts, newest first. */
		async findPosts(): Promise<OwnPost[]> {
			const posts = new Map<string, OwnPost>();
			const remembered = await rememberedPost();
			if (remembered) posts.set(remembered.id, remembered);
			for (const post of await recentPosts()) posts.set(post.id, post);
			return [...posts.values()].sort(newestFirst);
		},

		/** Remembers which post is current now (or none). Failing to save is never fatal. */
		remember(messageId: string | undefined): void {
			try {
				store?.save(messageId);
			} catch (error) {
				log.warn(
					{ event: "announcer.live_state_failed", err: error },
					"couldn't remember the open post",
				);
			}
		},
	};
}

/**
 * Live style: opening makes a new post; closing edits that post to say closed.
 * Opening again makes another new post — a closed post is never turned back
 * into an open one, so nobody is confused by a message that flips back.
 *
 * Pixel finds its open post two ways: the message ID it remembered (so it works
 * even if the post has been buried in a busy channel), and by looking through
 * its own recent messages (so it still works after a deploy that lost the
 * remembered ID, and a deleted post simply isn't found). Whenever it can, it
 * keeps the invariant that at most one post (the newest) says "open".
 */
export function createLivePublisher(
	channel: AnnouncementChannel,
	logger: Logger,
	store?: LivePostStore,
	id: string = LIVE_PUBLISHER_ID,
): Publisher {
	const log = logger.child({ publisher: id });
	const { findPosts: findOpenPosts, remember } = createPostTracker(channel, log, store, isOpenPost);

	/** Edits an open post to say closed. Returns whether it worked. */
	async function close(post: OwnPost, closedAt: Date | null): Promise<boolean> {
		try {
			await channel.edit(post.id, liveClosedPost(post.timestamp, closedAt));
			return true;
		} catch (error) {
			log.warn({ event: "announcer.live_edit_failed", err: error }, "couldn't update an open post");
			return false;
		}
	}

	return {
		id,

		async publish(announcement) {
			if (announcement.kind !== "space.status") return;
			const open = await findOpenPosts();

			if (announcement.state === "open") {
				// Anything still saying "open" is stale, so close it out before the new post.
				for (const stale of open) await close(stale, null);
				const sent = await channel.send(liveOpenPost(announcement.at));
				remember(sent.id);
				return;
			}

			const [latest, ...older] = open;
			const updated = latest ? await close(latest, announcement.at) : false;
			for (const stale of older) await close(stale, null);
			remember(undefined);
			// Nothing to update (never saw it open, or it was deleted): say so in a new post.
			if (!updated) await channel.send(liveStandaloneClosedPost(announcement));
		},

		async reconcile(snapshot) {
			const open = await findOpenPosts();
			// If the space is open now, the newest open post is the current one: keep it.
			const stale = snapshot.state === "open" ? open.slice(1) : open;
			for (const post of stale) await close(post, null);
			remember(snapshot.state === "open" ? open[0]?.id : undefined);
		},
	};
}

/** The state a single-style post shows, from its title. */
const singleState = (post: OwnPost): "open" | "closed" | undefined =>
	post.title === LIVE_OPEN_TITLE ? "open" : post.title === LIVE_CLOSED_TITLE ? "closed" : undefined;

const isSinglePost = (post: OwnPost): boolean =>
	post.footer === SINGLE_FOOTER && singleState(post) !== undefined;

/**
 * Single style: the channel only ever holds the current status. Each change posts
 * the new status first and then deletes the older ones, so the channel is never
 * left without a status if a delete fails (the next change tidies up again).
 *
 * At startup it corrects a post that is out of date (the space changed while Pixel
 * was down) by editing it, which posts nothing new, and removes any extras.
 */
export function createSinglePublisher(
	channel: AnnouncementChannel,
	logger: Logger,
	store: LivePostStore | undefined,
	id: string,
): Publisher {
	const log = logger.child({ publisher: id });
	const { findPosts, remember } = createPostTracker(channel, log, store, isSinglePost);

	/** Deletes posts, tolerating ones that are already gone. Returns whether all went. */
	async function removeAll(posts: readonly OwnPost[]): Promise<boolean> {
		let all = true;
		for (const post of posts) {
			try {
				await channel.delete(post.id);
			} catch (error) {
				all = false;
				log.warn(
					{ event: "announcer.single_delete_failed", err: error },
					"couldn't delete an old post",
				);
			}
		}
		return all;
	}

	return {
		id,

		async publish(announcement) {
			if (announcement.kind !== "space.status") return;
			// Look before sending, so the new post can't be mistaken for an old one.
			const previous = await findPosts();
			const sent = await channel.send(
				singlePost(announcement.state, announcement.at, announcement.openedAt),
			);
			remember(sent.id);
			await removeAll(previous);
		},

		async reconcile(snapshot) {
			const [latest, ...older] = await findPosts();
			if (!latest) return;
			await removeAll(older);
			if (singleState(latest) !== snapshot.state) {
				try {
					await channel.edit(latest.id, singlePost(snapshot.state, snapshot.since, null));
				} catch (error) {
					log.warn(
						{ event: "announcer.single_edit_failed", err: error },
						"couldn't correct the status post",
					);
				}
			}
			remember(latest.id);
		},
	};
}
