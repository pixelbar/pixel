import type { AnnouncementKind } from "../../core/announcement.ts";
import type { Announcer } from "../../core/announcer.ts";
import type { Logger } from "../../core/logger.ts";
import { MastodonClient } from "./client.ts";
import { createMastodonPublisher } from "./publisher.ts";
import type { TootVisibility } from "./toots.ts";

export { MastodonClient, MastodonError, type MastodonStatusClient } from "./client.ts";
export { createMastodonPublisher, MASTODON_PUBLISHER_ID } from "./publisher.ts";
export { tootFromAnnouncement } from "./toots.ts";

export type MastodonSetup = {
	instanceUrl: string;
	token: string;
	account: string | undefined;
	visibility: TootVisibility;
	kinds: readonly AnnouncementKind[];
};

/**
 * Registers the Mastodon publisher when instance and token are set and at least
 * one kind is routed. Missing or empty config leaves it off; Discord is unchanged.
 */
export function startMastodonPublisher(deps: {
	mastodon: MastodonSetup | undefined;
	announcer: Pick<Announcer, "register">;
	logger: Logger;
	fetch?: typeof globalThis.fetch;
}): void {
	const log = deps.logger.child({ adapter: "mastodon" });
	if (!deps.mastodon || deps.mastodon.kinds.length === 0) {
		log.info({ event: "mastodon.unconfigured" }, "Mastodon isn't configured");
		return;
	}

	const { instanceUrl, token, account, visibility, kinds } = deps.mastodon;
	const instanceHost = new URL(instanceUrl).host;
	deps.announcer.register(
		createMastodonPublisher({
			client: new MastodonClient({ instanceUrl, token, fetch: deps.fetch }),
			kinds: new Set(kinds),
			visibility,
			account,
			instanceHost,
			logger: log,
		}),
	);
}
