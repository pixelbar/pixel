import type { APIEmbed } from "discord.js";
import type { SpaceStatusAnnouncement } from "../../core/announcement.ts";
import { formatDuration } from "../../core/format.ts";
import { accentColor } from "./render.ts";

/**
 * How space announcements look on Discord. Times use Discord's timestamp
 * markup, so every reader sees them in their own time zone.
 *
 * Two styles:
 * - **timeline**: a new post for every open and every close. Never edited.
 * - **live**: one post per opening, edited to "closed" when the space closes.
 */

/** What goes to Discord: only embeds, and never any mentions. */
export type AnnouncementPost = {
	embeds: APIEmbed[];
	allowedMentions: { parse: [] };
};

/** Title of a live post while the space is open. Together with the footer, it's how Pixel finds its own open posts again. */
export const LIVE_OPEN_TITLE = "🟢 Pixelbar is open";
export const LIVE_CLOSED_TITLE = "🔴 Pixelbar is closed";
/** Marks a post as a live-style post. `/status` replies also say "Pixelbar is open", but never have this. */
export const LIVE_OPEN_FOOTER = "This post updates when Pixelbar closes";

const stamp = (date: Date, style: "f" | "t" | "R"): string =>
	`<t:${Math.floor(date.getTime() / 1000)}:${style}>`;

const duration = (from: Date, to: Date): string => formatDuration(to.getTime() - from.getTime());

const post = (embed: APIEmbed): AnnouncementPost => ({
	embeds: [embed],
	allowedMentions: { parse: [] },
});

/** Timeline style: one post per change, e.g. "🔴 Pixelbar closed — was open for 3h 20m". */
export function timelinePost(announcement: SpaceStatusAnnouncement): AnnouncementPost {
	const { state, at, openedAt } = announcement;
	if (state === "open") {
		return post({
			title: "🟢 Pixelbar opened",
			description: stamp(at, "f"),
			color: accentColor("positive"),
			timestamp: at.toISOString(),
		});
	}
	return post({
		title: "🔴 Pixelbar closed",
		description: [stamp(at, "f"), openedAt && `Was open for ${duration(openedAt, at)}.`]
			.filter(Boolean)
			.join("\n"),
		color: accentColor("negative"),
		timestamp: at.toISOString(),
	});
}

/** Live style, when the space opens: a fresh post that will be edited when it closes. */
export function liveOpenPost(at: Date): AnnouncementPost {
	return post({
		title: LIVE_OPEN_TITLE,
		description: `Open since ${stamp(at, "t")} (${stamp(at, "R")})`,
		color: accentColor("positive"),
		timestamp: at.toISOString(),
		footer: { text: LIVE_OPEN_FOOTER },
	});
}

/**
 * Live style, when the space closes: what an open post turns into.
 * `closedAt` is null when Pixel didn't see the space close (it happened while
 * Pixel was down), so the end time is left out rather than guessed.
 */
export function liveClosedPost(openedAt: Date | null, closedAt: Date | null): AnnouncementPost {
	let description: string | undefined;
	if (openedAt && closedAt) {
		description = `Was open from ${stamp(openedAt, "f")} to ${stamp(closedAt, "t")} (${duration(openedAt, closedAt)}).`;
	} else if (openedAt) {
		description = `Was open from ${stamp(openedAt, "f")}. The closing time wasn't seen.`;
	} else if (closedAt) {
		description = `Closed ${stamp(closedAt, "f")}.`;
	}
	return post({
		title: LIVE_CLOSED_TITLE,
		...(description ? { description } : {}),
		color: accentColor("negative"),
		...(closedAt ? { timestamp: closedAt.toISOString() } : {}),
	});
}

/** Live style, when the space closes but there's no open post to update. */
export function liveStandaloneClosedPost(announcement: SpaceStatusAnnouncement): AnnouncementPost {
	const { at, openedAt } = announcement;
	const description = [
		`Closed ${stamp(at, "f")}.`,
		openedAt && `Was open for ${duration(openedAt, at)}.`,
	]
		.filter(Boolean)
		.join(" ");
	return post({
		title: LIVE_CLOSED_TITLE,
		description,
		color: accentColor("negative"),
		timestamp: at.toISOString(),
	});
}
