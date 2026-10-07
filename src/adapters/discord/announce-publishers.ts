import type { Publisher } from "../../core/announcement.ts";
import type { Logger } from "../../core/logger.ts";
import {
	type AnnouncementPost,
	LIVE_OPEN_FOOTER,
	LIVE_OPEN_TITLE,
	liveClosedPost,
	liveOpenPost,
	liveStandaloneClosedPost,
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
export function createTimelinePublisher(channel: AnnouncementChannel): Publisher {
	return {
		id: TIMELINE_PUBLISHER_ID,
		async publish(announcement) {
			// Only the space's own changes belong in a timeline channel.
			if (announcement.kind !== "space.status") return;
			await channel.send(timelinePost(announcement));
		},
	};
}

const newestFirst = (a: OwnPost, b: OwnPost): number =>
	(b.timestamp?.getTime() ?? 0) - (a.timestamp?.getTime() ?? 0);

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
): Publisher {
	const log = logger.child({ publisher: LIVE_PUBLISHER_ID });

	const isOpenPost = (post: OwnPost): boolean =>
		post.title === LIVE_OPEN_TITLE && post.footer === LIVE_OPEN_FOOTER;

	/** The post the store remembers, if it still exists and still says "open". */
	async function rememberedOpenPost(): Promise<OwnPost | undefined> {
		try {
			const id = store?.load();
			if (!id) return undefined;
			const post = await channel.findOwnPost(id);
			return post && isOpenPost(post) ? post : undefined;
		} catch (error) {
			log.warn(
				{ event: "announcer.live_hint_failed", err: error },
				"couldn't use the remembered post",
			);
			return undefined;
		}
	}

	/** Open posts among the channel's recent messages. Best effort: unreadable history means none. */
	async function recentOpenPosts(): Promise<OwnPost[]> {
		try {
			return (await channel.recentOwnPosts(RECENT_POSTS)).filter(isOpenPost);
		} catch (error) {
			log.warn(
				{ event: "announcer.live_history_failed", err: error },
				"couldn't read recent posts",
			);
			return [];
		}
	}

	/** Pixel's posts that currently say "open", newest first. */
	async function findOpenPosts(): Promise<OwnPost[]> {
		const posts = new Map<string, OwnPost>();
		const remembered = await rememberedOpenPost();
		if (remembered) posts.set(remembered.id, remembered);
		for (const post of await recentOpenPosts()) posts.set(post.id, post);
		return [...posts.values()].sort(newestFirst);
	}

	/** Remembers which post is open now (or none). Failing to save is never fatal. */
	function remember(messageId: string | undefined): void {
		try {
			store?.save(messageId);
		} catch (error) {
			log.warn(
				{ event: "announcer.live_state_failed", err: error },
				"couldn't remember the open post",
			);
		}
	}

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
		id: LIVE_PUBLISHER_ID,

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
