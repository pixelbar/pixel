import { ActivityType, type PresenceData } from "discord.js";
import type { Publisher } from "../../core/announcement.ts";

export const PRESENCE_PUBLISHER_ID = "discord:presence";

/** The one thing of the Discord client this needs: `client.user`. */
export type PresenceTarget = {
	setPresence(presence: PresenceData): unknown;
};

/**
 * What Pixel's own status shows under its name in the member list: whether
 * Pixelbar is open. Open is "online" (green), closed is "idle" (yellow), so the
 * dot says it at a glance and the line says it in words.
 */
export function presenceFor(state: "open" | "closed"): PresenceData {
	return {
		status: state === "open" ? "online" : "idle",
		activities: [{ type: ActivityType.Watching, name: `Pixelbar: ${state}` }],
	};
}

export type PresencePublisher = Publisher & {
	/**
	 * Re-sends the last presence after Discord starts a new gateway session.
	 * `setPresence` only updates the current session; a non-resumable reconnect
	 * IDENTIFYs without it, so the member list goes blank until the next change.
	 * Does nothing until a state has been set.
	 */
	reapply(): void;
};

/**
 * Keeps Pixel's presence in step with the space. It posts nothing: it is
 * told the state at startup (`reconcile`) and on each confirmed change
 * (`publish`), the same moments the announcement channels hear about it, so a
 * flicker of the switch never reaches it either. When Pixel goes offline, Discord
 * clears the presence by itself.
 */
export function createPresencePublisher(target: PresenceTarget): PresencePublisher {
	let last: PresenceData | undefined;
	const apply = (presence: PresenceData) => {
		last = presence;
		target.setPresence(presence);
	};
	return {
		id: PRESENCE_PUBLISHER_ID,
		async publish(announcement) {
			if (announcement.kind !== "space.status") return;
			apply(presenceFor(announcement.state));
		},
		async reconcile(snapshot) {
			apply(presenceFor(snapshot.state));
		},
		reapply() {
			if (last) target.setPresence(last);
		},
	};
}
