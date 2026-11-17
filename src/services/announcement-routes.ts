import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { SPACE_ANNOUNCE_STYLES, type SpaceAnnounceStyle } from "../core/announcement.ts";
import type { Logger } from "../core/logger.ts";

/**
 * Where open/closed and release announcements go, as admins set it with `/admin`
 * → Announcements: (style, channel) pairings for the space, and a list of channels
 * for new Pixel releases, kept in `data/announcement-routes.yaml` so it survives a
 * restart and a deploy. A channel has at most one open/closed style; the same
 * channel may also get release posts.
 *
 * It only says what to post where; who may change it is decided by the dispatcher
 * (admins). If the file can't be read, announcements through it are simply off
 * until an admin sets them again, which rewrites it. That is logged.
 */

export const MAX_ROUTES = 25;

export type StoredRoute = { style: SpaceAnnounceStyle; channelId: string };

export type NotificationChannels = {
	/** Bot online/offline status. */
	bot?: string;
	/** Closing time reminders. */
	closingTime?: string;
	/** Parking activity (admin-only). */
	parking?: string;
	/** Food out-of-stock alerts (admin-only). */
	foodAlert?: string;
};

export type RouteSave = { saved: boolean };

// IDs are strings: as YAML numbers they'd silently lose precision.
const snowflake = z.string().regex(/^\d{17,20}$/);
const fileSchema = z.strictObject({
	routes: z
		.array(z.strictObject({ style: z.enum(SPACE_ANNOUNCE_STYLES), channelId: snowflake }))
		.max(MAX_ROUTES),
	// Older files have only `routes`; treat a missing list as empty.
	releaseChannels: z.array(snowflake).max(MAX_ROUTES).optional().default([]),
	// Notification channels (bot status, closing time, parking, food alerts). All optional.
	notifications: z
		.strictObject({
			bot: snowflake.optional(),
			closingTime: snowflake.optional(),
			parking: snowflake.optional(),
			foodAlert: snowflake.optional(),
		})
		.optional()
		.default({}),
});

const HEADER =
	"# Where Pixel posts open/closed and release announcements (/admin → Announcements). Written by Pixel.\n";

export class AnnouncementRouteStore {
	readonly #file: string | undefined;
	readonly #logger: Logger;
	#routes: StoredRoute[] = [];
	#releaseChannels: string[] = [];
	#notifications: NotificationChannels = {};

	constructor(options: { file?: string; logger: Logger }) {
		this.#file = options.file;
		this.#logger = options.logger.child({ component: "announcement-routes" });
		this.#load();
	}

	list(): readonly StoredRoute[] {
		return this.#routes;
	}

	listRelease(): readonly string[] {
		return this.#releaseChannels;
	}

	/** Get notification channels (bot, closing time, parking, food alerts). */
	getNotifications(): Readonly<NotificationChannels> {
		return { ...this.#notifications };
	}

	/** Whether another open/closed channel fits (replacing a channel's style always does). */
	canAdd(channelId: string): boolean {
		return this.#routes.length < MAX_ROUTES || this.#routes.some((r) => r.channelId === channelId);
	}

	/** Whether another release channel fits (one already on the list always does). */
	canAddRelease(channelId: string): boolean {
		return this.#releaseChannels.length < MAX_ROUTES || this.#releaseChannels.includes(channelId);
	}

	/** Gives a channel a style (replacing any it had). `saved: false` when it can't be written. */
	set(route: StoredRoute): RouteSave {
		const next = this.#routes.filter((r) => r.channelId !== route.channelId);
		next.push(route);
		return this.#write(next, this.#releaseChannels, this.#notifications);
	}

	/** Takes an open/closed channel off the list. */
	remove(channelId: string): RouteSave {
		return this.#write(
			this.#routes.filter((r) => r.channelId !== channelId),
			this.#releaseChannels,
			this.#notifications,
		);
	}

	/** Adds a release channel (no-op if it was already there). */
	addRelease(channelId: string): RouteSave {
		if (this.#releaseChannels.includes(channelId)) {
			return this.#write(this.#routes, this.#releaseChannels, this.#notifications);
		}
		return this.#write(this.#routes, [...this.#releaseChannels, channelId], this.#notifications);
	}

	/** Takes a release channel off the list. */
	removeRelease(channelId: string): RouteSave {
		return this.#write(
			this.#routes,
			this.#releaseChannels.filter((id) => id !== channelId),
			this.#notifications,
		);
	}

	/** Sets a notification channel. Pass undefined to clear it. */
	setNotification(
		kind: keyof NotificationChannels,
		channelId: string | undefined,
	): RouteSave {
		const next = { ...this.#notifications, [kind]: channelId };
		// Remove undefined values to keep the file clean
		if (channelId === undefined) delete next[kind];
		return this.#write(this.#routes, this.#releaseChannels, next);
	}

	#load(): void {
		if (!this.#file) return;
		let source: string;
		try {
			source = readFileSync(this.#file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.#unreadable("unreadable");
			return;
		}
		try {
			const result = fileSchema.safeParse(parse(source));
			if (!result.success) {
				this.#unreadable("invalid");
				return;
			}
			this.#routes = result.data.routes;
			this.#releaseChannels = result.data.releaseChannels;
			this.#notifications = result.data.notifications;
		} catch {
			this.#unreadable("invalid");
		}
	}

	#unreadable(why: string): void {
		this.#logger.error(
			{ event: "announcements.routes_unreadable", why },
			"couldn't read the announcement routes file, so announcements through it are off until an admin sets them again",
		);
	}

	#write(
		next: StoredRoute[],
		releaseChannels: string[],
		notifications: NotificationChannels,
	): RouteSave {
		// Held in memory either way, so a failed save still works until a restart.
		this.#routes = next;
		this.#releaseChannels = releaseChannels;
		this.#notifications = notifications;
		if (!this.#file) return { saved: true };
		try {
			mkdirSync(dirname(this.#file), { recursive: true });
			// Write to a temp file and rename, so a crash can't leave a half-written file.
			const temp = `${this.#file}.tmp`;
			// Remove empty notifications object to keep the file clean
			const data: {
				routes: StoredRoute[];
				releaseChannels: string[];
				notifications?: NotificationChannels;
			} = { routes: next, releaseChannels };
			if (Object.keys(notifications).length > 0) {
				data.notifications = notifications;
			}
			writeFileSync(temp, HEADER + stringify(data));
			renameSync(temp, this.#file);
			return { saved: true };
		} catch (error) {
			this.#logger.error(
				{ event: "announcements.routes_save_failed", err: error },
				"couldn't save the announcement routes",
			);
			return { saved: false };
		}
	}
}
