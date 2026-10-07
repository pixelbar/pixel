import { UserFacingError } from "./errors.ts";

/**
 * Posting to a channel someone picked, for scheduled posts. Features hand the core a
 * neutral post (a message or a poll) and never touch a platform. The Discord adapter
 * plugs in a `ChannelPoster` once it's connected, the same way it plugs in the
 * calendar.
 */

export type ChannelPost =
	| {
			kind: "message";
			text: string;
			/** Whether @everyone, @here and role mentions ping. Off unless the schedule allows it. */
			mentions: boolean;
	  }
	| {
			kind: "poll";
			question: string;
			answers: readonly string[];
			/** How long it stays open. */
			durationHours: number;
			/** Whether people may pick more than one answer. */
			multiple: boolean;
	  };

/** What the platform says about posting in a channel, or why Pixel can't. */
export type ChannelCheck = { ok: true; name: string } | { ok: false; problem: string };

export type ChannelPoster = {
	/** Whether Pixel can make this kind of post in the channel. */
	check(channelId: string, post: ChannelPost): Promise<ChannelCheck>;
	post(channelId: string, post: ChannelPost): Promise<void>;
};

export class ChannelPostsUnavailableError extends UserFacingError {
	override name = "ChannelPostsUnavailableError";
}

export const POSTS_UNAVAILABLE = "Posting isn't available right now. Try again in a minute.";

export class ChannelPosts {
	#poster: ChannelPoster | undefined;

	/** The adapter plugs its poster in once it's ready. */
	use(poster: ChannelPoster): void {
		this.#poster = poster;
	}

	get ready(): boolean {
		return this.#poster !== undefined;
	}

	check(channelId: string, post: ChannelPost): Promise<ChannelCheck> {
		return this.#require().check(channelId, post);
	}

	post(channelId: string, post: ChannelPost): Promise<void> {
		return this.#require().post(channelId, post);
	}

	#require(): ChannelPoster {
		if (!this.#poster) throw new ChannelPostsUnavailableError(POSTS_UNAVAILABLE);
		return this.#poster;
	}
}
