/**
 * What features announce, and what publishers (Discord channels, later
 * Mastodon, Telegram, …) receive. This is the platform-neutral contract between
 * the two, like `Reply`: features never see a platform, publishers decide how
 * to present each kind.
 */

/** Pixelbar opened or closed. */
export type SpaceStatusAnnouncement = {
	kind: "space.status";
	state: "open" | "closed";
	/** When Pixel saw the change. */
	at: Date;
	/** For "closed": when this stretch of being open began, if Pixel knew. */
	openedAt: Date | null;
	/** Short plain text for platforms without rich formatting, e.g. "🟢 Pixelbar is now open". */
	text: string;
};

/** Every kind of announcement. Add new kinds here. */
export type Announcement = SpaceStatusAnnouncement;

/** The space's state right now, as seen at startup. */
export type SpaceSnapshot = {
	state: "open" | "closed";
	since: Date | null;
};

export type Publisher = {
	/** Stable name, used in logs and error reports (e.g. "discord:live"). */
	id: string;
	publish(announcement: Announcement): Promise<void>;
	/**
	 * Called once at startup with the space's current state, so a publisher can
	 * correct anything it posted earlier that is now out of date (e.g. a post still
	 * saying "open"). It must not post new announcements.
	 */
	reconcile?(snapshot: SpaceSnapshot): Promise<void>;
};
