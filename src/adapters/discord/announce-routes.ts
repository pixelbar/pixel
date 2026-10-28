import { join } from "node:path";
import type { SpaceAnnounceStyle } from "../../core/announcement.ts";
import type {
	AnnouncementRoute,
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

/** The id a route's publisher registers under, such as `discord:single:123…`. */
export const routePublisherId = (style: SpaceAnnounceStyle, channelId: string): string =>
	`discord:${style}:${channelId}`;

/** What the bot needs in a channel for a style. Live and single read history to find their own posts. */
export const requiredPermissions = (style: SpaceAnnounceStyle): readonly bigint[] =>
	style === "timeline" ? TIMELINE_PERMISSIONS : LIVE_PERMISSIONS;

/** Why a route isn't posting, as `/admin announcements` shows it. */
const cantAnnounce = (problem: string): string => `I can't announce in that channel: ${problem}.`;

export type DiscordRoutesOptions = {
	store: Pick<AnnouncementRouteStore, "list" | "canAdd" | "set" | "remove">;
	announcer: Pick<Announcer, "register" | "unregister">;
	logger: Logger;
	reportError: (error: unknown) => void;
	/** Where each live or single route remembers its current post. */
	postsDir: string;
	/** Opens a channel and checks the bot can use it. */
	openChannel: (channelId: string, required: readonly bigint[]) => Promise<OpenedChannel>;
};

/**
 * The Discord side of `/admin announcements`: turns the saved (style, channel)
 * pairings into publishers on the announcer, and starts and stops them as admins
 * change them. A route whose channel can't be used (deleted, missing permissions)
 * stays on the list with the reason, and `retry` tries it again, so fixing the
 * channel brings it back.
 */
export class DiscordAnnouncementRoutes implements RouteManager, Recheckable {
	readonly #options: DiscordRoutesOptions;
	readonly #logger: Logger;
	/** Why a saved route isn't posting, by channel. */
	readonly #problems = new Map<string, string>();

	constructor(options: DiscordRoutesOptions) {
		this.#options = options;
		this.#logger = options.logger.child({ component: "announcement-routes" });
	}

	/** Starts every saved route. One bad channel never stops the others. */
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
	}

	list(): readonly AnnouncementRoute[] {
		return this.#options.store.list().map((r): AnnouncementRoute => {
			const problem = this.#problems.get(r.channelId);
			return { ...r, ...(problem ? { problem } : {}) };
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

	hasProblems(): boolean {
		return this.#problems.size > 0;
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
}
