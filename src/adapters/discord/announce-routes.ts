import { join } from "node:path";
import type { SpaceAnnounceStyle } from "../../core/announcement.ts";
import type {
	AnnouncementRoute,
	NotificationChannel,
	NotificationKind,
	NotificationSet,
	ReleaseChannel,
	ReleaseRemove,
	ReleaseSet,
	RouteManager,
	RouteRemove,
	RouteSet,
} from "../../core/announcement-routes.ts";
import type { Announcer } from "../../core/announcer.ts";
import { UserFacingError } from "../../core/errors.ts";
import type { Logger } from "../../core/logger.ts";
import type { AnnouncementRouteStore } from "../../services/announcement-routes.ts";
import { LIVE_PERMISSIONS, type OpenedChannel, TIMELINE_PERMISSIONS } from "./announce-channel.ts";
import {
	createLivePublisher,
	createSinglePublisher,
	createTimelinePublisher,
} from "./announce-publishers.ts";
import type { Recheckable } from "./announce-recheck.ts";
import { FileLivePostStore } from "./announce-state.ts";
import { createReleasePublisher, releasePublisherId } from "./release-publisher.ts";

/** The id a route's publisher registers under, such as `discord:single:123…`. */
export const routePublisherId = (style: SpaceAnnounceStyle, channelId: string): string =>
	`discord:${style}:${channelId}`;

/** What the bot needs in a channel for a style. Live and single read history to find their own posts. */
export const requiredPermissions = (style: SpaceAnnounceStyle): readonly bigint[] =>
	style === "timeline" ? TIMELINE_PERMISSIONS : LIVE_PERMISSIONS;

/** Why a route isn't posting, as `/admin` → Announcements shows it. */
const cantAnnounce = (problem: string): string => `I can't announce in that channel: ${problem}.`;

export type DiscordRoutesOptions = {
	store: Pick<
		AnnouncementRouteStore,
		| "list"
		| "canAdd"
		| "set"
		| "remove"
		| "listRelease"
		| "canAddRelease"
		| "addRelease"
		| "removeRelease"
		| "getNotifications"
		| "setNotification"
	>;
	announcer: Pick<Announcer, "register" | "unregister">;
	logger: Logger;
	reportError: (error: unknown) => void;
	/** Where each live or single route remembers its current post. */
	postsDir: string;
	/** Opens a channel and checks the bot can use it. */
	openChannel: (channelId: string, required: readonly bigint[]) => Promise<OpenedChannel>;
	/** Creates a bot status publisher for a channel. */
	createBotStatusPublisher: (
		channel: Extract<OpenedChannel, { ok: true }>["channel"],
		channelId: string,
	) => Publisher;
	/** Creates a closing time publisher for a channel. */
	createClosingTimePublisher: (channel: Extract<OpenedChannel, { ok: true }>["channel"]) => Publisher;
};

/**
 * The Discord side of `/admin` → Announcements: turns the saved (style, channel)
 * pairings and release channels into publishers on the announcer, and starts and
 * stops them as admins change them. A route whose channel can't be used (deleted,
 * missing permissions) stays on the list with the reason, and `retry` tries it
 * again, so fixing the channel brings it back.
 */
export class DiscordAnnouncementRoutes implements RouteManager, Recheckable {
	readonly #options: DiscordRoutesOptions;
	readonly #logger: Logger;
	/** Why a saved open/closed route isn't posting, by channel. */
	readonly #problems = new Map<string, string>();
	/** Why a saved release channel isn't posting, by channel. */
	readonly #releaseProblems = new Map<string, string>();
	/** Why a saved notification channel isn't posting, by kind. */
	readonly #notificationProblems = new Map<NotificationKind, string>();

	constructor(options: DiscordRoutesOptions) {
		this.#options = options;
		this.#logger = options.logger.child({ component: "announcement-routes" });
	}

	/** Starts every saved route, release channel and notification channel. One bad channel never stops the others. */
	async start(): Promise<void> {
		for (const route of this.#options.store.list()) {
			try {
				await this.#activate(route.style, route.channelId);
			} catch (error) {
				const problem = error instanceof UserFacingError ? error.message : "it couldn't be set up";
				this.#problems.set(route.channelId, problem);
				this.#logger.error(
					{ event: "announcements.route_off", ...route, err: error },
					`announcements to a ${route.style} channel are off`,
				);
				this.#options.reportError(
					new Error(`Announcements (${route.style}) to ${route.channelId} are off: ${problem}`),
				);
			}
		}
		for (const channelId of this.#options.store.listRelease()) {
			try {
				await this.#activateRelease(channelId);
			} catch (error) {
				const problem = error instanceof UserFacingError ? error.message : "it couldn't be set up";
				this.#releaseProblems.set(channelId, problem);
				this.#logger.error(
					{ event: "announcements.release_off", channelId, err: error },
					"release announcements to a channel are off",
				);
				this.#options.reportError(
					new Error(`Release announcements to ${channelId} are off: ${problem}`),
				);
			}
		}
		// Start notification channel publishers
		const notifications = this.#options.store.getNotifications();
		if (notifications.bot) {
			try {
				await this.#activateBotStatus(notifications.bot);
			} catch (error) {
				const problem = error instanceof UserFacingError ? error.message : "it couldn't be set up";
				this.#notificationProblems.set("bot", problem);
				this.#logger.error(
					{ event: "announcements.bot_status_off", channelId: notifications.bot, err: error },
					"bot status announcements are off",
				);
				this.#options.reportError(
					new Error(`Bot status announcements to ${notifications.bot} are off: ${problem}`),
				);
			}
		}
		if (notifications.closingTime) {
			try {
				await this.#activateClosingTime(notifications.closingTime);
			} catch (error) {
				const problem = error instanceof UserFacingError ? error.message : "it couldn't be set up";
				this.#notificationProblems.set("closingTime", problem);
				this.#logger.error(
					{ event: "announcements.closing_time_off", channelId: notifications.closingTime, err: error },
					"closing time announcements are off",
				);
				this.#options.reportError(
					new Error(`Closing time announcements to ${notifications.closingTime} are off: ${problem}`),
				);
			}
		}
	}

	list(): readonly AnnouncementRoute[] {
		return this.#options.store.list().map((r): AnnouncementRoute => {
			const problem = this.#problems.get(r.channelId);
			return { ...r, ...(problem ? { problem } : {}) };
		});
	}

	listRelease(): readonly ReleaseChannel[] {
		return this.#options.store.listRelease().map((channelId): ReleaseChannel => {
			const problem = this.#releaseProblems.get(channelId);
			return { channelId, ...(problem ? { problem } : {}) };
		});
	}

	async set(style: SpaceAnnounceStyle, channelId: string): Promise<RouteSet> {
		const current = this.#options.store.list().find((r) => r.channelId === channelId);
		if (!current && !this.#options.store.canAdd(channelId)) {
			throw new UserFacingError(
				"There are too many announcement channels already. Remove one first.",
			);
		}
		// Open the channel before changing anything, so a bad one leaves things as they were.
		await this.#activate(style, channelId, current?.style);
		this.#problems.delete(channelId);
		const { saved } = this.#options.store.set({ style, channelId });
		this.#logger.info(
			{ event: "announcements.route_set", style, channelId, previous: current?.style, saved },
			"announcement route set",
		);
		return {
			result: !current ? "added" : current.style === style ? "unchanged" : "changed",
			...(current ? { previous: current.style } : {}),
			saved,
		};
	}

	async remove(channelId: string): Promise<RouteRemove> {
		const current = this.#options.store.list().find((r) => r.channelId === channelId);
		if (!current) return { removed: false, saved: true };
		this.#options.announcer.unregister(routePublisherId(current.style, channelId));
		this.#problems.delete(channelId);
		const { saved } = this.#options.store.remove(channelId);
		this.#logger.info(
			{ event: "announcements.route_removed", style: current.style, channelId, saved },
			"announcement route removed",
		);
		return { removed: true, previous: current.style, saved };
	}

	async addRelease(channelId: string): Promise<ReleaseSet> {
		const current = this.#options.store.listRelease().includes(channelId);
		if (!current && !this.#options.store.canAddRelease(channelId)) {
			throw new UserFacingError("There are too many release channels already. Remove one first.");
		}
		await this.#activateRelease(channelId);
		this.#releaseProblems.delete(channelId);
		const { saved } = this.#options.store.addRelease(channelId);
		this.#logger.info(
			{
				event: "announcements.release_set",
				channelId,
				result: current ? "unchanged" : "added",
				saved,
			},
			"release channel set",
		);
		return { result: current ? "unchanged" : "added", saved };
	}

	async removeRelease(channelId: string): Promise<ReleaseRemove> {
		if (!this.#options.store.listRelease().includes(channelId)) {
			return { removed: false, saved: true };
		}
		this.#options.announcer.unregister(releasePublisherId(channelId));
		this.#releaseProblems.delete(channelId);
		const { saved } = this.#options.store.removeRelease(channelId);
		this.#logger.info(
			{ event: "announcements.release_removed", channelId, saved },
			"release channel removed",
		);
		return { removed: true, saved };
	}

	listNotifications(): readonly NotificationChannel[] {
		const notifications = this.#options.store.getNotifications();
		const kinds: NotificationKind[] = ["bot", "closingTime", "parking", "foodAlert"];
		return kinds.map((kind): NotificationChannel => {
			const channelId = notifications[kind];
			const problem = this.#notificationProblems.get(kind);
			return { kind, channelId, ...(problem ? { problem } : {}) };
		});
	}

	async setNotification(
		kind: NotificationKind,
		channelId: string | undefined,
	): Promise<NotificationSet> {
		const current = this.#options.store.getNotifications()[kind];
		// Validate and activate the channel if one is being set
		if (channelId !== undefined) {
			// Validate the channel first
			if (kind === "bot") {
				await this.#activateBotStatus(channelId);
			} else if (kind === "closingTime") {
				await this.#activateClosingTime(channelId);
			} else {
				// For parking and foodAlert, just validate permissions
				const opened = await this.#options.openChannel(channelId, TIMELINE_PERMISSIONS);
				if (!opened.ok) throw new UserFacingError(cantAnnounce(opened.problem));
			}
		} else {
			// Clearing: unregister the publisher
			if (kind === "bot") {
				this.#options.announcer.unregister("discord:bot-status");
			} else if (kind === "closingTime") {
				this.#options.announcer.unregister("discord:closing-time");
			}
		}
		this.#notificationProblems.delete(kind);
		const { saved } = this.#options.store.setNotification(kind, channelId);
		this.#logger.info(
			{
				event: "announcements.notification_set",
				kind,
				channelId,
				previous: current,
				saved,
			},
			"notification channel set",
		);
		return {
			result: channelId === undefined ? "cleared" : current === channelId ? "unchanged" : "set",
			...(current ? { previous: current } : {}),
			saved,
		};
	}

	hasProblems(): boolean {
		return (
			this.#problems.size > 0 ||
			this.#releaseProblems.size > 0 ||
			this.#notificationProblems.size > 0
		);
	}

	/** Tries every saved route that isn't posting again. Says so only when that changes. */
	async retry(): Promise<void> {
		for (const route of this.#options.store.list()) {
			const before = this.#problems.get(route.channelId);
			if (!before) continue;
			const opened = await this.#options.openChannel(
				route.channelId,
				requiredPermissions(route.style),
			);
			// An admin may have set or removed it while the channel was opening: theirs wins.
			const now = this.#options.store.list().find((r) => r.channelId === route.channelId);
			if (now?.style !== route.style || this.#problems.get(route.channelId) !== before) continue;
			if (opened.ok) {
				this.#problems.delete(route.channelId);
				this.#register(route.style, route.channelId, opened.channel);
				this.#logger.info(
					{ event: "announcements.route_on", ...route },
					`announcements to a ${route.style} channel are on again`,
				);
				continue;
			}
			const problem = cantAnnounce(opened.problem);
			if (problem === before) continue;
			this.#problems.set(route.channelId, problem);
			this.#logger.error(
				{ event: "announcements.route_off", ...route },
				`announcements to a ${route.style} channel are off`,
			);
			this.#options.reportError(
				new Error(`Announcements (${route.style}) to ${route.channelId} are off: ${problem}`),
			);
		}
		for (const channelId of this.#options.store.listRelease()) {
			const before = this.#releaseProblems.get(channelId);
			if (!before) continue;
			const opened = await this.#options.openChannel(channelId, TIMELINE_PERMISSIONS);
			if (!this.#options.store.listRelease().includes(channelId)) continue;
			if (this.#releaseProblems.get(channelId) !== before) continue;
			if (opened.ok) {
				this.#releaseProblems.delete(channelId);
				this.#registerRelease(channelId, opened.channel);
				this.#logger.info(
					{ event: "announcements.release_on", channelId },
					"release announcements to a channel are on again",
				);
				continue;
			}
			const problem = cantAnnounce(opened.problem);
			if (problem === before) continue;
			this.#releaseProblems.set(channelId, problem);
			this.#logger.error(
				{ event: "announcements.release_off", channelId },
				"release announcements to a channel are off",
			);
			this.#options.reportError(
				new Error(`Release announcements to ${channelId} are off: ${problem}`),
			);
		}
	}

	/** Opens the channel and registers its publisher, replacing the one it had (if any). */
	async #activate(
		style: SpaceAnnounceStyle,
		channelId: string,
		previous?: SpaceAnnounceStyle,
	): Promise<void> {
		const opened = await this.#options.openChannel(channelId, requiredPermissions(style));
		if (!opened.ok) throw new UserFacingError(cantAnnounce(opened.problem));
		this.#register(style, channelId, opened.channel, previous);
	}

	async #activateRelease(channelId: string): Promise<void> {
		const opened = await this.#options.openChannel(channelId, TIMELINE_PERMISSIONS);
		if (!opened.ok) throw new UserFacingError(cantAnnounce(opened.problem));
		this.#registerRelease(channelId, opened.channel);
	}

	#register(
		style: SpaceAnnounceStyle,
		channelId: string,
		channel: Extract<OpenedChannel, { ok: true }>["channel"],
		previous?: SpaceAnnounceStyle,
	): void {
		const id = routePublisherId(style, channelId);
		if (previous) this.#options.announcer.unregister(routePublisherId(previous, channelId));
		this.#options.announcer.unregister(id);
		this.#options.announcer.register(this.#publisher(style, channelId, channel, id));
	}

	#registerRelease(
		channelId: string,
		channel: Extract<OpenedChannel, { ok: true }>["channel"],
	): void {
		const id = releasePublisherId(channelId);
		this.#options.announcer.unregister(id);
		this.#options.announcer.register(createReleasePublisher(channel, this.#options.logger, id));
	}

	#publisher(
		style: SpaceAnnounceStyle,
		channelId: string,
		channel: Extract<OpenedChannel, { ok: true }>["channel"],
		id: string,
	) {
		const store = () =>
			new FileLivePostStore(join(this.#options.postsDir, `${style}-${channelId}.state`), channelId);
		switch (style) {
			case "timeline":
				return createTimelinePublisher(channel, id);
			case "live":
				return createLivePublisher(channel, this.#options.logger, store(), id);
			case "single":
				return createSinglePublisher(channel, this.#options.logger, store(), id);
		}
	}

	async #activateBotStatus(channelId: string): Promise<void> {
		const opened = await this.#options.openChannel(channelId, LIVE_PERMISSIONS);
		if (!opened.ok) throw new UserFacingError(cantAnnounce(opened.problem));
		this.#options.announcer.unregister("discord:bot-status");
		this.#options.announcer.register(this.#options.createBotStatusPublisher(opened.channel, channelId));
	}

	async #activateClosingTime(channelId: string): Promise<void> {
		const opened = await this.#options.openChannel(channelId, TIMELINE_PERMISSIONS);
		if (!opened.ok) throw new UserFacingError(cantAnnounce(opened.problem));
		this.#options.announcer.unregister("discord:closing-time");
		this.#options.announcer.register(this.#options.createClosingTimePublisher(opened.channel));
	}
}
