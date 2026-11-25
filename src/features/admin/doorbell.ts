import { actorLogFields, actorRef } from "../../core/access.ts";
import type { ChannelPosts } from "../../core/channel-posts.ts";
import type { SubcommandDefinition, SubgroupDefinition } from "../../core/command.ts";
import { UserFacingError } from "../../core/errors.ts";
import type { DoorbellSettings } from "../../services/doorbell-settings.ts";

/**
 * `/admin` → Doorbell: where Pixel posts the doorbell, with its Answer button. One channel,
 * set or cleared here and saved in `data/doorbell.yaml`; there is no environment setting.
 * Unset means the doorbell isn't posted. Admins only, private, logged.
 */

export type DoorbellAdminDeps = {
	settings: Pick<DoorbellSettings, "channelId" | "problem" | "set">;
	posts: Pick<ChannelPosts, "check">;
	/** Whether pixel-phone is configured here. */
	configured: boolean;
};

// A channel ID is digits from the platform, so it is safe to embed; Discord shows it as a link.
const channelLink = (channelId: string): string => `<#${channelId}>`;

/** What `/admin` → Doorbell says about the doorbell here. */
export function describeDoorbell(deps: DoorbellAdminDeps): string {
	if (!deps.configured) {
		return "The doorbell isn't connected here (`PIXEL_PHONE_QUEUE_URL`, `PIXEL_PHONE_URL` and `PIXEL_PHONE_API_KEY`).";
	}
	const lines = [
		deps.settings.channelId
			? `The doorbell is posted in ${channelLink(deps.settings.channelId)}.`
			: "No channel is set, so the doorbell isn't posted.",
	];
	if (deps.settings.problem) lines.push(`⚠️ ${deps.settings.problem}.`);
	return lines.join("\n");
}

export function createDoorbellSubgroup(deps: DoorbellAdminDeps): SubgroupDefinition {
	const unsaved = "⚠️ I couldn't save this, so it only holds until Pixel restarts. See the logs.";

	const set: SubcommandDefinition = {
		name: "set",
		description: "Post the doorbell in a channel",
		access: { minTier: "admin" },
		private: true,
		options: [{ name: "channel", description: "Where", type: "channel", required: true }],
		handler: async ({ channels, principal, logger }) => {
			const channel = channels.channel;
			if (!channel) throw new UserFacingError("Pick a channel.");
			// The dispatcher already limits this to admins; this only stops posting somewhere
			// the admin couldn't post themselves.
			if (!channel.caller.canPost) {
				throw new UserFacingError("You can only pick a channel where you can post yourself.");
			}
			const check = await deps.posts.check(channel.id, {
				kind: "message",
				text: ".",
			});
			if (!check.ok)
				throw new UserFacingError(`I can't post the doorbell there: ${check.problem}.`);
			const { changed, saved } = deps.settings.set(channel.id, actorRef(principal));
			logger.info(
				{
					event: "doorbell.channel_set",
					channelId: channel.id,
					changed,
					...actorLogFields(principal),
				},
				"set the doorbell channel",
			);
			const lines = [
				changed
					? `The doorbell will be posted in ${channelLink(channel.id)}, with an **Answer** button.`
					: `The doorbell is already posted in ${channelLink(channel.id)}.`,
				"Only friends and members holding `doorbell` can answer it: grant it to a level with `/admin` → Capabilities.",
			];
			if (!saved) lines.push(unsaved);
			return { text: lines.join("\n"), private: true };
		},
	};

	const clear: SubcommandDefinition = {
		name: "clear",
		description: "Stop posting the doorbell",
		access: { minTier: "admin" },
		private: true,
		handler: async ({ principal, logger }) => {
			const { changed, saved } = deps.settings.set(undefined, actorRef(principal));
			logger.info(
				{ event: "doorbell.channel_cleared", changed, ...actorLogFields(principal) },
				"stopped posting the doorbell",
			);
			const lines = [
				changed
					? "The doorbell isn't posted any more. The button in the space still works."
					: "The doorbell wasn't being posted.",
			];
			if (!saved) lines.push(unsaved);
			return { text: lines.join("\n"), private: true };
		},
	};

	return {
		name: "doorbell",
		description: "Where the doorbell is posted (admins only)",
		access: { minTier: "admin" },
		subcommands: [set, clear],
	};
}
