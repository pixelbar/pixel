import type { Publisher } from "../../core/announcement.ts";
import type { Logger } from "../../core/logger.ts";
import type { AnnouncementChannel } from "./announce-publishers.ts";
import { releasePost } from "./announce-render.ts";

export const RELEASE_PUBLISHER_ID = "discord:release";

/**
 * Release announcements in a Discord channel: when a new Pixel version goes
 * live, post its changelog entries. Each version is a new post, never edited.
 */
export function createReleasePublisher(channel: AnnouncementChannel, logger: Logger): Publisher {
	const log = logger.child({ publisher: RELEASE_PUBLISHER_ID });

	return {
		id: RELEASE_PUBLISHER_ID,
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
