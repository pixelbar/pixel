import { actorLogFields } from "../../core/access.ts";
import { SPACE_ANNOUNCE_STYLES, type SpaceAnnounceStyle } from "../../core/announcement.ts";
import type { AnnouncementRoute, AnnouncementRoutes } from "../../core/announcement-routes.ts";
import type { SubcommandDefinition, SubgroupDefinition } from "../../core/command.ts";
import { UserFacingError } from "../../core/errors.ts";

/**
 * `/admin announcements`: where the open/closed announcements go. Each channel has
 * one style, and any number of channels can be set, for example a timeline in
 * #announcements and a live post in #general:
 *
 * - **live**: one post per opening, edited to "closed" when the space closes.
 * - **timeline**: a new post for every open and every close, never edited.
 * - **single**: only the latest status is kept: the new status is posted and the
 *   previous post is deleted.
 *
 * Admins only, private. This is the only way to set where they go: there is no
 * environment setting, and the choices are saved in `data/announcement-routes.yaml`.
 */

const STYLE_HELP: Record<SpaceAnnounceStyle, string> = {
	live: "one post per opening, edited to closed when the space closes",
	timeline: "a new post for every open and every close, never edited",
	single: "only the latest status: each change posts the new one and deletes the old",
};

// A channel ID is digits from the platform, so it is safe to embed; Discord shows it as a link.
const channelLink = (channelId: string): string => `<#${channelId}>`;

/** One line for `/admin announcements list`. */
export function describeRoute(route: AnnouncementRoute): string {
	const problem = route.problem ? ` ⚠️ not posting: ${route.problem}` : "";
	return `${channelLink(route.channelId)}: **${route.style}**${problem}`;
}

export function createAnnouncementsSubgroup(deps: {
	routes: Pick<AnnouncementRoutes, "list" | "set" | "remove">;
}): SubgroupDefinition {
	const channelOption = {
		name: "channel",
		description: "The channel",
		type: "channel" as const,
		required: true,
	};

	const set: SubcommandDefinition = {
		name: "set",
		description: "Post open/closed announcements in a channel, in a style",
		access: { minTier: "admin" },
		private: true,
		options: [
			{
				name: "style",
				description: "live (edited), timeline (a new post each time) or single (only the latest)",
				type: "string",
				choices: SPACE_ANNOUNCE_STYLES,
				required: true,
			},
			{ ...channelOption, description: "Where to announce" },
		],
		handler: async ({ args, channels, principal, logger }) => {
			const style = SPACE_ANNOUNCE_STYLES.find((s) => s === args.style);
			const channel = channels.channel;
			if (!style || !channel) throw new UserFacingError("Pick a style and a channel.");
			// The dispatcher already limits this to admins; this only stops announcing
			// somewhere the admin couldn't post themselves.
			if (!channel.caller.canPost) {
				throw new UserFacingError(
					"You can only set announcements in channels where you can post yourself.",
				);
			}
			const { result, previous, saved } = await deps.routes.set(style, channel.id);
			logger.info(
				{
					event: "announcements.set",
					style,
					channelId: channel.id,
					result,
					...actorLogFields(principal),
				},
				"set an announcement channel",
			);
			const link = channelLink(channel.id);
			const lines = [
				result === "unchanged"
					? `${link} already announces in the **${style}** style.`
					: result === "changed"
						? `${link} now uses the **${style}** style (it was **${previous}**).`
						: `Open/closed announcements will go to ${link} in the **${style}** style: ${STYLE_HELP[style]}.`,
				"The first post appears the next time the space opens or closes.",
			];
			if (result === "changed") {
				lines.push(
					"Posts the old style already made stay as they are; delete them by hand if you like.",
				);
			}
			if (!saved) {
				lines.push("⚠️ I couldn't save this, so it only holds until Pixel restarts. See the logs.");
			}
			return { text: lines.join("\n"), private: true };
		},
	};

	const remove: SubcommandDefinition = {
		name: "remove",
		description: "Stop announcing open/closed in a channel",
		access: { minTier: "admin" },
		private: true,
		options: [{ ...channelOption, description: "The channel to stop announcing in" }],
		handler: async ({ channels, principal, logger }) => {
			const channel = channels.channel;
			if (!channel) throw new UserFacingError("Pick a channel.");
			const { removed, previous, saved } = await deps.routes.remove(channel.id);
			const link = channelLink(channel.id);
			if (!removed) return { text: `${link} wasn't set up for announcements.`, private: true };
			logger.info(
				{
					event: "announcements.removed",
					style: previous,
					channelId: channel.id,
					...actorLogFields(principal),
				},
				"removed an announcement channel",
			);
			const lines = [
				`Stopped announcing in ${link}. Posts already there stay as they are; delete them by hand if you like.`,
			];
			if (!saved) {
				lines.push("⚠️ I couldn't save this, so it only holds until Pixel restarts. See the logs.");
			}
			return { text: lines.join("\n"), private: true };
		},
	};

	const list: SubcommandDefinition = {
		name: "list",
		description: "Where open/closed announcements go",
		access: { minTier: "admin" },
		private: true,
		handler: async () => {
			const routes = deps.routes.list();
			if (routes.length === 0) {
				return {
					text: "No channels get open/closed announcements. Set one with `/admin announcements set`.",
					private: true,
				};
			}
			return {
				text: [
					"Open/closed announcements go to:",
					...routes.map(describeRoute),
					"",
					...SPACE_ANNOUNCE_STYLES.map((s) => `**${s}**: ${STYLE_HELP[s]}`),
				].join("\n"),
				private: true,
			};
		},
	};

	return {
		name: "announcements",
		description: "Where open/closed announcements go (admins only)",
		access: { minTier: "admin" },
		subcommands: [set, remove, list],
	};
}
