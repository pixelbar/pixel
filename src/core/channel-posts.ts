import { UserFacingError } from "./errors.ts";

/**
 * Posting to a channel someone picked, for scheduled posts. Features hand the core a
 * neutral post (a message, a poll or an attendance poll) and never touch a platform. The Discord adapter
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
	  }
	| {
			/**
			 * Pixel's own poll, for "who's coming": a message with a button per answer, which
			 * Pixel counts itself (no winner, unlike a platform poll). See `AttendanceMessage`.
			 */
			kind: "attendance";
			question: string;
			answers: readonly AttendanceAnswer[];
			/** How long it stays open. */
			durationHours: number;
	  };

/** One answer of an attendance poll. */
export type AttendanceAnswer = {
	label: string;
	/** Whether picking it counts as coming, for the totals Pixel posts. */
	counts: boolean;
	/** Its button's colour. Unset means grey. */
	colour?: AttendanceColour;
};

/** The colours an attendance poll's buttons can be, grey first (the default). */
export const ATTENDANCE_COLOURS = ["grey", "blue", "green", "red"] as const;
export type AttendanceColour = (typeof ATTENDANCE_COLOURS)[number];

/**
 * An attendance poll as it's shown: text the feature wrote, and a button per answer
 * while it's open. The adapter draws the buttons so they carry only `pollId` and the
 * answer's position, and every click runs `ATTEND_ACTION` through the dispatcher.
 */
export type AttendanceMessage = {
	/** Pixel's random ID for the poll (12 lowercase hex). Not a secret, and nothing personal. */
	pollId: string;
	/** Markdown. Mentions never ping. */
	text: string;
	/** Button labels, in order. */
	answers: readonly string[];
	/** Each button's colour, by position. Missing ones are grey. */
	colours?: readonly AttendanceColour[];
	/** False once it has closed: the buttons go. */
	open: boolean;
};

/** The action every attendance button runs, for whoever clicked it. */
export const ATTEND_ACTION = "schedule.attend";

/** At most this many answers on an attendance poll: one row of buttons. */
export const MAX_ATTENDANCE_ANSWERS = 5;

/** A post the platform has sent: a link people can follow to it, and its ID there. */
export type PostedMessage = { url: string; messageId: string };

/** How a post is sent, besides what it says. */
export type PostOptions = {
	/**
	 * A message in the same channel to post it as a reply to. If that message has gone,
	 * the post still goes out, just not as a reply.
	 */
	replyTo?: string;
};

/** What the platform says about posting in a channel, or why Pixel can't. */
export type ChannelCheck = { ok: true; name: string } | { ok: false; problem: string };

export type ChannelPoster = {
	/** Whether Pixel can make this kind of post in the channel. */
	check(channelId: string, post: ChannelPost): Promise<ChannelCheck>;
	post(channelId: string, post: ChannelPost, options?: PostOptions): Promise<PostedMessage>;
	/** Posts an attendance poll's message. */
	postAttendance(channelId: string, message: AttendanceMessage): Promise<PostedMessage>;
	/** Replaces an attendance poll's message, to show new totals or that it has closed. */
	editAttendance(channelId: string, messageId: string, message: AttendanceMessage): Promise<void>;
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

	post(channelId: string, post: ChannelPost, options?: PostOptions): Promise<PostedMessage> {
		return this.#require().post(channelId, post, options);
	}

	postAttendance(channelId: string, message: AttendanceMessage): Promise<PostedMessage> {
		return this.#require().postAttendance(channelId, message);
	}

	editAttendance(channelId: string, messageId: string, message: AttendanceMessage): Promise<void> {
		return this.#require().editAttendance(channelId, messageId, message);
	}

	#require(): ChannelPoster {
		if (!this.#poster) throw new ChannelPostsUnavailableError(POSTS_UNAVAILABLE);
		return this.#poster;
	}
}
