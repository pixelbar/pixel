import type { ClosingTimeAnnouncement, Publisher } from "../../core/announcement.ts";
import type { AnnouncementChannel } from "./announce-publishers.ts";
import type { AnnouncementPost } from "./announce-render.ts";
import { accentColor } from "./render.ts";

export const CLOSING_TIME_PUBLISHER_ID = "discord:closing-time";
export const CLOSING_TIME_TITLE = "Closing time";

/** Mentions stay off. The body is operator-authored markdown. */
export function closingTimePost(announcement: ClosingTimeAnnouncement): AnnouncementPost {
	return {
		embeds: [
			{
				title: CLOSING_TIME_TITLE,
				description: announcement.body.slice(0, 4096),
				color: accentColor("warning"),
				timestamp: announcement.at.toISOString(),
			},
		],
		allowedMentions: { parse: [] },
	};
}

export function createClosingTimePublisher(channel: AnnouncementChannel): Publisher {
	return {
		id: CLOSING_TIME_PUBLISHER_ID,
		async publish(announcement) {
			if (announcement.kind !== "closing.time") return;
			await channel.send(closingTimePost(announcement));
		},
	};
}
