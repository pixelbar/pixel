import { actorLogFields } from "../../core/access.ts";
import { SPACE_ANNOUNCE_STYLES, type SpaceAnnounceStyle } from "../../core/announcement.ts";
import type {
	AnnouncementRoute,
	AnnouncementRoutes,
	NotificationChannel,
	NotificationKind,
	ReleaseChannel,
} from "../../core/announcement-routes.ts";
import type { SubcommandDefinition, SubgroupDefinition } from "../../core/command.ts";
import { UserFacingError } from "../../core/errors.ts";

/**
 * `/admin` → Announcements: where open/closed and release announcements go. Each
 * channel has one open/closed style, and any number of channels can be set for
 * either kind, for example a timeline in #announcements, a live post in #general,
 * and release notes in #announcements:
 *
 * - **live**: one post per opening, edited to "closed" when the space closes.
 * - **timeline**: a new post for every open and every close, never edited.
 * - **single**: only the latest status is kept: the new status is posted and the
 *   previous post is deleted.
 * - **release**: when a new Pixel version goes live, that version's changelog.
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

/** One line for an open/closed route on `/admin` → Announcements. */
export function describeRoute(route: AnnouncementRoute): string {
	const problem = route.problem ? ` ⚠️ not posting: ${route.problem}` : "";
	return `${channelLink(route.channelId)}: **${route.style}**${problem}`;
}

/** One line for a release channel on `/admin` → Announcements. */
export function describeReleaseChannel(channel: ReleaseChannel): string {
	const problem = channel.problem ? ` ⚠️ not posting: ${channel.problem}` : "";
	return `${channelLink(channel.channelId)}: **release**${problem}`;
}

const NOTIFICATION_NAMES: Record<NotificationKind, string> = {
	bot: "bot status",
	closingTime: "closing time",
	parking: "parking activity",
	foodAlert: "food out-of-stock alerts",
};

/** One line for a notification channel on `/admin` → Announcements. */
export function describeNotificationChannel(channel: NotificationChannel): string {
	const name = NOTIFICATION_NAMES[channel.kind];
	if (!channel.channelId) return `**${name}**: not set`;
	const problem = channel.problem ? ` ⚠️ not posting: ${channel.problem}` : "";
	return `**${name}**: ${channelLink(channel.channelId)}${problem}`;
}

export function createAnnouncementsSubgroup(deps: {
	routes: Pick<
		AnnouncementRoutes,
		| "list"
		| "set"
		| "remove"
		| "listRelease"
		| "addRelease"
		| "removeRelease"
		| "listNotifications"
		| "setNotification"
	>;
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

	const setRelease: SubcommandDefinition = {
		name: "set-release",
		description: "Post Pixel release changelogs in a channel",
		access: { minTier: "admin" },
		private: true,
		options: [{ ...channelOption, description: "Where to post release notes" }],
		handler: async ({ channels, principal, logger }) => {
			const channel = channels.channel;
			if (!channel) throw new UserFacingError("Pick a channel.");
			if (!channel.caller.canPost) {
				throw new UserFacingError(
					"You can only set announcements in channels where you can post yourself.",
				);
			}
			const { result, saved } = await deps.routes.addRelease(channel.id);
			logger.info(
				{
					event: "announcements.release_set",
					channelId: channel.id,
					result,
					...actorLogFields(principal),
				},
				"set a release channel",
			);
			const link = channelLink(channel.id);
			const lines = [
				result === "unchanged"
					? `${link} already gets Pixel release notes.`
					: `Pixel release notes will go to ${link}. The next new version posts there once.`,
			];
			if (!saved) {
				lines.push("⚠️ I couldn't save this, so it only holds until Pixel restarts. See the logs.");
			}
			return { text: lines.join("\n"), private: true };
		},
	};

	const removeRelease: SubcommandDefinition = {
		name: "remove-release",
		description: "Stop posting Pixel release changelogs in a channel",
		access: { minTier: "admin" },
		private: true,
		options: [{ ...channelOption, description: "The channel to stop posting releases in" }],
		handler: async ({ channels, principal, logger }) => {
			const channel = channels.channel;
			if (!channel) throw new UserFacingError("Pick a channel.");
			const { removed, saved } = await deps.routes.removeRelease(channel.id);
			const link = channelLink(channel.id);
			if (!removed) {
				return { text: `${link} wasn't set up for release announcements.`, private: true };
			}
			logger.info(
				{
					event: "announcements.release_removed",
					channelId: channel.id,
					...actorLogFields(principal),
				},
				"removed a release channel",
			);
			const lines = [
				`Stopped posting release notes in ${link}. Posts already there stay as they are; delete them by hand if you like.`,
			];
			if (!saved) {
				lines.push("⚠️ I couldn't save this, so it only holds until Pixel restarts. See the logs.");
			}
			return { text: lines.join("\n"), private: true };
		},
	};

	const setNotification: SubcommandDefinition = {
		name: "set-notification",
		description: "Set a notification channel (bot, closing time, parking, food alerts)",
		access: { minTier: "admin" },
		private: true,
		options: [
			{
				name: "type",
				description: "Which notification to configure",
				type: "string",
				choices: ["bot", "closingTime", "parking", "foodAlert"] as NotificationKind[],
				required: true,
			},
			{ ...channelOption, description: "The channel to post to", required: false },
		],
		handler: async ({ args, channels, principal, logger }) => {
			const type = args.type as NotificationKind;
			const channel = channels.channel;
			// If no channel provided, clear the setting
			if (!channel) {
				const { result, previous, saved } = await deps.routes.setNotification(type, undefined);
				logger.info(
					{
						event: "announcements.notification_cleared",
						type,
						previous,
						...actorLogFields(principal),
					},
					"cleared a notification channel",
				);
				const name = NOTIFICATION_NAMES[type];
				const lines = [`Cleared the **${name}** channel.`];
				if (previous) lines.push(`It was ${channelLink(previous)}.`);
				if (!saved) {
					lines.push("⚠️ I couldn't save this, so it only holds until Pixel restarts. See the logs.");
				}
				return { text: lines.join("\n"), private: true };
			}
			// Setting a channel
			if (!channel.caller.canPost) {
				throw new UserFacingError(
					"You can only set notifications in channels where you can post yourself.",
				);
			}
			const { result, previous, saved } = await deps.routes.setNotification(type, channel.id);
			logger.info(
				{
					event: "announcements.notification_set",
					type,
					channelId: channel.id,
					result,
					...actorLogFields(principal),
				},
				"set a notification channel",
			);
			const link = channelLink(channel.id);
			const name = NOTIFICATION_NAMES[type];
			const lines = [
				result === "unchanged"
					? `${link} is already set for **${name}**.`
					: `**${name}** will go to ${link}.`,
			];
			if (!saved) {
				lines.push("⚠️ I couldn't save this, so it only holds until Pixel restarts. See the logs.");
			}
			return { text: lines.join("\n"), private: true };
		},
	};

	const list: SubcommandDefinition = {
		name: "list",
		description: "Where open/closed, release and notification announcements go",
		access: { minTier: "admin" },
		private: true,
		handler: async () => {
			const routes = deps.routes.list();
			const release = deps.routes.listRelease();
			const notifications = deps.routes.listNotifications();
			const lines: string[] = [];
			if (routes.length > 0) {
				lines.push("**Open/closed announcements:**", ...routes.map(describeRoute), "");
			} else {
				lines.push("**Open/closed announcements:** not set", "");
			}
			if (release.length > 0) {
				lines.push("**Release notes:**", ...release.map(describeReleaseChannel), "");
			} else {
				lines.push("**Release notes:** not set", "");
			}
			lines.push("**Notification channels:**", ...notifications.map(describeNotificationChannel), "");
			lines.push("**Styles:**");
			lines.push(...SPACE_ANNOUNCE_STYLES.map((s) => `• **${s}**: ${STYLE_HELP[s]}`));
			lines.push(
				"• **release**: when a new Pixel version goes live, that version's changelog (once per version)",
			);
			return { text: lines.join("\n"), private: true };
		},
	};

	return {
		name: "announcements",
		description: "Where open/closed, release and notification announcements go (admins only)",
		access: { minTier: "admin" },
		subcommands: [set, remove, setRelease, removeRelease, setNotification, list],
	};
}
