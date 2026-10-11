import type { Announcement, AnnouncementKind } from "../../core/announcement.ts";

/** Mastodon's default character limit. Instances may allow more; 500 is safe everywhere. */
export const MASTODON_STATUS_LIMIT = 500;

export type TootVisibility = "public" | "unlisted";

export type Toot = {
	status: string;
	visibility: TootVisibility;
};

export type TootOptions = {
	kinds: ReadonlySet<AnnouncementKind>;
	visibility: TootVisibility;
	limit?: number;
};

/**
 * Maps a typed announcement to toot text. Uses the portable `text` field, never
 * Discord-specific formatting. Undefined means this publisher should stay quiet.
 *
 * Mentions are broken so a handle in operator-authored text cannot ping anyone.
 */
export function tootFromAnnouncement(
	announcement: Announcement,
	options: TootOptions,
): Toot | undefined {
	if (!options.kinds.has(announcement.kind)) return undefined;
	const status = clipToot(
		neutralizeMentions(announcement.text),
		options.limit ?? MASTODON_STATUS_LIMIT,
	);
	if (status.length === 0) return undefined;
	return { status, visibility: options.visibility };
}

/** Insert a zero-width space after `@` so Mastodon does not treat it as a mention. */
export function neutralizeMentions(text: string): string {
	return text.replace(/<@!?&?\d+>/g, "[mention]").replace(/@/g, "@\u200b");
}

/** Cut to `limit` code points, with an ellipsis when something was dropped. */
export function clipToot(text: string, limit: number): string {
	const chars = [...text];
	if (chars.length <= limit) return text;
	if (limit <= 1) return "…";
	return `${chars.slice(0, limit - 1).join("")}…`;
}
