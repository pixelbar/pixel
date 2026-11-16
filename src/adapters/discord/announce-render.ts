import type { APIEmbed } from "discord.js";
import type { ReleaseAnnouncement, SpaceStatusAnnouncement } from "../../core/announcement.ts";
import { formatDuration, inlineCode } from "../../core/format.ts";
import { accentColor } from "./render.ts";

/**
 * How space announcements look on Discord. Times use Discord's timestamp
 * markup, so every reader sees them in their own time zone.
 *
 * Three styles:
 * - **timeline**: a new post for every open and every close. Never edited.
 * - **live**: one post per opening, edited to "closed" when the space closes.
 * - **single**: one post showing the current status; each change posts the new
 *   status and the previous post is deleted.
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

/** Marks a post as a single-style post, which is how Pixel finds the one to replace. */
export const SINGLE_FOOTER = "Only the latest status is kept here";

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

/**
 * Single style: the current status. `at` is when this state began (null when
 * Pixel doesn't know, e.g. when correcting a post at startup), `openedAt` is for
 * "closed": when the stretch of being open began.
 */
export function singlePost(
	state: "open" | "closed",
	at: Date | null,
	openedAt: Date | null,
): AnnouncementPost {
	if (state === "open") {
		return post({
			title: LIVE_OPEN_TITLE,
			...(at ? { description: `Open since ${stamp(at, "t")} (${stamp(at, "R")})` } : {}),
			color: accentColor("positive"),
			...(at ? { timestamp: at.toISOString() } : {}),
			footer: { text: SINGLE_FOOTER },
		});
	}
	const description = at
		? [`Closed ${stamp(at, "f")}.`, openedAt && `Was open for ${duration(openedAt, at)}.`]
				.filter(Boolean)
				.join(" ")
		: undefined;
	return post({
		title: LIVE_CLOSED_TITLE,
		...(description ? { description } : {}),
		color: accentColor("negative"),
		...(at ? { timestamp: at.toISOString() } : {}),
		footer: { text: SINGLE_FOOTER },
	});
}

const EMBED_DESCRIPTION_LIMIT = 4096;
const CHANGELOG_ENTRY_LIMIT = 3500;
const REPO_URL = "https://github.com/pixelbar/pixel";

/**
 * Release announcement: new Pixel version with its changelog. If the notes are too
 * long for a Discord embed, they're trimmed and a link to the full GitHub Release is shown.
 */
export function releasePost(announcement: ReleaseAnnouncement): AnnouncementPost {
	const { version, notes, build, at } = announcement;
	const releaseUrl = `${REPO_URL}/releases/tag/v${version}`;

	let description = notes;
	let trimmed = false;

	if (notes.length > CHANGELOG_ENTRY_LIMIT) {
		description = `${notes.slice(0, CHANGELOG_ENTRY_LIMIT).trim()}…\n\n**[Read the full changelog →](${releaseUrl})**`;
		trimmed = true;
	}

	if (description.length > EMBED_DESCRIPTION_LIMIT) {
		description = `${description.slice(0, EMBED_DESCRIPTION_LIMIT - 3)}…`;
	}

	return post({
		title: `📣 Pixel ${version} is now live`,
		description: trimmed ? description : `${description}\n\n[GitHub Release](${releaseUrl})`,
		color: accentColor("positive"),
		timestamp: at.toISOString(),
		fields: [
			{ name: "Version", value: inlineCode(version, 40), inline: true },
			...(build.commit
				? [{ name: "Commit", value: inlineCode(build.commit, 40), inline: true }]
				: []),
		],
	});
}
