import { type Client, PermissionFlagsBits } from "discord.js";
import type { ChannelCheck, ChannelPost, ChannelPoster } from "../../core/channel-posts.ts";
import { missingPermissions } from "./announce-channel.ts";

/**
 * Scheduled posts on Discord: a plain message, or a native Discord poll, which
 * Discord counts and closes itself (and announces the result). Pings only fire when
 * the schedule allows them.
 */

/** What a post needs from the bot in the channel. */
export function requiredPermissions(post: ChannelPost): bigint[] {
	const base = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];
	if (post.kind === "poll") return [...base, PermissionFlagsBits.SendPolls];
	return post.mentions ? [...base, PermissionFlagsBits.MentionEveryone] : base;
}

/** The message Discord is sent for a post (the API's shape). */
export function toDiscordMessage(post: ChannelPost) {
	if (post.kind === "message") {
		return {
			content: post.text,
			allowedMentions: post.mentions
				? { parse: ["everyone" as const, "roles" as const, "users" as const] }
				: { parse: [] },
		};
	}
	return {
		poll: {
			question: { text: post.question },
			answers: post.answers.map((text) => ({ text })),
			duration: post.durationHours,
			allowMultiselect: post.multiple,
		},
		allowedMentions: { parse: [] },
	};
}

export function createDiscordPoster(client: Client<true>, guildId: string): ChannelPoster {
	async function open(channelId: string, post: ChannelPost) {
		const channel = await client.channels.fetch(channelId).catch(() => null);
		if (!channel)
			return { ok: false as const, problem: "the channel doesn't exist or I can't see it" };
		if (channel.isDMBased() || !channel.isSendable() || !("guildId" in channel)) {
			return { ok: false as const, problem: "it isn't a server channel I can post in" };
		}
		if (channel.guildId !== guildId)
			return { ok: false as const, problem: "it's in a different server" };
		const me = await channel.guild.members.fetchMe();
		const missing = missingPermissions(channel.permissionsFor(me), requiredPermissions(post));
		if (missing.length > 0) {
			return {
				ok: false as const,
				problem: `I'm missing these permissions there: ${missing.join(", ")}`,
			};
		}
		return { ok: true as const, channel };
	}

	return {
		async check(channelId, post): Promise<ChannelCheck> {
			const opened = await open(channelId, post);
			return opened.ok
				? { ok: true, name: "name" in opened.channel ? String(opened.channel.name) : channelId }
				: opened;
		},
		async post(channelId, post) {
			const opened = await open(channelId, post);
			if (!opened.ok) throw new Error(`Can't post a scheduled post: ${opened.problem}`);
			await opened.channel.send(toDiscordMessage(post));
		},
	};
}
