import type { Feature } from "../../core/feature.ts";
import { formatDuration } from "../../core/format.ts";
import type { Embed, Reply } from "../../core/reply.ts";
import type { SpaceReading } from "../../services/space-status.ts";
import { type SpaceAnnouncementsDeps, startSpaceAnnouncements } from "./announce.ts";

export type StatusDeps = SpaceAnnouncementsDeps & {
	now?: () => Date;
};

/**
 * `/status`: is Pixelbar open right now? Looked up live from SpaceAPI.
 * Also announces when the space opens or closes (see `announce.ts`).
 */
export function createStatusFeature(deps: StatusDeps): Feature {
	const now = deps.now ?? (() => new Date());
	return {
		name: "status",
		start: () => startSpaceAnnouncements(deps),
		commands: [
			{
				name: "status",
				description: "Is Pixelbar open right now?",
				access: { minTier: "guest" },
				placeholder: {
					embeds: [
						{
							title: "Checking…",
							description: "Asking SpaceAPI whether Pixelbar is open.",
							accent: "neutral",
						},
					],
				},
				handler: async (): Promise<Reply> => {
					let reading: SpaceReading;
					try {
						reading = await deps.spaceStatus.checkNow();
					} catch {
						return { embeds: [unreachable()] };
					}
					return { embeds: [describe(reading, now())] };
				},
			},
		],
	};
}

function describe(reading: SpaceReading, now: Date): Embed {
	const since = reading.since
		? `for ${formatDuration(now.getTime() - reading.since.getTime())}`
		: undefined;
	switch (reading.state) {
		case "open":
			return {
				title: "🟢 Pixelbar is open",
				...(since ? { description: `Open ${since}.` } : {}),
				accent: "positive",
			};
		case "closed":
			return {
				title: "🔴 Pixelbar is closed",
				...(since ? { description: `Closed ${since}.` } : {}),
				accent: "negative",
			};
		case "unknown":
			return {
				title: "❔ Pixelbar's status is unknown",
				description: "SpaceAPI doesn't know right now.",
				accent: "neutral",
			};
	}
}

function unreachable(): Embed {
	return {
		title: "⚠️ Couldn't check",
		description: "SpaceAPI isn't responding right now. Try again in a bit.",
		accent: "warning",
	};
}
