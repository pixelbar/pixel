import type { Publisher } from "../../core/announcement.ts";
import type { Logger } from "../../core/logger.ts";
import type { AnnouncementChannel } from "./announce-publishers.ts";
import { releasePost } from "./announce-render.ts";

/** Id for a release channel publisher, such as `discord:release:123…`. */
export const releasePublisherId = (channelId: string): string => `discord:release:${channelId}`;

/**
 * Release announcements in a Discord channel: when a new Pixel version goes
 * live, post its changelog entries. Each version is a new post, never edited.
 * `id` defaults to a single fixed publisher when only one channel is wired
 * (tests); admin-set channels pass `discord:release:<channel id>`.
 */
export function createReleasePublisher(
	channel: AnnouncementChannel,
	logger: Logger,
	id = "discord:release",
): Publisher {
	const log = logger.child({ publisher: id });

	return {
		id,
		async publish(announcement) {
			if (announcement.kind !== "release") return;
			try {
				await channel.send(releasePost(announcement));
				log.info(
					{ event: "announcer.release", version: announcement.version },
					"posted release announcement",
				);
			} catch (error) {
				log.error(
					{ event: "announcer.release_failed", version: announcement.version, err: error },
					"couldn't post release announcement",
				);
				throw error;
			}
		},
	};
}
