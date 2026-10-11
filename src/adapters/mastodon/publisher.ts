import type { AnnouncementKind, Publisher } from "../../core/announcement.ts";
import type { Logger } from "../../core/logger.ts";
import type { MastodonStatusClient } from "./client.ts";
import { type TootVisibility, tootFromAnnouncement } from "./toots.ts";

export const MASTODON_PUBLISHER_ID = "mastodon";

export type MastodonPublisherOptions = {
	client: MastodonStatusClient;
	kinds: ReadonlySet<AnnouncementKind>;
	visibility: TootVisibility;
	logger: Logger;
	/** Public handle, for logs only. Never used to post. */
	account?: string;
	/** Instance host, for logs only. */
	instanceHost?: string;
};

/**
 * Announcement publisher for Mastodon. Features never see this: they hand a
 * typed announcement to the Announcer, which calls every registered publisher.
 *
 * Timeline style: each routed announcement is a new toot. Reconcile is a no-op
 * (it must not post). A failure throws so the announcer can report it without
 * blocking Discord.
 */
export function createMastodonPublisher(options: MastodonPublisherOptions): Publisher {
	const log = options.logger.child({ publisher: MASTODON_PUBLISHER_ID });

	return {
		id: MASTODON_PUBLISHER_ID,

		async publish(announcement) {
			const toot = tootFromAnnouncement(announcement, {
				kinds: options.kinds,
				visibility: options.visibility,
			});
			if (!toot) return;
			await options.client.postStatus(toot);
			log.info(
				{
					event: "mastodon.posted",
					kind: announcement.kind,
					visibility: toot.visibility,
					host: options.instanceHost,
					account: options.account,
				},
				"tooted",
			);
		},

		async reconcile() {
			// Mastodon posts are a log, not a live card. Never post on startup.
		},
	};
}
