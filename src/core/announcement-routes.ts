import type { SpaceAnnounceStyle } from "./announcement.ts";
import { UserFacingError } from "./errors.ts";

/**
 * Where open/closed announcements go: pairings of a style and a channel that admins
 * manage while Pixel runs (`/admin announcements`). Features hand changes to the
 * core and never touch a platform; the Discord adapter plugs in a `RouteManager`
 * once it's connected, the same way it plugs in the calendar and channel posts.
 */

export type AnnouncementRoute = {
	style: SpaceAnnounceStyle;
	/** Platform channel ID. */
	channelId: string;
	/** `config` routes come from the environment and can't be changed here. */
	source: "config" | "admin";
	/** Why it isn't posting right now (the channel is gone, a permission is missing). Safe to show. */
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

export type RouteManager = {
	list(): readonly AnnouncementRoute[];
	/**
	 * Gives a channel a style. Throws a `UserFacingError` saying why when it can't (the
	 * channel is set in the environment, it can't be used, or the list is full).
	 */
	set(style: SpaceAnnounceStyle, channelId: string): Promise<RouteSet>;
	/** Stops announcing to a channel. Throws a `UserFacingError` for one set in the environment. */
	remove(channelId: string): Promise<RouteRemove>;
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

	#require(): RouteManager {
		if (!this.#manager) throw new AnnouncementRoutesUnavailableError(ROUTES_UNAVAILABLE);
		return this.#manager;
	}
}
