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

/** What this copy of Pixel is. */
export type BuildInfo = {
	/** The package version, such as "0.1.0". */
	version: string;
	/** The short git commit, when known. */
	commit: string | undefined;
	/** The git branch, when known. */
	branch: string | undefined;
	/** "local", "dev" or "prod". */
	env: string;
	/** "local" on a laptop, "cloud" on Azure. */
	runtime: "local" | "cloud";
};

/** One line of "how is Pixel doing", such as Home Assistant being connected. */
export type StatusCheck = {
	name: string;
	state: "ok" | "warn";
	/** Short and public: shown in the channel. */
	detail: string;
};

/** Pixel itself came online, or is going offline. */
export type BotStatusAnnouncement = {
	kind: "bot.status";
	phase: "up" | "down";
	build: BuildInfo;
	/** When this run started. */
	startedAt: Date;
	/** When this was announced. */
	at: Date;
	/** How Pixel is doing (only for "up"). */
	checks: readonly StatusCheck[];
	/** Why it's going offline (only for "down"), such as "restarting". */
	reason?: string;
	/** Short plain text for platforms without rich formatting. */
	text: string;
};

/** Every kind of announcement. Add new kinds here. */
export type Announcement = SpaceStatusAnnouncement | BotStatusAnnouncement;

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
	 * saying "open"). It must not post new announcements. Only about the space.
	 */
	reconcile?(snapshot: SpaceSnapshot): Promise<void>;
};
