import type { SpaceAnnounceStyle } from "./announcement.ts";
import { UserFacingError } from "./errors.ts";

/**
 * Where open/closed and release announcements go: pairings of a style and a channel
 * for the space, and channels for new Pixel releases, that admins manage while Pixel
 * runs (`/admin` → Announcements). Features hand changes to the core and never touch
 * a platform; the Discord adapter plugs in a `RouteManager` once it's connected, the
 * same way it plugs in the calendar and channel posts.
 */

export type AnnouncementRoute = {
	style: SpaceAnnounceStyle;
	/** Platform channel ID. */
	channelId: string;
	/** Why it isn't posting right now (the channel is gone, a permission is missing). Safe to show. */
	problem?: string;
};

export type ReleaseChannel = {
	/** Platform channel ID. */
	channelId: string;
	/** Why it isn't posting right now. Safe to show. */
	problem?: string;
};

export type RouteSet = {
	/** `unchanged` when the channel already had this style. */
	result: "added" | "changed" | "unchanged";
	previous?: SpaceAnnounceStyle;
	/** False when it couldn't be saved: it holds until Pixel restarts. */
	saved: boolean;
};

export type RouteRemove = { removed: boolean; previous?: SpaceAnnounceStyle; saved: boolean };

export type ReleaseSet = {
	/** `unchanged` when the channel was already on the list. */
	result: "added" | "unchanged";
	saved: boolean;
};

export type ReleaseRemove = { removed: boolean; saved: boolean };

export type NotificationKind = "bot" | "closingTime" | "parking" | "foodAlert";

export type NotificationChannel = {
	kind: NotificationKind;
	channelId: string | undefined;
	/** Why it isn't posting right now. Safe to show. */
	problem?: string;
};

export type NotificationSet = {
	/** `unchanged` when the channel was already set to this. */
	result: "set" | "unchanged" | "cleared";
	/** The previous channel ID, if any. */
	previous?: string;
	saved: boolean;
};

export type RouteManager = {
	list(): readonly AnnouncementRoute[];
	/**
	 * Gives a channel a style. Throws a `UserFacingError` saying why when it can't (the
	 * channel can't be used, or the list is full).
	 */
	set(style: SpaceAnnounceStyle, channelId: string): Promise<RouteSet>;
	/** Stops announcing open/closed to a channel. */
	remove(channelId: string): Promise<RouteRemove>;
	listRelease(): readonly ReleaseChannel[];
	/**
	 * Posts new Pixel releases in a channel. Throws a `UserFacingError` when it can't
	 * (the channel can't be used, or the list is full).
	 */
	addRelease(channelId: string): Promise<ReleaseSet>;
	/** Stops posting releases in a channel. */
	removeRelease(channelId: string): Promise<ReleaseRemove>;
	/** Lists all notification channels (bot, closing time, parking, food alerts). */
	listNotifications(): readonly NotificationChannel[];
	/**
	 * Sets a notification channel. Pass undefined to clear it. Throws a `UserFacingError`
	 * when the channel can't be used.
	 */
	setNotification(kind: NotificationKind, channelId: string | undefined): Promise<NotificationSet>;
};

export class AnnouncementRoutesUnavailableError extends UserFacingError {
	override name = "AnnouncementRoutesUnavailableError";
}

export const ROUTES_UNAVAILABLE =
	"Announcements aren't available right now. Try again in a minute.";

export class AnnouncementRoutes {
	#manager: RouteManager | undefined;

	/** The adapter plugs its manager in once it's ready. */
	use(manager: RouteManager): void {
		this.#manager = manager;
	}

	get ready(): boolean {
		return this.#manager !== undefined;
	}

	list(): readonly AnnouncementRoute[] {
		return this.#require().list();
	}

	set(style: SpaceAnnounceStyle, channelId: string): Promise<RouteSet> {
		return this.#require().set(style, channelId);
	}

	remove(channelId: string): Promise<RouteRemove> {
		return this.#require().remove(channelId);
	}

	listRelease(): readonly ReleaseChannel[] {
		return this.#require().listRelease();
	}

	addRelease(channelId: string): Promise<ReleaseSet> {
		return this.#require().addRelease(channelId);
	}

	removeRelease(channelId: string): Promise<ReleaseRemove> {
		return this.#require().removeRelease(channelId);
	}

	listNotifications(): readonly NotificationChannel[] {
		return this.#require().listNotifications();
	}

	setNotification(kind: NotificationKind, channelId: string | undefined): Promise<NotificationSet> {
		return this.#require().setNotification(kind, channelId);
	}

	#require(): RouteManager {
		if (!this.#manager) throw new AnnouncementRoutesUnavailableError(ROUTES_UNAVAILABLE);
		return this.#manager;
	}
}
