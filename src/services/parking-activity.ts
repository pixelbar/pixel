import type { ChannelPosts } from "../core/channel-posts.ts";
import { escapeMarkdown } from "../core/format.ts";
import type { Logger } from "../core/logger.ts";
import type { ErrorReporter } from "../core/ports/error-reporter.ts";
import { describeInstant } from "./parking-time.ts";

/**
 * Every parking change, for admins to watch: a short post in the parking channel
 * (`DISCORD_PARKING_CHANNEL_ID`, off when unset) and a `pixel.parking` count in Sentry,
 * so how often parking is used can be charted. Posts go through the core
 * `ChannelPosts` with mentions off; people's names are escaped. The metric carries the
 * kind of event and the spot, never a person. Recording never throws.
 */

/** Someone who parked or changed something: a name for humans. Act on IDs elsewhere. */
type Name = string;

export type ParkingActivityEvent =
	| { kind: "booked"; spot: string; who: Name; until: Date }
	/** `/park` found nothing free for that long. */
	| { kind: "none-free"; who: Name }
	| { kind: "left"; spot: string; who: Name }
	| { kind: "extended"; spot: string; who: Name; until: Date }
	/** Pixel ended it: their time was up (`over`), or the daily reset. */
	| { kind: "ended"; spot: string; who: Name; reason: "over" | "reset" }
	/** Their spot was taken by someone else and Pixel moved them to another. */
	| { kind: "moved"; from: string; to: string; who: Name; closedUntil: Date }
	/** Their spot was taken by someone else and nothing else was free: they were asked to leave. */
	| { kind: "taken"; spot: string; who: Name; closedUntil: Date }
	/** An admin ended someone's booking: `free`, or a change that cut into it (`evicted`). */
	| { kind: "freed" | "evicted"; spot: string; who: Name; admin: Name }
	/**
	 * An admin changed the spots, their opening times or the settings. `text` is what
	 * they did, written by Pixel from validated names and times ("opened neighbour-1
	 * until 17:00").
	 */
	| { kind: "admin"; action: AdminAction; admin: Name; text: string };

export type AdminAction =
	| "spot-added"
	| "spot-edited"
	| "spot-removed"
	| "opened"
	| "closed"
	| "settings";

export type ParkingActivityOptions = {
	posts: Pick<ChannelPosts, "post">;
	/** The parking channel. Undefined: nothing is posted, but it's still counted. */
	channelId: string | undefined;
	reporter: Pick<ErrorReporter, "count">;
	logger: Logger;
	timezone: string;
};

/** What the parking channel says about an event. */
export function activityText(event: ParkingActivityEvent, now: Date, zone: string): string {
	const at = (d: Date) => describeInstant(d, now, zone);
	const who = (name: Name) => `**${escapeMarkdown(name) || "Someone"}**`;
	const spot = (name: string) => `**${name}**`;
	switch (event.kind) {
		case "booked":
			return `${who(event.who)} parked in ${spot(event.spot)} until about ${at(event.until)}.`;
		case "none-free":
			return `${who(event.who)} asked to park, but nothing was free for that long.`;
		case "left":
			return `${who(event.who)} left ${spot(event.spot)}.`;
		case "extended":
			return `${who(event.who)} extended ${spot(event.spot)} until about ${at(event.until)}.`;
		case "ended":
			return event.reason === "over"
				? `Pixel ended ${who(event.who)}'s parking in ${spot(event.spot)}: their time was up.`
				: `Pixel ended ${who(event.who)}'s parking in ${spot(event.spot)} at the daily reset.`;
		case "moved":
			return `⚠️ ${who(event.who)} reported ${spot(event.from)} taken by someone else. Pixel moved them to ${spot(event.to)} and closed ${spot(event.from)} until ${at(event.closedUntil)}.`;
		case "taken":
			return `⚠️ ${who(event.who)} reported ${spot(event.spot)} taken by someone else, and no other spot was free, so they were asked to leave. ${spot(event.spot)} is closed until ${at(event.closedUntil)}. Please look into it.`;
		case "freed":
			return `${who(event.admin)} ended ${who(event.who)}'s booking in ${spot(event.spot)}.`;
		case "evicted":
			return `${who(event.admin)} changed ${spot(event.spot)}, which ended ${who(event.who)}'s booking there.`;
		case "admin":
			return `${who(event.admin)} ${event.text}`;
	}
}

/** The metric's attributes: what happened and where, never who. */
export function activityAttributes(event: ParkingActivityEvent): Record<string, string> {
	switch (event.kind) {
		case "none-free":
			return { event: event.kind };
		case "ended":
			return { event: event.kind, reason: event.reason, spot: event.spot };
		case "moved":
			return { event: event.kind, spot: event.from, to: event.to };
		case "admin":
			return { event: event.kind, action: event.action };
		default:
			return { event: event.kind, spot: event.spot };
	}
}

export class ParkingActivity {
	readonly #options: ParkingActivityOptions;
	readonly #logger: Logger;

	constructor(options: ParkingActivityOptions) {
		this.#options = options;
		this.#logger = options.logger.child({ component: "parking" });
	}

	/** Whether there's a parking channel to post to. */
	get posting(): boolean {
		return this.#options.channelId !== undefined;
	}

	/**
	 * Counts the event and posts it to the parking channel. True when it was posted.
	 * A failure is logged (never the text) and never thrown.
	 */
	async record(event: ParkingActivityEvent, now: Date): Promise<boolean> {
		this.#options.reporter.count?.("pixel.parking", activityAttributes(event));
		const channelId = this.#options.channelId;
		if (!channelId) return false;
		try {
			await this.#options.posts.post(channelId, {
				kind: "message",
				text: activityText(event, now, this.#options.timezone),
				mentions: false,
			});
			return true;
		} catch (error) {
			this.#logger.warn(
				{ event: "parking.channel_failed", kind: event.kind, err: error },
				"couldn't post parking activity to the parking channel",
			);
			return false;
		}
	}
}
